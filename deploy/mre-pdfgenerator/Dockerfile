# MRE pdfgenerator with the realm fix backported (issue #396, backlog VC-X-82; docs/development/betrieb.md §11.7;
# Entscheidung des Projektinhabers, 2026-11-17: „Overlay-Backport: Eigenes kleines Image in unserem Repo: FROM dem
# gepinnten pdfgenerator-Image per Digest, darüber nur die gepatchten Dateien …“).
#
# The base is the pinned MRE image itself (same commit and digest as the other MRE images of docker-compose.yml, checked
# by .github/scripts/image-pin-check.sh). Nothing is installed or built: only the two files of realm-396.patch are
# replaced, everything else of the image (node, chromium, node_modules, templates, user 1000, WORKDIR /usr/app, CMD)
# stays as it is. Built by docker compose like de-backend, never pushed to a registry.
#
# Remove the overlay with the MRE upgrade (VC-X-06): MRE 1.0.0 carries the fix (microrealestate/microrealestate#273).
# Rollback point: the plain pinned image (betrieb.md §11.7).
FROM ghcr.io/microrealestate/microrealestate/pdfgenerator:479d0ad703436071b64dfdf4e48321c121d8efb5@sha256:05e614a8b5c534cae360e20df59e93a99a80afb0fb6afef127db388c08ef1c15

# The patched files fit exactly these originals: the build fails if the base image holds anything else there.
RUN --mount=type=bind,source=originals.sha256,target=/tmp/originals.sha256 sha256sum -c /tmp/originals.sha256

# Owner and mode as in the base image (data/ belongs to 1000, src/ to root; both files 0644).
COPY --chown=1000:0 --chmod=0644 services/pdfgenerator/data/index.js services/pdfgenerator/data/index.js
COPY --chown=0:0 --chmod=0644 services/pdfgenerator/src/routes/documents.js services/pdfgenerator/src/routes/documents.js
