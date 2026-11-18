# MRE api with the Realm-ownership fix of issue #398 (docs/development/betrieb.md §11.7; Auftrag des Projektinhabers,
# 2026-11-18: „Ein Client darf Datensätze nicht durch Übermittlung einer anderen `realmId` in einen fremden Bestand
# verschieben. Bestandszugehörigkeit aus dem autorisierten Kontext ableiten …“).
#
# Built like deploy/mre-pdfgenerator (issue #396): the base is the pinned MRE image itself (same commit and digest as the
# other MRE images of docker-compose.yml, checked by .github/scripts/image-pin-check.sh). Nothing is installed or built:
# only the file of realm-398.patch is replaced, everything else of the image stays as it is. Built by docker compose,
# never pushed to a registry.
#
# .github/scripts/mre-overlay-check.sh pins this file as a whole: only this FROM, the checksum line and one same-path
# COPY per file of the patch are allowed; any other instruction makes CI red.
#
# Remove the overlay with the MRE upgrade (VC-X-06) once upstream drops realmId from the body too (MRE 1.0.0 does not for
# properties). Rollback point: the plain pinned image (betrieb.md §11.7).
FROM ghcr.io/microrealestate/microrealestate/api:479d0ad703436071b64dfdf4e48321c121d8efb5@sha256:e764969e031f0b5efa2e104bce4b74f4f7e02982be4174cd6fc4e7f2b9083a92

# The patched file fits exactly this original: the build fails if the base image holds anything else there.
RUN --mount=type=bind,source=originals.sha256,target=/tmp/originals.sha256 sha256sum -c /tmp/originals.sha256

# Owner and mode as in the base image (root, 0755).
COPY --chown=0:0 --chmod=0755 services/api/src/routes.js services/api/src/routes.js
