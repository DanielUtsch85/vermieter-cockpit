#!/usr/bin/env bash
# Issue #281 item 4 (docs/development/betrieb.md §9; Entscheidung des Projektinhabers, 2026-11-06): the optional
# proxy override still renders together with docker-compose.yml, publishes Caddy on no wildcard address, every service
# restarts on its own (issue #398), and the Caddyfile is valid in the very Caddy image the override names. Needs docker; starts nothing of the stack.
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

# The MRE landlord UI (VC-X-80): reached only through the gateway, so no published port; its sign-up page follows
# MRE_SIGNUP like the authenticator and is hidden by default; the gateway serves it under /landlord.
echo "$rendered" | jq -e '.services["landlord-frontend"] | (.ports // []) == [] and .environment.SIGNUP == "false"' > /dev/null || {
  echo "landlord-frontend publishes a port or shows sign-up by default in the proxy override" >&2
  exit 1
}
echo "$rendered" | jq -e '.services.gateway.environment | .EXPOSE_FRONTENDS == "true" and .LANDLORD_BASE_PATH == "/landlord" and .LANDLORD_FRONTEND_URL == "http://landlord-frontend:8180"' > /dev/null || {
  echo "the gateway does not serve landlord-frontend under /landlord" >&2
  exit 1
}

# Automatic restart after a crash or a host reboot (issue #398; Auftrag des Projektinhabers, 2026-11-18: „Bitte den
# vollständigen automatischen Wiederanlauf gewährleisten …“): every service of the productive stack has
# `restart: unless-stopped` (or `always`), in the base file and with the override alike. The restart itself is checked in
# compose-smoke by .github/scripts/compose-restart-check.sh.
for rendered_set in "$(docker compose -f docker-compose.yml config --format json)" "$rendered"; do
  missing=$(echo "$rendered_set" | jq -r '.services | to_entries[] | select(.value.restart != "unless-stopped" and .value.restart != "always") | .key')
  if [ -n "$missing" ]; then
    echo "service(s) without restart: unless-stopped: $(echo $missing)" >&2
    exit 1
  fi
done

image=$(echo "$rendered" | jq -r '.services.caddy.image')
docker run --rm -e COCKPIT_HOSTNAME=cockpit.internal -e COCKPIT_UI_UPSTREAM=cockpit-ui:80 \
  -v "$PWD/deploy/caddy:/etc/caddy:ro" "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
echo "proxy override and Caddyfile ($image): OK"
