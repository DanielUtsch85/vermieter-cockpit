#!/usr/bin/env bash
# The cockpit's browser run with Playwright (backlog VC-X-70), the job browser-e2e of ci.yml, its own job and not a step
# of compose-smoke (Entscheidung des Projektinhabers, 2026-11-10, zu #319 Frage 3 (b): „Der Browser-Durchlauf mit
# Playwright wird eine eigene Backlog-Zeile nach Schritt 7, als eigener CI-Job, nicht in compose-smoke.“; 2026-11-11,
# V1 point 4: „VC-X-70, Playwright-Job als eigener CI-Job gegen den Stack mit `cockpit-ui`.“).
#
# Starts the stack as the cockpit gate does (compose-cockpit-gate.sh): docker-compose.yml plus docker-compose.proxy.yml
# with the real cockpit-ui service, sign-up opened with MRE_SIGNUP=true for the synthetic accounts (e2e-*@example.com,
# betrieb.md §9.4). The images must already be built from this checkout (the step before in ci.yml). Then Chromium
# headless (Playwright, the version pinned in webapps/cockpit/package.json) through Caddy at https://$COCKPIT_HOSTNAME,
# the name resolved to 127.0.0.1 in the browser; TLS is verified against the root of Caddy's local CA from the
# caddy-data volume, trusted only in a throwaway certificate store of this run (no ignoreHTTPSErrors).
#
# Needs docker, openssl, certutil (libnss3-tools) and the installed workspace (`yarn install --immutable`) with its
# Chromium (`npx playwright install --with-deps chromium`). Extra arguments go to `playwright test` (e.g. a spec file).
set -euo pipefail

host=${COCKPIT_HOSTNAME:-cockpit.internal}
files=(-f docker-compose.yml -f docker-compose.proxy.yml)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

MRE_SIGNUP=true docker compose "${files[@]}" up -d --wait --wait-timeout 300

ca="$work/caddy-root.crt"
for _ in $(seq 1 30); do
  if docker compose "${files[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$ca" 2>/dev/null &&
    openssl x509 -in "$ca" -noout 2>/dev/null; then
    break
  fi
  sleep 1
done
openssl x509 -in "$ca" -noout 2>/dev/null || { echo "BROWSER RUN FAILED: no root certificate of Caddy's local CA after 30 s" >&2; exit 1; }

# Chromium on Linux reads trusted roots from $HOME/.pki/nssdb: a fresh HOME for this run holds exactly this root, and
# the runner's own HOME stays untouched. The browsers stay where `playwright install` put them.
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}
export HOME="$work/home"
mkdir -p "$HOME/.pki/nssdb"
certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password
certutil -A -d "sql:$HOME/.pki/nssdb" -t 'C,,' -n "caddy-local-$host" -i "$ca"

export COCKPIT_HOSTNAME="$host"
cd webapps/cockpit
# The CLI of the workspace's own @playwright/test, as Node resolves it from webapps/cockpit.
node "$(node -p "require.resolve('@playwright/test/cli')")" test -c e2e --trace off "$@"
