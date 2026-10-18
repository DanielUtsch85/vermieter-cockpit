# DE backend image. Build context: repository root
#   docker build -f services/de-backend/Dockerfile .
# Yarn is the release pinned in the repository (.yarn/releases), as in MRE.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY .yarn/releases .yarn/releases
COPY .yarn/plugins .yarn/plugins
COPY services/de-backend/package.json services/de-backend/
RUN node .yarn/releases/yarn-3.3.0.cjs install --immutable
COPY services/de-backend services/de-backend
RUN node .yarn/releases/yarn-3.3.0.cjs workspace @vermieter-cockpit/de-backend build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY .yarn/plugins .yarn/plugins
COPY services/de-backend/package.json services/de-backend/
RUN node .yarn/releases/yarn-3.3.0.cjs workspaces focus @vermieter-cockpit/de-backend --production \
  && node .yarn/releases/yarn-3.3.0.cjs cache clean --all
COPY --from=build /app/services/de-backend/dist services/de-backend/dist
WORKDIR /app/services/de-backend
USER node
EXPOSE 8090
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8090) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
