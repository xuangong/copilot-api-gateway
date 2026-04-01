FROM oven/bun:1-slim

WORKDIR /app

# Disable output buffering for real-time logs
ENV BUN_CONFIG_NO_BUFFER=1
ENV NODE_ENV=production

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Create data directory
RUN mkdir -p .data

# Expose port
EXPOSE 41414

# Run local server
CMD ["bun", "run", "src/local.ts"]
