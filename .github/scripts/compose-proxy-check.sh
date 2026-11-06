#!/usr/bin/env bash
# Issue #281 item 4 (docs/development/betrieb.md §9; Entscheidung des Projektinhabers, 2026-11-06): the optional
# proxy override still renders together with docker-compose.yml, publishes Caddy on no wildcard address, and the
# Caddyfile is valid in the very Caddy image the override names. Needs docker; starts nothing of the stack.
set -euo pipefail

files=(-f docker-compose.yml -f docker-compose.proxy.yml)
docker compose "${files[@]}" config -q

rendered=$(docker compose "${files[@]}" config --format json)
# VPN-only: every published port of Caddy has an explicit host address (default 127.0.0.1), never 0.0.0.0.
bad=$(echo "$rendered" | jq -r '.services.caddy.ports[] | select((.host_ip // "") == "" or .host_ip == "0.0.0.0" or .host_ip == "::") | .published')
if [ -n "$bad" ]; then
  echo "caddy publishes port(s) $bad without a VPN address" >&2
  exit 1
fi
echo "$rendered" | jq -e '.services.authenticator.environment.SIGNUP == "false"' > /dev/null || {
  echo "MRE sign-up is not closed by default in the proxy override" >&2
  exit 1
}

image=$(echo "$rendered" | jq -r '.services.caddy.image')
docker run --rm -e COCKPIT_HOSTNAME=cockpit.internal -e COCKPIT_UI_UPSTREAM=cockpit-ui:80 \
  -v "$PWD/deploy/caddy:/etc/caddy:ro" "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
echo "proxy override and Caddyfile ($image): OK"
