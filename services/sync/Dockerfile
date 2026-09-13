# syntax=docker/dockerfile:1.7
# GeDe Sync & API service. Build from the monorepo root:
#   docker build --platform linux/arm64 -f services/sync/Dockerfile -t gede-sync:local .
# The image is one ESM bundle plus the SQL migrations; no node_modules at runtime.

# ---- build ---------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

# Workspace manifests first so the dependency layer caches across source edits.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/mail/package.json ./packages/mail/
COPY services/sync/package.json ./services/sync/
RUN npm ci -w services/sync -w packages/core -w packages/db -w packages/mail --include-workspace-root

COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY packages/mail ./packages/mail
COPY services/sync ./services/sync
ARG GEDE_VERSION
ENV GEDE_VERSION=${GEDE_VERSION}
RUN npm run build -w services/sync

# ---- runtime -------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/services/sync/dist ./
# RDS CA bundle for PGSSLMODE=verify-full (PGSSLROOTCERT=/app/rds-global-bundle.pem).
COPY infra/lib/rds-global-bundle.pem /app/rds-global-bundle.pem

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
