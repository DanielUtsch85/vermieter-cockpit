#!/usr/bin/env bash
# VC-0-08 / VC-0-09 seed: proves the delegated MRE authentication (mre-integration.md
# §47.1) against the real pinned MRE images of the compose stack, not a fake:
# signup → signin → create Realm in MRE, then call DE /api/v1/health.
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
