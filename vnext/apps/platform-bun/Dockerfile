FROM oven/bun:1-slim

WORKDIR /app

ENV BUN_CONFIG_NO_BUFFER=1
ENV NODE_ENV=production

# Build context is ./vnext (set in docker-compose.vnext.yml). All COPY
# paths below are relative to vnext/.
COPY package.json bun.lock ./

# Per-package manifests for workspace resolution. Copy them before sources
# so `bun install` can build the workspace graph from manifests alone.
COPY apps/platform-bun/package.json apps/platform-bun/
COPY apps/platform-cloudflare/package.json apps/platform-cloudflare/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/gateway/package.json packages/gateway/
COPY packages/platform/package.json packages/platform/
COPY packages/protocols/package.json packages/protocols/
COPY packages/service/package.json packages/service/
COPY packages/provider/package.json packages/provider/
COPY packages/provider-azure/package.json packages/provider-azure/
COPY packages/provider-copilot/package.json packages/provider-copilot/
COPY packages/provider-custom/package.json packages/provider-custom/
COPY packages/provider-sdf/package.json packages/provider-sdf/
COPY packages/responses-store/package.json packages/responses-store/
COPY packages/cache/package.json packages/cache/
COPY packages/http/package.json packages/http/
COPY packages/translate/package.json packages/translate/

RUN bun install --frozen-lockfile

# Source
COPY tsconfig.base.json tailwind.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

# Build the React dashboard bundle. Outputs land at
# packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist/dashboard.{js,css}.txt
# where page.ts imports them as text. The repo-checked-in .txt files are empty
# stubs so `bun test` works on a fresh clone without a build step.
RUN bun run build:ui

# Local sqlite lives under /data so it can be mounted as a volume and
# survive container restarts. server.ts reads VNEXT_DB_PATH.
RUN mkdir -p /data
ENV VNEXT_DB_PATH=/data/vnext.sqlite

EXPOSE 41415

WORKDIR /app/apps/platform-bun
CMD ["bun", "run", "src/server.ts"]
