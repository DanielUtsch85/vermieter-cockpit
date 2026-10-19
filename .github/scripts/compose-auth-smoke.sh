#!/usr/bin/env bash
# VC-0-08 / VC-0-09 seed: proves the delegated MRE authentication (mre-integration.md
# §47.1) against the real pinned MRE images of the compose stack, not a fake:
# signup → signin → create Realm in MRE, then call DE /api/v1/health; then
# VC-1-01: create an MRE Property and link it to a DE PropertyReference.
set -euo pipefail

MRE=${MRE:-http://localhost:8080/api/v2}
DE=${DE:-http://localhost:8090/api/v1}
run=$(date +%s)
admin="admin-$run@example.com"
renter="renter-$run@example.com"
password="Smoke-$run-password"

json() { curl -fsS -H 'content-type: application/json' "$@"; }

for email in "$admin" "$renter"; do
  json -X POST "$MRE/authenticator/landlord/signup" \
    -d "{\"firstname\":\"Smoke\",\"lastname\":\"Test\",\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
done

token() {
  json -X POST "$MRE/authenticator/landlord/signin" \
    -d "{\"email\":\"$1\",\"password\":\"$password\"}" | jq -r .accessToken
}
admin_token=$(token "$admin")

realm_id=$(json -X POST "$MRE/realms" -H "authorization: Bearer $admin_token" \
  -d "{\"name\":\"Smoke $run\",\"currency\":\"EUR\",\"locale\":\"de-DE\",\"members\":[
        {\"name\":\"Admin\",\"email\":\"$admin\",\"role\":\"administrator\",\"registered\":true},
        {\"name\":\"Renter\",\"email\":\"$renter\",\"role\":\"renter\",\"registered\":true}]}" | jq -r ._id)
echo "created MRE realm $realm_id"

status() { # token realm
  curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $1" -H "organizationid: $2" "$DE/health"
}
expect() { # label actual expected
  echo "$1: $2"
  [ "$2" = "$3" ] || { echo "expected $3"; exit 1; }
}

# Tokens live 30 s in MRE; sign in again right before each call.
expect "administrator, own realm" "$(status "$(token "$admin")" "$realm_id")" 200
expect "administrator, foreign realm" "$(status "$(token "$admin")" "000000000000000000000000")" 403
expect "renter, own realm (no DE access)" "$(status "$(token "$renter")" "$realm_id")" 403
expect "no token" "$(curl -s -o /dev/null -w '%{http_code}' -H "organizationid: $realm_id" "$DE/health")" 401

# VC-1-01: link a real MRE Property to a DE PropertyReference.
property_id=$(json -X POST "$MRE/properties" -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" \
  -d '{"type":"apartment","name":"Smoke Wohnung","address":{"city":"Berlin"}}' | jq -r ._id)
echo "created MRE property $property_id"

link() { # realm property; sets link_status and link_body
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$DE/property-references/link" \
    -H "authorization: Bearer $(token "$admin")" -H "organizationid: $realm_id" -H 'content-type: application/json' \
    -d "{\"mreRealmId\":\"$1\",\"mrePropertyId\":\"$2\"}")
  link_status=$(echo "$out" | tail -n1)
  link_body=$(echo "$out" | sed '$d')
}

link "$realm_id" "$property_id"
expect "link MRE property" "$link_status" 201
reference_id=$(echo "$link_body" | jq -r .id)
expect "cached display name" "$(echo "$link_body" | jq -r .displayName)" "Smoke Wohnung"
link "$realm_id" "$property_id"
expect "repeat link (idempotent)" "$link_status" 200
expect "repeat returns the same reference" "$(echo "$link_body" | jq -r .id)" "$reference_id"
link "$realm_id" "000000000000000000000000"
expect "unknown MRE property" "$link_status" 404
link "$realm_id" "not-an-object-id"
expect "malformed mrePropertyId" "$link_status" 400
