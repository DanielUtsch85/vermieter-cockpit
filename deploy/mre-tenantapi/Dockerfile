# MRE tenantapi with the exact e-mail match of issue #398 (docs/development/betrieb.md §11.8; Auftrag des
# Projektinhabers, 2026-11-18: „E-Mail-Adressen werden als ungefilterte reguläre Ausdrücke verwendet. Auf exakten,
# fachlich passenden Vergleich umstellen und bestandsübergreifende Zugriffe verhindern.“).
#
# Built like deploy/mre-pdfgenerator (issue #396): the base is the pinned MRE image itself (same commit and digest as the
# other MRE images of docker-compose.yml, checked by .github/scripts/image-pin-check.sh). Nothing is installed or built:
# only the compiled file of realm-398.patch is replaced. The image is distroless (no shell, no sha256sum), so the
# checksum line runs the image's own node. Built by docker compose, never pushed to a registry.
#
# .github/scripts/mre-overlay-check.sh pins this file as a whole: only this FROM, the checksum line and one same-path
# COPY per file of the patch are allowed; any other instruction makes CI red.
#
# Remove the overlay with the MRE upgrade (VC-X-06): MRE 1.0.0 compares the address exactly. Rollback point: the plain
# pinned image (betrieb.md §11.8).
FROM ghcr.io/microrealestate/microrealestate/tenantapi:479d0ad703436071b64dfdf4e48321c121d8efb5@sha256:cb41ee6f5ef823a1de726ae19327e8618ea68bd08ea721ba85a31ef740443ec9

# The patched file fits exactly this original: the build fails if the base image holds anything else there.
RUN --mount=type=bind,source=originals.sha256,target=/tmp/originals.sha256 ["/nodejs/bin/node", "-e", "const fs = require('fs'), crypto = require('crypto'); let bad = 0; for (const line of fs.readFileSync('/tmp/originals.sha256', 'utf8').split(String.fromCharCode(10)).filter(Boolean)) { const [sum, file] = line.split(' ').filter(Boolean); const ok = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sum; console.log(file + ': ' + (ok ? 'OK' : 'FAILED')); if (!ok) bad = 1; } process.exit(bad);"]

# Owner and mode as in the base image (root, 0644).
COPY --chown=0:0 --chmod=0644 services/tenantapi/dist/controllers/tenants.js services/tenantapi/dist/controllers/tenants.js
