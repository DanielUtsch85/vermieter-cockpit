#!/usr/bin/env bash
# Realm isolation of the MRE services through Caddy and the MRE gateway, with curl (issue #398; Auftrag des
# Projektinhabers, 2026-11-18: „Regressionstests über Caddy und Gateway mit zwei Beständen, Vermieter- und
# Mietersitzungen sowie positiven Kontrollfällen ergänzen. Pro Fix nachweisen: Angriff vor der Änderung erfolgreich,
# danach abgewiesen; berechtigte Nutzung funktioniert weiterhin.“). curl only, no browser.
#
# Two synthetic landlord accounts A and B, each the administrator of its own Realm with a lease, a property and a tenant
# (created through Caddy with the MRE API), plus the tenant session the authenticator issues after an OTP sign-in. Each
# attack below succeeds on the plain pinned images (MRE 479d0ad) and is refused with the overlays of deploy/mre-*:
#
#   P  Proxy (deploy/caddy/Caddyfile): the tenant endpoints nothing in this stack uses answer 404 at Caddy, whatever the
#      case or slashes: /tenantapi, /tenantapi/*, /api/v2/authenticator/tenant, /api/v2/authenticator/tenant/*.
#   F1 pdfgenerator, tenant session (sessionToken cookie, no Realm): GET/POST /api/v2/templates, GET /api/v2/documents
#      and DELETE /api/v2/documents/<id> with `organizationid: <Realm B>` are refused; B's templates, documents and
#      files stay as they were. Control: A and B list and create their own templates.
#   F2 tenantapi, reached at the gateway itself (127.0.0.1:8080, Caddy blocks it, see P): the e-mail is compared exactly
#      (case-insensitive), not as a regular expression; a landlord account that gives itself the role tenant in its own
#      Realm sees only that Realm, even with exactly the address of tenant A's contact. Control: the tenant session of
#      tenant A's contact (other case) sees tenant A only.
#   F3 api: PATCH of a property, a lease and a tenant of Realm A with `realmId: <Realm B>` in the body (plain and as
#      `$set`) leaves the record in Realm A. Control: the plain PATCH changes the name (the one with `$set` is refused
#      with 422 and changes nothing).
#   F4 pdfgenerator, uploads: a document of Realm A whose url points at a file in Realm B's upload folder is refused on
#      create, and one already stored (written straight into MongoDB) neither reads nor deletes B's file. Control: B
#      uploads, reads and A uploads, reads, deletes its own file.
#
# The PDF route of #396 keeps its own gate (compose-pdf-realm-gate.sh). This gate runs in compose-smoke after it, against
# the same stack (docker-compose.yml plus docker-compose.proxy.yml with sign-up open; the cockpit gate closes it again).
# The tenant session is minted inside the pdfgenerator container with its own ACCESS_TOKEN_SECRET, exactly as the
# authenticator signs it (no e-mail in this stack); the secret never leaves the container. Every request to Caddy goes
# over HTTPS to 127.0.0.1:443 under the cockpit hostname, verified against Caddy's local CA (no --insecure). Needs
# docker, curl, jq and openssl. Synthetic data only (sec-*@example.com).
set -euo pipefail

host=${COCKPIT_HOSTNAME:-cockpit.internal}
base="https://$host"
gateway=http://127.0.0.1:8080
files=(-f docker-compose.yml -f docker-compose.proxy.yml ${SECURITY_GATE_EXTRA_COMPOSE:+-f "$SECURITY_GATE_EXTRA_COMPOSE"})
work=$(mktemp -d)
started=
failures=0

fail() {
  echo "MRE SECURITY GATE FAILED: $*" >&2
  exit 1
}
# A refused attack that went through: noted, the gate goes on, so one run lists every open finding.
breach() {
  echo "BREACH: $*" >&2
  failures=$((failures + 1))
}
on_exit() {
  local status=$?
  if [ "$status" != 0 ] && [ -n "$started" ]; then
    echo "--- logs of api, tenantapi, pdfgenerator and gateway (last 40 lines each) ---" >&2
    docker compose "${files[@]}" logs --no-color --tail=40 api tenantapi pdfgenerator gateway >&2 || true
  fi
  rm -rf "$work"
}
trap on_exit EXIT

started=yes
MRE_SIGNUP=true docker compose "${files[@]}" up -d --wait --wait-timeout 300

ca="$work/caddy-root.crt"
for _ in $(seq 1 30); do
  if docker compose "${files[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$ca" 2>/dev/null &&
    openssl x509 -in "$ca" -noout 2>/dev/null; then
    break
  fi
  sleep 1
done
openssl x509 -in "$ca" -noout 2>/dev/null || fail "no root certificate of Caddy's local CA after 30 s"

# One request through Caddy (path relative to $base) or, with an absolute http URL, to the gateway itself; sets $code,
# leaves the body in $work/b.
req() {
  local args=()
  [ "${1:-}" = --raw ] && { args+=(--path-as-is); shift; }
  code=$(curl -sS -m 120 --noproxy '*' --cacert "$ca" --resolve "$host:443:127.0.0.1" "${args[@]}" \
    -o "$work/b" -w '%{http_code}' "$@") || fail "curl could not reach the stack: $*"
}
body() { head -c 300 "$work/b" | tr -c '[:print:]' '.'; }

run="$(date +%s)-$$"
password="Sec-$run-password"
json=(-H 'content-type: application/json')
signin() { # email: sets $tok to a fresh access token (MRE access tokens live 30 s)
  req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signin" -d "{\"email\":\"$1\",\"password\":\"$password\"}"
  [ "$code" = 200 ] || fail "sign-in $1: HTTP $code"
  tok=$(jq -r '.accessToken // empty' "$work/b")
  [ -n "$tok" ] || fail "sign-in $1: no accessToken"
}
as() { # email realm method path [curl args…]: one MRE request through Caddy as that landlord
  local email=$1 realm=$2 method=$3 path=$4
  shift 4
  signin "$email"
  req -X "$method" -H "authorization: Bearer $tok" ${realm:+-H "organizationid: $realm"} "$@" "$base$path"
}
mre() { # email realm method path body: sets $id to the _id of the JSON answer; fails unless 200 with an ObjectId
  as "$1" "$2" "$3" "/api/v2$4" "${json[@]}" -d "$5"
  [ "$code" = 200 ] || fail "$3 $4 as $1: HTTP $code; body: $(body)"
  id=$(jq -r '._id // empty' "$work/b")
  [[ "$id" =~ ^[0-9a-f]{24}$ ]] || fail "$3 $4 as $1: no _id in the answer"
}
signup() { # email
  req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signup" \
    -d "$(jq -cn --arg e "$1" --arg p "$password" '{firstname:"Sec",lastname:"Gate",email:$e,password:$p}')"
  [ "$code" = 201 ] || fail "sign-up $1: HTTP $code; body: $(body)"
}
session() { # email: a tenant session token as the authenticator issues it after the OTP sign-in
  docker compose "${files[@]}" exec -T -e "SEC_EMAIL=$1" pdfgenerator node -e \
    "process.stdout.write(require('jsonwebtoken').sign({ account: { email: process.env.SEC_EMAIL, role: 'tenant' } }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '5m' }))"
}

# Account, Realm, lease, property and tenant; sets email_<l>, realm_<l>, lease_<l>, property_<l>, tenant_<l>.
seed() { # letter
  local email="sec-$1-$run@example.com"
  signup "$email"
  # thirdParties.b2 without keys (no S3): the pinned upload and delete routes read req.realm.thirdParties.b2 and answer
  # 500 for a Realm without thirdParties (as the landlord UI never creates one).
  mre "$email" '' POST /realms "{\"name\":\"Sec $1 $run\",\"currency\":\"EUR\",\"locale\":\"de-DE\",
    \"thirdParties\":{\"b2\":{\"bucket\":\"none\"}},
    \"members\":[{\"name\":\"Admin\",\"email\":\"$email\",\"role\":\"administrator\",\"registered\":true}]}"
  printf -v "realm_$1" %s "$id"
  local realm=$id
  mre "$email" "$realm" POST /leases '{"name":"Wohnraum","numberOfTerms":12,"timeRange":"months","active":true}'
  printf -v "lease_$1" %s "$id"
  local lease=$id
  mre "$email" "$realm" POST /properties "{\"type\":\"apartment\",\"name\":\"Wohnung $1\",\"price\":500}"
  printf -v "property_$1" %s "$id"
  # With rents: the pinned tenantapi answers 500 for a tenant without any.
  mre "$email" "$realm" POST /tenants "{\"name\":\"Mieter $1 $run\",\"isCompany\":false,\"leaseId\":\"$lease\",
    \"beginDate\":\"01/01/2026\",\"endDate\":\"31/12/2026\",\"frequency\":\"months\",
    \"contacts\":[{\"contact\":\"Mieter $1\",\"email\":\"mieter-$1-$run@example.com\"}],
    \"properties\":[{\"propertyId\":\"$id\",\"rent\":500,\"entryDate\":\"01/01/2026\",\"exitDate\":\"31/12/2026\"}]}"
  printf -v "tenant_$1" %s "$id"
  printf -v "email_$1" %s "$email"
}
seed a
seed b
echo "Realm A $realm_a (tenant $tenant_a), Realm B $realm_b (tenant $tenant_b)"

#############################################################################
# P: the unused tenant endpoints answer 404 at Caddy
#############################################################################
for path in /tenantapi /tenantapi/ /tenantapi/tenants /TenantAPI/tenants //tenantapi/tenants /tenantapi/tenant/x \
  /api/v2/authenticator/tenant /api/v2/authenticator/tenant/signin /api/v2/authenticator/TENANT/signin \
  /api/v2//authenticator/tenant/signin /api/v2/authenticator/tenant/refreshtoken; do
  req --raw -X POST "${json[@]}" -d '{"email":"nobody@example.com"}' "$base$path"
  echo "P  POST $path: HTTP $code"
  [ "$code" = 404 ] || breach "P: $path answers $code at Caddy, not 404"
  req --raw "$base$path"
  [ "$code" = 404 ] || breach "P: GET $path answers $code at Caddy, not 404"
done
req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signin" -d "{\"email\":\"$email_a\",\"password\":\"$password\"}"
[ "$code" = 200 ] || fail "P control: landlord sign-in through Caddy answers $code"
echo "P  control: landlord sign-in through Caddy 200"

#############################################################################
# F1: pdfgenerator, tenant session against Realm B's templates and documents
#############################################################################
template="{\"name\":\"Vorlage B $run\",\"type\":\"text\",\"contents\":\"{}\",\"html\":\"<p>B</p>\",\"linkedResourceIds\":[]}"
as "$email_b" "$realm_b" POST /api/v2/templates "${json[@]}" -d "$template"
[ "$code" = 201 ] || fail "F1 control: B creates a template: HTTP $code; body: $(body)"
as "$email_a" "$realm_a" POST /api/v2/templates "${json[@]}" -d "${template//Vorlage B/Vorlage A}"
[ "$code" = 201 ] || fail "F1 control: A creates a template: HTTP $code; body: $(body)"
templates_of() { # email realm: the template names of that Realm, sorted, one per line
  as "$1" "$2" GET /api/v2/templates
  [ "$code" = 200 ] || fail "F1 control: templates of $2: HTTP $code"
  jq -r '.[].name' "$work/b" | sort
}
b_templates=$(templates_of "$email_b" "$realm_b")
grep -qx "Vorlage B $run" <<<"$b_templates" || fail "F1 control: B does not see its template"
! grep -q "Vorlage A $run" <<<"$b_templates" || fail "F1 control: B sees A's template"
echo "F1 control: A and B create and list their own templates"

tenant_session=$(session "mieter-a-$run@example.com")
[ -n "$tenant_session" ] || fail "no tenant session token"
cookie=(-H "cookie: sessionToken=$tenant_session" -H "organizationid: $realm_b")
# Refused means 404 (no authorized Realm, as for a Realm one is no member of) or 403 (role tenant), not a 500 of a route
# that ran without a Realm.
req "${cookie[@]}" "$base/api/v2/templates"
echo "F1 tenant session GET /api/v2/templates of Realm B: HTTP $code"
if [ "$code" = 200 ] || grep -aq "Vorlage B $run" "$work/b"; then breach "F1: tenant session reads Realm B's templates"; fi
[ "$code" = 200 ] || [ "$code" = 404 ] || [ "$code" = 403 ] || breach "F1: tenant session GET /api/v2/templates answers $code, not 404 or 403"
req -X POST "${cookie[@]}" "${json[@]}" -d "${template//Vorlage B/Fremd}" "$base/api/v2/templates"
echo "F1 tenant session POST /api/v2/templates into Realm B: HTTP $code"
[ "$code" != 201 ] || breach "F1: tenant session creates a template in Realm B"
[ "$code" = 201 ] || [ "$code" = 404 ] || [ "$code" = 403 ] || breach "F1: tenant session POST /api/v2/templates answers $code, not 404 or 403"
templates_of "$email_b" "$realm_b" | grep -q "Fremd" && breach "F1: Realm B lists the tenant session's template"
req "${cookie[@]}" "$base/api/v2/documents"
echo "F1 tenant session GET /api/v2/documents of Realm B: HTTP $code"
[ "$code" != 200 ] || breach "F1: tenant session lists Realm B's documents"
[ "$code" = 200 ] || [ "$code" = 404 ] || [ "$code" = 403 ] || breach "F1: tenant session GET /api/v2/documents answers $code, not 404 or 403"

#############################################################################
# F4 (with the files F1 deletes): uploads and the document url
#############################################################################
upload() { # email realm letter: uploads a synthetic PDF; sets $key
  printf '%%PDF-1.4\n%% sec-gate %s %s\n%%%%EOF\n' "$3" "$run" >"$work/up.pdf"
  as "$1" "$2" POST /api/v2/documents/upload -F folder=sec -F "fileName=beleg-$3" -F "file=@$work/up.pdf;type=application/pdf"
  [ "$code" = 201 ] || fail "F4 control: upload of $3: HTTP $code; body: $(body)"
  key=$(jq -r '.key // empty' "$work/b")
  [ -n "$key" ] || fail "F4 control: upload of $3: no key"
}
file_doc() { # email realm tenant lease url name: POST /documents of type file; sets $code and $doc
  as "$1" "$2" POST /api/v2/documents "${json[@]}" -d "$(jq -cn --arg t "$3" --arg l "$4" --arg u "$5" --arg n "$6" \
    '{type:"file",tenantId:$t,leaseId:$l,url:$u,name:$n,mimeType:"application/pdf"}')"
  doc=$(jq -r '._id // empty' "$work/b" 2>/dev/null || true)
}
reads_b() { grep -aq "sec-gate b $run" "$work/b"; }

upload "$email_b" "$realm_b" b
key_b=$key
file_doc "$email_b" "$realm_b" "$tenant_b" "$lease_b" "$key_b" "Beleg B"
[ "$code" = 201 ] || fail "F4 control: B creates its file document: HTTP $code; body: $(body)"
doc_b=$doc
as "$email_b" "$realm_b" GET "/api/v2/documents/$doc_b"
{ [ "$code" = 200 ] && reads_b; } || fail "F4 control: B cannot read its own file (HTTP $code)"
echo "F4 control: B uploads, creates and reads its file ($key_b)"
upload "$email_a" "$realm_a" a
file_doc "$email_a" "$realm_a" "$tenant_a" "$lease_a" "$key" "Beleg A"
[ "$code" = 201 ] || fail "F4 control: A creates its file document: HTTP $code; body: $(body)"
doc_a=$doc
as "$email_a" "$realm_a" GET "/api/v2/documents/$doc_a"
{ [ "$code" = 200 ] && grep -aq "sec-gate a $run" "$work/b"; } || fail "F4 control: A cannot read its own file (HTTP $code)"
echo "F4 control: A uploads, creates and reads its file"

# Create with B's path.
for url in "$key_b" "/$key_b" "./$key_b" "${key_b%%/*}//${key_b#*/}"; do
  file_doc "$email_a" "$realm_a" "$tenant_a" "$lease_a" "$url" "Fremd"
  echo "F4 A creates a document with url $url: HTTP $code"
  if [ "$code" = 201 ]; then
    breach "F4: A creates a document pointing at B's file ($url)"
    as "$email_a" "$realm_a" GET "/api/v2/documents/$doc"
    if reads_b; then breach "F4: A reads B's file through its own document ($url)"; fi
  fi
done
# One already stored (as an old record or one written before the fix would be): straight into MongoDB.
stored=$(docker compose "${files[@]}" exec -T mongo mongosh mredb --quiet --eval \
  "print(db.documents.insertOne({ realmId: '$realm_a', tenantId: '$tenant_a', leaseId: '$lease_a', type: 'file', name: 'Alt', url: '$key_b', mimeType: 'application/pdf' }).insertedId.toString())" | tr -d '\r\n')
[[ "$stored" =~ ^[0-9a-f]{24}$ ]] || fail "F4: could not store the document in MongoDB ($stored)"
as "$email_a" "$realm_a" GET "/api/v2/documents/$stored"
echo "F4 A reads its stored document pointing at B's file: HTTP $code"
if reads_b; then breach "F4: A reads B's file through a stored document"; fi

# Deleting: the tenant session (F1) and A's stored document must both leave B's file in place.
req -X DELETE "${cookie[@]}" "$base/api/v2/documents/$doc_b"
echo "F1 tenant session DELETE /api/v2/documents/<B's document>: HTTP $code"
[ "$code" = 404 ] || [ "$code" = 403 ] || breach "F1: tenant session DELETE /api/v2/documents answers $code, not 404 or 403"
as "$email_b" "$realm_b" GET "/api/v2/documents/$doc_b"
{ [ "$code" = 200 ] && reads_b; } || breach "F1: after the tenant session's DELETE, B's file is gone (HTTP $code)"
as "$email_a" "$realm_a" DELETE "/api/v2/documents/$stored"
echo "F4 A deletes its stored document pointing at B's file: HTTP $code"
as "$email_b" "$realm_b" GET "/api/v2/documents/$doc_b"
{ [ "$code" = 200 ] && reads_b; } || breach "F4: after A's DELETE, B's file is gone (HTTP $code)"
as "$email_a" "$realm_a" DELETE "/api/v2/documents/$doc_a"
[ "$code" = 204 ] || fail "F4 control: A deletes its own document: HTTP $code"
as "$email_a" "$realm_a" GET "/api/v2/documents/$doc_a"
[ "$code" = 404 ] || fail "F4 control: A's deleted document still answers $code"
echo "F4 control: A deletes its own document; B's file stays readable"

#############################################################################
# F2: tenantapi at the gateway (Caddy blocks it)
#############################################################################
tenants_seen() { # cookie-or-auth args…: GET /tenantapi/tenants at the gateway; sets $code and $seen (the tenant ids)
  req "$@" "$gateway/tenantapi/tenants"
  seen="HTTP $code"
  [ "$code" != 200 ] || seen=$(jq -r '.results[].tenant.id' "$work/b")
}
tenants_seen -H "cookie: sessionToken=$(session "MIETER-A-$run@Example.com")"
echo "F2 control: tenant session of A's contact (other case) sees: $(echo $seen)"
grep -qx "$tenant_a" <<<"$seen" || fail "F2 control: the tenant session of A's contact does not see tenant A"
! grep -qx "$tenant_b" <<<"$seen" || breach "F2: the tenant session of A's contact sees tenant B"
tenants_seen -H "cookie: sessionToken=$(session "mieter-a-$run@example.co")"
echo "F2 tenant session of a prefix of A's contact sees: $(echo $seen)"
! grep -qx "$tenant_a" <<<"$seen" || breach "F2: a prefix of A's contact address matches tenant A"
tenants_seen -H "cookie: sessionToken=$(session ".*")"
! grep -qxE "$tenant_a|$tenant_b" <<<"$seen" || breach "F2: the tenant session '.*' sees tenants"

# A landlord account named as a regular expression, the role tenant in its own Realm X.
email_x="(.*)$run|.*"
signup "$email_x"
mre "$email_x" '' POST /realms "$(jq -cn --arg n "Sec x $run" --arg e "$email_x" --arg a "sec-x-admin-$run@example.com" \
  '{name:$n,currency:"EUR",locale:"de-DE",members:[{name:"X",email:$e,role:"tenant",registered:true},{name:"Admin",email:$a,role:"administrator",registered:false}]}')"
realm_x=$id
signin "$email_x"
tenants_seen -H "authorization: Bearer $tok" -H "organizationid: $realm_x"
echo "F2 account '$email_x' with the role tenant in Realm X sees: $(echo $seen)"
# 200 with none of them: the pinned tenantapi answers 500 instead when the pattern also matches a tenant without rents.
[ "$code" = 200 ] || breach "F2: the account '$email_x' gets HTTP $code, not 200 with an empty list"
! grep -qxE "$tenant_a|$tenant_b" <<<"$seen" || breach "F2: the account '$email_x' sees the tenants of Realms A and B"

# A landlord account registered with exactly the address of tenant A's contact (no proof of the address at sign-up),
# the role tenant in its own Realm Y: a request with a Realm sees only that Realm, so not tenant A.
email_y="mieter-a-$run@example.com"
signup "$email_y"
mre "$email_y" '' POST /realms "$(jq -cn --arg n "Sec y $run" --arg e "$email_y" --arg a "sec-y-admin-$run@example.com" \
  '{name:$n,currency:"EUR",locale:"de-DE",members:[{name:"Y",email:$e,role:"tenant",registered:true},{name:"Admin",email:$a,role:"administrator",registered:false}]}')"
realm_y=$id
signin "$email_y"
tenants_seen -H "authorization: Bearer $tok" -H "organizationid: $realm_y"
echo "F2 account with tenant A's address and the role tenant in Realm Y sees: $(echo $seen)"
[ "$code" = 200 ] || breach "F2: the account with tenant A's address gets HTTP $code, not 200 with an empty list"
! grep -qxE "$tenant_a|$tenant_b" <<<"$seen" || breach "F2: an account with tenant A's address sees tenant A through its own Realm"

#############################################################################
# F3: realmId in the body of a PATCH (api)
#############################################################################
names_of() { # email realm collection: "<_id> <name>" per record of that Realm
  as "$1" "$2" GET "/api/v2/$3"
  [ "$code" = 200 ] || fail "F3: list $3 of $2: HTTP $code"
  jq -r '.[] | "\(._id) \(.name)"' "$work/b"
}
moved() { # collection id new-name variant: checks the record kept Realm A and took the new name, or, when the PATCH was
  # refused with 422 (the overlay refuses an update operator in the body), kept its old name
  local in_a in_b
  if [ "$code" = 422 ]; then set -- "$1" "$2" "$(sed -E 's/ [0-9]+$//' <<<"$3")" "$4"; fi
  in_a=$(names_of "$email_a" "$realm_a" "$1")
  in_b=$(names_of "$email_b" "$realm_b" "$1")
  if grep -q "^$2 " <<<"$in_b"; then breach "F3: $1/$2 moved into Realm B ($4)"; fi
  if ! grep -q "^$2 " <<<"$in_a"; then breach "F3: $1/$2 is gone from Realm A ($4)"; return; fi
  grep -qx "$2 $3" <<<"$in_a" || fail "F3 control: $1/$2 did not take the name '$3' ($4)"
}
n=0
for variant in plain set; do
  n=$((n + 1))
  # Fresh records per variant: on the pinned images the first variant already moves them out of Realm A.
  mre "$email_a" "$realm_a" POST /properties '{"type":"apartment","name":"Objekt F3","price":400}'
  property_f3=$id
  mre "$email_a" "$realm_a" POST /leases '{"name":"Vertrag F3","numberOfTerms":12,"timeRange":"months","active":true}'
  lease_f3=$id
  mre "$email_a" "$realm_a" POST /tenants "{\"name\":\"Mieter F3\",\"isCompany\":false,\"leaseId\":\"$lease_a\"}"
  tenant_f3=$id
  wrap() { # json-object: the update as sent, realmId B plain or as $set
    if [ "$variant" = plain ]; then jq -c --arg r "$realm_b" '. + {realmId:$r}' <<<"$1"; else
      jq -c --arg r "$realm_b" '. + {"$set":{realmId:$r}}' <<<"$1"; fi
  }
  as "$email_a" "$realm_a" PATCH "/api/v2/properties/$property_f3" "${json[@]}" \
    -d "$(wrap "{\"_id\":\"$property_f3\",\"type\":\"apartment\",\"name\":\"Objekt F3 $n\",\"price\":400}")"
  echo "F3 PATCH property with realmId B ($variant): HTTP $code"
  moved properties "$property_f3" "Objekt F3 $n" "$variant"
  as "$email_a" "$realm_a" PATCH "/api/v2/leases/$lease_f3" "${json[@]}" \
    -d "$(wrap "{\"_id\":\"$lease_f3\",\"name\":\"Vertrag F3 $n\",\"numberOfTerms\":12,\"timeRange\":\"months\",\"active\":true}")"
  echo "F3 PATCH lease with realmId B ($variant): HTTP $code"
  moved leases "$lease_f3" "Vertrag F3 $n" "$variant"
  as "$email_a" "$realm_a" PATCH "/api/v2/tenants/$tenant_f3" "${json[@]}" \
    -d "$(wrap "{\"_id\":\"$tenant_f3\",\"name\":\"Mieter F3 $n\",\"isCompany\":false,\"leaseId\":\"$lease_a\",\"properties\":[]}")"
  echo "F3 PATCH tenant with realmId B ($variant): HTTP $code"
  moved tenants "$tenant_f3" "Mieter F3 $n" "$variant"
done
echo "F3 control: the PATCHes renamed the records in Realm A (or, with \$set, were refused with 422)"

if [ "$failures" != 0 ]; then
  fail "$failures attack(s) went through (BREACH lines above)"
fi
echo "MRE security gate through Caddy and the MRE gateway ($host): OK"
