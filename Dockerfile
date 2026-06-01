FROM oven/bun:1-slim

WORKDIR /app

# Disable output buffering for real-time logs
ENV BUN_CONFIG_NO_BUFFER=1
ENV NODE_ENV=production

# Copy package files
COPY package.json bun.lock ./

# Install dependencies (include dev — needed for build:ui)
RUN bun install --frozen-lockfile

# Download CDN assets at build time so the container works without internet
# access. Done BEFORE copying src so this layer is reused across src changes.
COPY scripts ./scripts
RUN mkdir -p src/assets/cdn && bun run scripts/download-cdn.ts

# Copy source code
COPY src ./src
COPY tsconfig.json tailwind.config.ts ./

# Build dashboard bundle (dist/ is gitignored, must be produced here)
RUN bun run build:ui

# Create data directory
RUN mkdir -p .data

# Expose port
EXPOSE 41414

# Run local server
CMD ["bun", "run", "src/local.ts"]
