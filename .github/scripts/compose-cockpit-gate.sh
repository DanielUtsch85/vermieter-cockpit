#!/usr/bin/env bash
# Cockpit integration gate through Caddy, with curl (Entscheidung des Projektinhabers, 2026-11-10, #319 question 3 (b)):
# "`/cockpit/` liefert die Startseite, Anmeldung, Refresh-Cookie mit `httpOnly; Secure; SameSite=Strict`,
# `/api/v1/health` über Caddy." The browser run with Playwright is its own CI job later (backlog VC-X-70), not here.
#
# Runs in the job compose-smoke after the other steps, against the stack docker-compose.yml already started: it adds
# the proxy override (docker-compose.proxy.yml, the productive Caddyfile) and the CI-only stand-in for the cockpit UI
# (.github/compose/cockpit-gate.yml), which recreates authenticator, gateway and emailer with the proxy settings
# (APP_DOMAIN = the cockpit hostname, APP_PROTOCOL = https, mre-integration.md §47.2, betrieb.md §9.4).
# Needs docker, curl, jq, openssl and the built cockpit (webapps/cockpit/dist). Synthetic accounts only
# (gate-*@example.com); sign-up is opened for this run with MRE_SIGNUP=true, as betrieb.md §9.4 does for a first account.
#
# Every request goes over HTTPS to the published 127.0.0.1:443 of Caddy under the cockpit hostname, and the TLS
# certificate is verified against the root of Caddy's local CA from the caddy-data volume (no --insecure). The cookie
# attributes are asserted on the Set-Cookie header as the authenticator sends it through Caddy, not on what a browser
# would keep.
set -euo pipefail

host=${COCKPIT_HOSTNAME:-cockpit.internal}
base="https://$host"
dist=webapps/cockpit/dist
files=(-f docker-compose.yml -f docker-compose.proxy.yml -f .github/compose/cockpit-gate.yml)
work=$(mktemp -d)

fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
on_exit() {
  local status=$?
  if [ "$status" != 0 ] && [ -n "${COCKPIT_GATE_CADDY_IMAGE:-}" ]; then
    echo "--- logs of caddy, cockpit-ui-ci and authenticator (last 60 lines each) ---" >&2
    docker compose "${files[@]}" logs --no-color --tail=60 caddy cockpit-ui-ci authenticator >&2 || true
  fi
  rm -rf "$work"
}
trap on_exit EXIT

[ -f "$dist/index.html" ] ||
  fail "$dist/index.html is missing: build the cockpit first (yarn workspace @vermieter-cockpit/cockpit build)"

# The stand-in runs the digest-pinned Caddy image of the proxy override (no second image reference, VC-X-09).
image=$(docker compose -f docker-compose.yml -f docker-compose.proxy.yml config --format json | jq -r '.services.caddy.image')
[[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || fail "the Caddy image of docker-compose.proxy.yml is not pinned by digest: $image"
export COCKPIT_GATE_CADDY_IMAGE=$image

MRE_SIGNUP=true docker compose "${files[@]}" up -d --wait --wait-timeout 300

# Caddy creates its local CA at start; wait for the root certificate, then trust exactly that one.
ca="$work/caddy-root.crt"
for _ in $(seq 1 30); do
  if docker compose "${files[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$ca" 2>/dev/null &&
    openssl x509 -in "$ca" -noout 2>/dev/null; then
    break
  fi
  sleep 1
done
openssl x509 -in "$ca" -noout 2>/dev/null || fail "no root certificate of Caddy's local CA after 30 s"

# One request through Caddy; sets $code, and leaves the headers in $work/h and the body in $work/b.
req() {
  code=$(curl -sS --noproxy '*' --cacert "$ca" --resolve "$host:443:127.0.0.1" \
    -D "$work/h" -o "$work/b" -w '%{http_code}' "$@") || fail "curl could not reach $base (TLS or connection): $*"
}
expect_code() { # label expected
  echo "$1: HTTP $code"
  [ "$code" = "$2" ] || fail "$1: expected HTTP $2, got $code; body: $(head -c 300 "$work/b")"
}
header() { # name -> value of the first such header, CR stripped
  grep -i "^$1:" "$work/h" | head -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'
}

# 1. /cockpit/ serves the start page: exactly the built index.html, and the script it names.
req "$base/cockpit/"
expect_code "GET /cockpit/" 200
[[ "$(header content-type)" == text/html* ]] || fail "GET /cockpit/: content-type is '$(header content-type)', not text/html"
cmp -s "$work/b" "$dist/index.html" || fail "GET /cockpit/: the body is not the built $dist/index.html"
grep -q '<div id="root"></div>' "$work/b" || fail "GET /cockpit/: no <div id=\"root\"> in the start page"
asset=$(grep -oE 'src="/cockpit/assets/[^"]+\.js"' "$work/b" | head -n1 | sed -E 's/^src="(.*)"$/\1/')
[ -n "$asset" ] || fail "GET /cockpit/: the start page names no script under /cockpit/assets/"
req "$base$asset"
expect_code "GET $asset" 200
[[ "$(header content-type)" == *javascript* ]] || fail "GET $asset: content-type is '$(header content-type)'"

# 2. Sign-in through the MRE authenticator behind Caddy (no DE login, §47.2 item 1).
run="$(date +%s)-$$"
email="gate-admin-$run@example.com"
password="Gate-$run-password"
json=(-H 'content-type: application/json')
req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signup" \
  -d "{\"firstname\":\"Gate\",\"lastname\":\"Admin\",\"email\":\"$email\",\"password\":\"$password\"}"
expect_code "sign-up $email" 201
req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signin" -d "{\"email\":\"$email\",\"password\":\"$password\"}"
expect_code "sign-in $email" 200
token=$(jq -r '.accessToken // empty' "$work/b")
[ -n "$token" ] || fail "sign-in: no accessToken in the answer"

# 3. The refresh token is a cookie with HttpOnly, Secure and SameSite=Strict (§47.2 item 2). Attributes are matched
# case-insensitively, each as its own `;`-separated attribute; the value is never printed.
check_refresh_cookie() { # label
  local line attrs
  line=$(grep -i '^set-cookie:[[:space:]]*refreshToken=' "$work/h" | head -n1 | tr -d '\r') ||
    fail "$1: no Set-Cookie for refreshToken"
  echo "$1: $(sed -E 's/(refreshToken=)[^;]*/\1<redacted>/I' <<<"$line")"
  attrs=$(cut -d';' -f2- <<<"$line" | tr ';' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | tr '[:upper:]' '[:lower:]')
  grep -qx 'httponly' <<<"$attrs" || fail "$1: the refresh cookie lacks HttpOnly"
  grep -qx 'secure' <<<"$attrs" || fail "$1: the refresh cookie lacks Secure"
  grep -qx 'samesite=strict' <<<"$attrs" || fail "$1: the refresh cookie lacks SameSite=Strict"
}
check_refresh_cookie "sign-in Set-Cookie"
cookie=$(grep -i '^set-cookie:[[:space:]]*refreshToken=' "$work/h" | head -n1 | tr -d '\r' | sed -E 's/^[^:]+:[[:space:]]*//; s/;.*$//')

# The cookie renews the session on the same origin, and the new one carries the same attributes.
req -X POST -H "cookie: $cookie" "$base/api/v2/authenticator/landlord/refreshtoken"
expect_code "refresh with the cookie" 200
[ -n "$(jq -r '.accessToken // empty' "$work/b")" ] || fail "refresh: no accessToken in the answer"
check_refresh_cookie "refresh Set-Cookie"
token=$(jq -r '.accessToken' "$work/b")

# 4. /api/v1/health through Caddy reaches DE: 401 without a token, 200 with the token and an own Realm.
req -X POST "${json[@]}" -H "authorization: Bearer $token" "$base/api/v2/realms" \
  -d "{\"name\":\"Gate $run\",\"currency\":\"EUR\",\"locale\":\"de-DE\",\"members\":[{\"name\":\"Admin\",\"email\":\"$email\",\"role\":\"administrator\",\"registered\":true}]}"
expect_code "create MRE realm" 200
realm=$(jq -r '._id // empty' "$work/b")
[ -n "$realm" ] || fail "create realm: no _id in the answer"
req -H "organizationid: $realm" "$base/api/v1/health"
expect_code "GET /api/v1/health without a token" 401
req -H "authorization: Bearer $token" -H "organizationid: $realm" "$base/api/v1/health"
expect_code "GET /api/v1/health with the token, own realm" 200

echo "cockpit gate through Caddy ($host, $image): OK"
