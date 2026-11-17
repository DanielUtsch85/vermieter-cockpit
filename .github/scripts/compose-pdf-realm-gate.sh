#!/usr/bin/env bash
# Realm isolation of the MRE PDF route through Caddy and the MRE gateway, with curl (issue #396, backlog VC-X-82;
# Entscheidung des Projektinhabers, 2026-11-17: „… ein Zwei-Realm-Test über Gateway und Caddy in compose-smoke, der auf
# dem alten Stand nachweislich rot ist …“). curl only, no browser.
#
# Two synthetic landlord accounts, each the administrator of its own Realm, each Realm with a lease, a property and a
# tenant with rents, all created through Caddy with the MRE API. Then GET /api/v2/documents/<document>/<tenant>/<term>,
# the route the gateway hands to the pdfgenerator:
#   - A with Realm A, tenant A: 200 and a PDF (the route works);
#   - B with Realm B, tenant B: 200 and a PDF (tenant B is printable, so a refusal below is the Realm's doing);
#   - A with Realm A, tenant B, every document type of the pinned pdfgenerator: 404 and never a PDF or a name of Realm B
#     (the leak of #396: the pinned image answers 200 with tenant B's PDF here);
#   - A with Realm B: 404 (A is no member; checked by the pinned middleware before and after the fix);
#   - a tenant session (the token the authenticator issues after an OTP sign-in, sent as the sessionToken cookie, for
#     which the pinned middleware sets no Realm at all), tenant A: 404 and never a PDF (the tenant query then carries
#     realmId undefined, which the MongoDB driver sends as null: no tenant matches; the pinned image answers 200 with
#     the PDF). No e-mail is sent in this stack, so the token is minted inside the pdfgenerator container with its own
#     ACCESS_TOKEN_SECRET, exactly as the authenticator signs it; the secret never leaves the container.
#
# Runs in the job compose-smoke after the build of cockpit-ui, before the cockpit gate, against the stack
# docker-compose.yml already started: it adds the proxy override like the gate does (the same `up`, so the gate's own
# `up` changes nothing) with sign-up opened by MRE_SIGNUP=true for the synthetic accounts; the gate closes it again at
# its end. Every request goes over HTTPS to 127.0.0.1:443 under the cockpit hostname, verified against the root of
# Caddy's local CA (no --insecure). Needs docker, curl, jq and openssl. Synthetic data only (pdf-*@example.com).
set -euo pipefail

host=${COCKPIT_HOSTNAME:-cockpit.internal}
base="https://$host"
files=(-f docker-compose.yml -f docker-compose.proxy.yml)
work=$(mktemp -d)
started=

fail() {
  echo "PDF REALM GATE FAILED: $*" >&2
  exit 1
}
on_exit() {
  local status=$?
  if [ "$status" != 0 ] && [ -n "$started" ]; then
    echo "--- logs of pdfgenerator and gateway (last 60 lines each) ---" >&2
    docker compose "${files[@]}" logs --no-color --tail=60 pdfgenerator gateway >&2 || true
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

# One request through Caddy; sets $code, leaves the headers in $work/h and the body in $work/b.
req() {
  code=$(curl -sS -m 120 --noproxy '*' --cacert "$ca" --resolve "$host:443:127.0.0.1" \
    -D "$work/h" -o "$work/b" -w '%{http_code}' "$@") || fail "curl could not reach $base (TLS or connection): $*"
}
expect_code() { # label expected
  echo "$1: HTTP $code"
  [ "$code" = "$2" ] || fail "$1: expected HTTP $2, got $code; body: $(head -c 300 "$work/b" | tr -c '[:print:]\n' '.')"
}
is_pdf() { [ "$(head -c 5 "$work/b")" = '%PDF-' ]; }

run="$(date +%s)-$$"
password="Pdf-$run-password"
json=(-H 'content-type: application/json')
signin() { # email: sets $tok to a fresh access token (MRE access tokens live 30 s)
  req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signin" -d "{\"email\":\"$1\",\"password\":\"$password\"}"
  [ "$code" = 200 ] || fail "sign-in $1: HTTP $code"
  tok=$(jq -r '.accessToken // empty' "$work/b")
  [ -n "$tok" ] || fail "sign-in $1: no accessToken"
}
mre() { # email realm method path body: sets $id to the _id of the JSON answer; fails unless 200 with an ObjectId
  signin "$1"
  req -X "$3" "${json[@]}" -H "authorization: Bearer $tok" ${2:+-H "organizationid: $2"} "$base/api/v2$4" -d "$5"
  [ "$code" = 200 ] || fail "$3 $4 as $1: HTTP $code; body: $(head -c 300 "$work/b")"
  id=$(jq -r '._id // empty' "$work/b")
  [[ "$id" =~ ^[0-9a-f]{24}$ ]] || fail "$3 $4 as $1: no _id in the answer"
}

# Account, Realm, lease, property and tenant with monthly rents of 2026; sets realm_<letter> and tenant_<letter>.
seed() { # letter
  local email="pdf-$1-$run@example.com" realm lease property
  req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signup" \
    -d "{\"firstname\":\"Pdf\",\"lastname\":\"Realm $1\",\"email\":\"$email\",\"password\":\"$password\"}"
  [ "$code" = 201 ] || fail "sign-up $email: HTTP $code"
  mre "$email" '' POST /realms "{\"name\":\"Pdf $1 $run\",\"currency\":\"EUR\",\"locale\":\"de-DE\",
    \"members\":[{\"name\":\"Admin\",\"email\":\"$email\",\"role\":\"administrator\",\"registered\":true}]}"
  realm=$id
  mre "$email" "$realm" POST /leases '{"name":"Wohnraum","numberOfTerms":12,"timeRange":"months","active":true}'
  lease=$id
  mre "$email" "$realm" POST /properties "{\"type\":\"apartment\",\"name\":\"Wohnung $1\",\"price\":500,\"address\":{\"city\":\"Berlin\"}}"
  property=$id
  mre "$email" "$realm" POST /tenants "{\"name\":\"Mieter $1 $run\",\"isCompany\":false,\"leaseId\":\"$lease\",
    \"beginDate\":\"01/01/2026\",\"endDate\":\"31/12/2026\",\"frequency\":\"months\",
    \"street1\":\"Beispielweg 1\",\"zipCode\":\"10115\",\"city\":\"Berlin\",
    \"contacts\":[{\"contact\":\"Mieter $1\",\"email\":\"mieter-$1-$run@example.com\"}],
    \"properties\":[{\"propertyId\":\"$property\",\"rent\":500,\"expenses\":[{\"title\":\"Nebenkosten\",\"amount\":100}],
      \"entryDate\":\"01/01/2026\",\"exitDate\":\"31/12/2026\"}]}"
  [ "$(jq -r '.rental // empty' "$work/b")" = 500 ] || fail "tenant $1: no monthly rent of 500 in the answer"
  printf -v "realm_$1" %s "$realm"
  printf -v "tenant_$1" %s "$id"
}
seed a
seed b
email_a="pdf-a-$run@example.com"
email_b="pdf-b-$run@example.com"
term=2026030100
echo "realm A $realm_a with tenant $tenant_a, realm B $realm_b with tenant $tenant_b, term $term"

pdf() { # email realm document tenant: the PDF route through Caddy and the gateway
  signin "$1"
  req -H "authorization: Bearer $tok" -H "organizationid: $2" "$base/api/v2/documents/$3/$4/$term"
}
expect_pdf() { # label
  expect_code "$1" 200
  is_pdf || fail "$1: the answer is not a PDF (starts with '$(head -c 20 "$work/b" | tr -c '[:print:]' '.')')"
  echo "$1: a PDF of $(wc -c <"$work/b") bytes"
}
expect_refused() { # label
  expect_code "$1" 404
  ! is_pdf || fail "$1: the refusal carries a PDF"
  ! grep -aqE "Realm b|Mieter b|Pdf b|Wohnung b" "$work/b" || fail "$1: the refusal names data of Realm B"
}

pdf "$email_a" "$realm_a" invoice "$tenant_a"
expect_pdf 'A, Realm A, tenant A (invoice)'
pdf "$email_b" "$realm_b" invoice "$tenant_b"
expect_pdf 'B, Realm B, tenant B (invoice)'
for document in invoice rentcall rentcall_reminder rentcall_last_reminder; do
  pdf "$email_a" "$realm_a" "$document" "$tenant_b"
  expect_refused "A, Realm A, tenant B of Realm B ($document)"
done
pdf "$email_a" "$realm_b" invoice "$tenant_b"
expect_refused 'A, Realm B (not a member), tenant B (invoice)'

# The tenant session: the pinned checkOrganization() sets no Realm for a sessionToken cookie without Authorization.
session=$(docker compose "${files[@]}" exec -T pdfgenerator node -e \
  "process.stdout.write(require('jsonwebtoken').sign({ account: { email: 'mieter-a-$run@example.com', role: 'tenant' } }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '5m' }))")
[ -n "$session" ] || fail "no tenant session token"
req -H "cookie: sessionToken=$session" -H "organizationid: $realm_a" "$base/api/v2/documents/invoice/$tenant_a/$term"
expect_refused 'tenant session without a Realm, tenant A (invoice)'

echo "PDF realm gate through Caddy and the MRE gateway ($host): OK"
