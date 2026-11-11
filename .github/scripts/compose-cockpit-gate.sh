#!/usr/bin/env bash
# Cockpit integration gate through Caddy, with curl (Entscheidung des Projektinhabers, 2026-11-10, #319 question 3 (b)):
# "`/cockpit/` liefert die Startseite, Anmeldung, Refresh-Cookie mit `httpOnly; Secure; SameSite=Strict`,
# `/api/v1/health` über Caddy." The browser run with Playwright is its own CI job, browser-e2e (backlog VC-X-70), not here.
#
# Runs in the job compose-smoke after the other steps, against the stack docker-compose.yml already started: it adds
# the proxy override (docker-compose.proxy.yml, the productive Caddyfile) with its service cockpit-ui, the productive
# cockpit UI (webapps/cockpit/Dockerfile, Entscheidung des Projektinhabers, 2026-11-10, zu #319 F3 (a)), and recreates
# authenticator, gateway, emailer and de-backend (all overridden there) with the proxy settings (APP_DOMAIN = the cockpit hostname, APP_PROTOCOL = https,
# mre-integration.md §47.2, betrieb.md §9.4). Nothing CI-only is added: what answers here is what runs in production.
# Needs docker, curl, jq and openssl, and the cockpit-ui image built from this checkout (the step before in ci.yml,
# `docker compose -f docker-compose.yml -f docker-compose.proxy.yml build cockpit-ui`). Synthetic accounts only
# (gate-*@example.com); sign-up is opened for this run with MRE_SIGNUP=true, as betrieb.md §9.4 does for a first account,
# and closed again at the end as its step 5 does.
#
# Besides #319 (b), the cockpit-ui checks of #322 F3 (Entscheidung des Projektinhabers, 2026-11-10: "`Cache-Control:
# no-store` auf `index.html` im `cockpit-ui`-Dienst"): no-store on /cockpit/ and on a deep link, the deep link answers
# with the same index.html (SPA fallback), a hashed asset answers 200 and is cacheable (immutable), a missing asset is
# a 404 and not the start page.
#
# And #332 F2 and F3 (Entscheidung des Projektinhabers, 2026-11-11: "`Domain=<COCKPIT_HOSTNAME>` am Refresh-Cookie
# verlangen; zum Schluss prüfen, dass Signup mit produktivem Default 404 antwortet."): both refresh cookies carry
# exactly one Domain attribute naming the gate's host; last, the authenticator is recreated with MRE_SIGNUP unset (the
# default of docker-compose.proxy.yml, SIGNUP=false), and POST signup through Caddy answers 404 while sign-in still
# answers 200.
#
# Every request goes over HTTPS to the published 127.0.0.1:443 of Caddy under the cockpit hostname, and the TLS
# certificate is verified against the root of Caddy's local CA from the caddy-data volume (no --insecure). The cookie
# attributes are asserted on the Set-Cookie header as the authenticator sends it through Caddy, not on what a browser
# would keep.
set -euo pipefail

host=${COCKPIT_HOSTNAME:-cockpit.internal}
base="https://$host"
files=(-f docker-compose.yml -f docker-compose.proxy.yml)
work=$(mktemp -d)
started=

fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
on_exit() {
  local status=$?
  if [ "$status" != 0 ] && [ -n "$started" ]; then
    echo "--- logs of caddy, cockpit-ui and authenticator (last 60 lines each) ---" >&2
    docker compose "${files[@]}" logs --no-color --tail=60 caddy cockpit-ui authenticator >&2 || true
  fi
  rm -rf "$work"
}
trap on_exit EXIT

image=$(docker compose "${files[@]}" config --format json | jq -r '.services.caddy.image')

started=yes
MRE_SIGNUP=true docker compose "${files[@]}" up -d --wait --wait-timeout 300

# The index.html inside the cockpit-ui image: every page answer below must be exactly this file.
index="$work/index.html"
docker compose "${files[@]}" exec -T cockpit-ui cat /srv/cockpit/index.html >"$index" ||
  fail "no /srv/cockpit/index.html in the cockpit-ui container"

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
header() { # name -> value of the first such header, CR stripped; empty when there is none
  { grep -i "^$1:" "$work/h" || true; } | head -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'
}
cache_directive() { # label directive: the Cache-Control header lists the directive (case-insensitive, `,`-separated)
  local value
  value=$(header cache-control)
  echo "$1: Cache-Control: ${value:-<none>}"
  tr ',' '\n' <<<"$value" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | grep -qix "$2" ||
    fail "$1: Cache-Control '${value:-<none>}' lacks $2"
}
start_page() { # label: the answer is the start page, exactly the index.html of the image, and not to be stored
  expect_code "$1" 200
  [[ "$(header content-type)" == text/html* ]] || fail "$1: content-type is '$(header content-type)', not text/html"
  cmp -s "$work/b" "$index" || fail "$1: the body is not the index.html of the cockpit-ui image"
  grep -q '<div id="root"></div>' "$work/b" || fail "$1: no <div id=\"root\"> in the start page"
  cache_directive "$1" no-store
}

# 1. /cockpit/ serves the start page: exactly the built index.html, no-store, and the script it names.
req "$base/cockpit/"
start_page "GET /cockpit/"
asset=$(grep -oE 'src="/cockpit/assets/[^"]+\.js"' "$work/b" | head -n1 | sed -E 's/^src="(.*)"$/\1/')
[ -n "$asset" ] || fail "GET /cockpit/: the start page names no script under /cockpit/assets/"
req "$base$asset"
expect_code "GET $asset" 200
[[ "$(header content-type)" == *javascript* ]] || fail "GET $asset: content-type is '$(header content-type)'"
cache_directive "GET $asset" immutable

# A deep link is a route of the client, not a file: the SPA fallback answers with the same start page, no-store.
deep="/cockpit/r/gate-realm/buchungen/gate-transaction"
req "$base$deep"
start_page "GET $deep"
# A missing asset is a 404, not the start page under a script's name.
req "$base/cockpit/assets/gate-missing.js"
expect_code "GET /cockpit/assets/gate-missing.js" 404

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

# 3. The refresh token is a cookie with HttpOnly, Secure and SameSite=Strict (§47.2 item 2) and Domain=<the gate's
# host> (#332 F2). Attribute names are matched case-insensitively, each as its own `;`-separated attribute; the value
# is never printed. Domain: exactly one such attribute, its value equal to $host (case-sensitive, as the authenticator
# echoes APP_DOMAIN); one leading dot is ignored, as a user agent ignores it (RFC 6265 §5.2.3), so `.host` passes and
# `host.`, a parent domain, a subdomain or a second Domain attribute fail.
check_refresh_cookie() { # label
  local line raw attrs domains
  line=$(grep -i '^set-cookie:[[:space:]]*refreshToken=' "$work/h" | head -n1 | tr -d '\r') ||
    fail "$1: no Set-Cookie for refreshToken"
  echo "$1: $(sed -E 's/(refreshToken=)[^;]*/\1<redacted>/I' <<<"$line")"
  raw=$(cut -d';' -f2- <<<"$line" | tr ';' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
  attrs=$(tr '[:upper:]' '[:lower:]' <<<"$raw")
  grep -qx 'httponly' <<<"$attrs" || fail "$1: the refresh cookie lacks HttpOnly"
  grep -qx 'secure' <<<"$attrs" || fail "$1: the refresh cookie lacks Secure"
  grep -qx 'samesite=strict' <<<"$attrs" || fail "$1: the refresh cookie lacks SameSite=Strict"
  domains=$({ grep -iE '^domain[[:space:]]*=' <<<"$raw" || true; } | sed -E 's/^[^=]*=[[:space:]]*//; s/^\.//')
  [ -n "$domains" ] || fail "$1: the refresh cookie lacks Domain=$host"
  [ "$(wc -l <<<"$domains")" = 1 ] || fail "$1: the refresh cookie has more than one Domain attribute"
  [ "$domains" = "$host" ] || fail "$1: the refresh cookie has Domain=$domains, not Domain=$host"
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

# 5. Sign-up closed again with the productive default (#332 F3; betrieb.md §9.4 steps 4 and 5): only the authenticator
# is recreated, MRE_SIGNUP unset so SIGNUP falls back to false; the rest of the stack stays as it is (--no-deps).
env -u MRE_SIGNUP docker compose "${files[@]}" up -d --no-deps --wait --wait-timeout 120 authenticator
# The authenticator has no healthcheck: wait until sign-in through Caddy answers 200 again. That also shows the 404
# below comes from the running authenticator without the route, not from a service that does not answer.
for _ in $(seq 1 60); do
  req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signin" -d "{\"email\":\"$email\",\"password\":\"$password\"}"
  [ "$code" = 200 ] && break
  sleep 1
done
expect_code "sign-in $email after the authenticator is recreated with MRE_SIGNUP unset" 200
req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signup" \
  -d "{\"firstname\":\"Gate\",\"lastname\":\"Closed\",\"email\":\"gate-closed-$run@example.com\",\"password\":\"$password\"}"
echo "sign-up with the productive default (MRE_SIGNUP unset): HTTP $code"
[ "$code" = 404 ] ||
  fail "sign-up with the productive default (MRE_SIGNUP unset) must answer 404 (the route does not exist), got $code"

echo "cockpit gate through Caddy ($host, $image): OK"
