FROM oven/bun:1-slim

WORKDIR /app

ENV BUN_CONFIG_NO_BUFFER=1
ENV NODE_ENV=production

# Workspace root manifest + lockfile first so this layer is cached when
# only source changes.
COPY package.json bun.lock ./

# Per-package manifests for workspace resolution. Copy them before sources
# so `bun install` can build the workspace graph from manifests alone.
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/interceptor/package.json packages/interceptor/
COPY packages/protocols/package.json packages/protocols/
COPY packages/provider/package.json packages/provider/
COPY packages/provider-azure/package.json packages/provider-azure/
COPY packages/provider-copilot/package.json packages/provider-copilot/
COPY packages/provider-custom/package.json packages/provider-custom/
COPY packages/responses-store/package.json packages/responses-store/
COPY packages/shared-cache/package.json packages/shared-cache/
COPY packages/shared-http/package.json packages/shared-http/
COPY packages/translate/package.json packages/translate/

RUN bun install --frozen-lockfile

# Source
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

# Dashboard bundle stubs — vnext has no dashboard build pipeline yet, but the
# /dashboard route imports `./dist/dashboard.{js,css}.txt`. The smoke target
# is /v1/*, not the UI; empty stubs keep the import graph resolvable.
RUN mkdir -p apps/gateway/src/shared/edge/ui-pages/dashboard-app/dist && \
    : > apps/gateway/src/shared/edge/ui-pages/dashboard-app/dist/dashboard.js.txt && \
    : > apps/gateway/src/shared/edge/ui-pages/dashboard-app/dist/dashboard.css.txt

# Local sqlite lives under /data so it can be mounted as a volume and
# survive container restarts. entry-bun.ts reads VNEXT_DB_PATH.
RUN mkdir -p /data
ENV VNEXT_DB_PATH=/data/vnext.sqlite

EXPOSE 41415

WORKDIR /app/apps/gateway
CMD ["bun", "run", "entry-bun.ts"]
