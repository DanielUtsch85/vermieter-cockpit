#!/usr/bin/env bash
# Automatic restart of the whole stack (issue #398; Auftrag des Projektinhabers, 2026-11-18: „Bei mehreren Kerndiensten
# fehlen Restart-Policies. Bitte den vollständigen automatischen Wiederanlauf gewährleisten und durch einen echten
# Host-Neustart prüfen: Datenbanken, MRE, DE-Backend und beide Oberflächen müssen anschließend funktionieren.“).
#
# Restarts the Docker daemon (on the CI runner `sudo systemctl restart docker`; elsewhere DOCKER_RESTART_CMD), which
# stops every container and, when it comes back, starts again exactly those with a restart policy, as on a host boot.
# Nothing here runs `docker compose up` after the restart, so a service without `restart: unless-stopped` stays down and
# the check is red. Afterwards:
#   - every service of docker-compose.yml plus docker-compose.proxy.yml runs again in the same container (not recreated)
#     with a new start time, and is healthy where it has a healthcheck;
#   - DE backend /health/ready (PostgreSQL), MRE gateway /health (with the landlord UI);
#   - through Caddy: /cockpit/ (cockpit UI), /landlord/ (MRE landlord UI), the MRE sign-in of an account created before
#     the restart (MongoDB, Redis, authenticator), its Realm (api), and /api/v1/health of the DE backend with that
#     session (DE and MRE together).
# The real reboot of the productive host stays a step of the go-live (#281; betrieb.md §9.6).
#
# Runs last in compose-smoke, after the cockpit gate, against the stack it leaves (proxy override, sign-up closed). It
# opens sign-up once for its synthetic account (sec-restart-*@example.com) and closes it again before the restart. Needs
# docker, curl, jq and openssl.
set -euo pipefail

host=${COCKPIT_HOSTNAME:-cockpit.internal}
base="https://$host"
files=(-f docker-compose.yml -f docker-compose.proxy.yml ${RESTART_CHECK_EXTRA_COMPOSE:+-f "$RESTART_CHECK_EXTRA_COMPOSE"})
restart_cmd=${DOCKER_RESTART_CMD:-sudo systemctl restart docker}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() {
  echo "RESTART CHECK FAILED: $*" >&2
  docker compose "${files[@]}" ps -a >&2 || true
  exit 1
}

# An account and a Realm that must survive the restart; sign-up is closed again before it.
MRE_SIGNUP=true docker compose "${files[@]}" up -d --wait --wait-timeout 300
docker compose "${files[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$work/ca.crt"
req() { # sets $code, body in $work/b
  code=$(curl -sS -m 60 --noproxy '*' --cacert "$work/ca.crt" --resolve "$host:443:127.0.0.1" -o "$work/b" \
    -w '%{http_code}' "$@") || code=000
}
run="$(date +%s)-$$"
email="sec-restart-$run@example.com"
password="Restart-$run-password"
json=(-H 'content-type: application/json')
req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signup" \
  -d "{\"firstname\":\"Sec\",\"lastname\":\"Restart\",\"email\":\"$email\",\"password\":\"$password\"}"
[ "$code" = 201 ] || fail "sign-up before the restart: HTTP $code"
signin() {
  req -X POST "${json[@]}" "$base/api/v2/authenticator/landlord/signin" -d "{\"email\":\"$email\",\"password\":\"$password\"}"
  [ "$code" = 200 ] || fail "MRE sign-in through Caddy: HTTP $code"
  tok=$(jq -r '.accessToken // empty' "$work/b")
}
signin
req -X POST "${json[@]}" -H "authorization: Bearer $tok" "$base/api/v2/realms" \
  -d "{\"name\":\"Restart $run\",\"currency\":\"EUR\",\"locale\":\"de-DE\",\"members\":[{\"name\":\"Admin\",\"email\":\"$email\",\"role\":\"administrator\",\"registered\":true}]}"
[ "$code" = 200 ] || fail "Realm before the restart: HTTP $code"
realm=$(jq -r '._id' "$work/b")
docker compose "${files[@]}" up -d --wait --wait-timeout 300

services=$(docker compose "${files[@]}" config --services | sort)
declare -A id_before started_before
for service in $services; do
  id_before[$service]=$(docker compose "${files[@]}" ps -q "$service")
  [ -n "${id_before[$service]}" ] || fail "$service does not run before the restart"
  started_before[$service]=$(docker inspect -f '{{.State.StartedAt}}' "${id_before[$service]}")
done

echo "restarting the Docker daemon: $restart_cmd"
eval "$restart_cmd"
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || fail "the Docker daemon is not back after 60 s"

# Every service back on its own, in its old container, healthy where it has a healthcheck.
deadline=$((SECONDS + 300))
while :; do
  pending=
  for service in $services; do
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}}' \
      "${id_before[$service]}" 2>/dev/null || echo "missing")
    read -r status health started <<<"$state"
    if [ "$status" != running ] || { [ "$health" != healthy ] && [ "$health" != none ]; } ||
      [ "$started" = "${started_before[$service]}" ]; then
      pending+="$service($state) "
    fi
  done
  [ -z "$pending" ] && break
  [ "$SECONDS" -lt "$deadline" ] || fail "not back 300 s after the restart: $pending"
  sleep 3
done
echo "all services back in their containers: $(echo $services)"

curl -fsS --noproxy '*' -m 30 http://127.0.0.1:8090/health/ready >/dev/null || fail "DE backend /health/ready"
curl -fsS --noproxy '*' -m 30 http://127.0.0.1:8080/health >/dev/null || fail "MRE gateway /health"
for _ in $(seq 1 30); do
  req "$base/cockpit/"
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || fail "cockpit UI /cockpit/ through Caddy: HTTP $code"
req "$base/landlord/signin"
[ "$code" = 200 ] || fail "MRE landlord UI /landlord/signin through Caddy: HTTP $code"
signin
req -H "authorization: Bearer $tok" "$base/api/v2/realms"
[ "$code" = 200 ] && jq -e --arg r "$realm" 'map(._id) | index($r) != null' "$work/b" >/dev/null ||
  fail "the Realm of before the restart is not listed (HTTP $code)"
req -H "authorization: Bearer $tok" -H "organizationid: $realm" "$base/api/v1/health"
[ "$code" = 200 ] || fail "DE /api/v1/health through Caddy with the MRE session: HTTP $code"
echo "after the restart: DE (PostgreSQL), MRE (MongoDB, Redis, authenticator, api), gateway, cockpit UI and landlord UI through Caddy: OK"
