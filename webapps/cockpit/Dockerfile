# Cockpit UI image, the `cockpit-ui` service of docker-compose.proxy.yml (Entscheidung des Projektinhabers, 2026-11-10,
# zu #319 F3 (a)). Build context: repository root
#   docker build -f webapps/cockpit/Dockerfile .
#
# Two stages: Node builds the static app (the Node image and digest of services/de-backend/Dockerfile), and the Caddy
# image of docker-compose.proxy.yml, same tag and digest, serves it with webapps/cockpit/Caddyfile. No Node in the
# image that runs. .github/scripts/image-pin-check.sh checks both pins and that they equal the other two places.

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY .yarn/releases .yarn/releases
COPY .yarn/plugins .yarn/plugins
# Every workspace manifest of the root's `workspaces`, or --immutable fails. The backend's manifest only: the cockpit
# imports nothing but types from it (`import type … from '@vermieter-cockpit/de-backend/client-contract'`), which the
# build erases; the type check runs in CI (`yarn typecheck`), not here.
COPY services/de-backend/package.json services/de-backend/
COPY webapps/cockpit/package.json webapps/cockpit/
RUN node .yarn/releases/yarn-3.3.0.cjs install --immutable
# The design tokens live in the docs and are imported by src/index.css (the one file of docs/ that .dockerignore lets in).
COPY docs/development/design-tokens.css docs/development/
COPY webapps/cockpit webapps/cockpit
RUN node .yarn/releases/yarn-3.3.0.cjs workspace @vermieter-cockpit/cockpit build

FROM caddy:2.11.9@sha256:0c2243efcf437ab7f7a978f1027fcf0d4f9be8a75df27b1b3fbc5dbe0ffa8cf0
COPY webapps/cockpit/Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
COPY --from=build /app/webapps/cockpit/dist /srv/cockpit
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/cockpit/"]
