FROM node:20-slim AS builder

WORKDIR /app

# Install OpenSSL for runtime compatibility
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create directory structure matching monorepo
RUN mkdir -p packages/shared services/ws-gateway

# Copy shared package first
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
RUN cd packages/shared && npm install --production --legacy-peer-deps

# Copy service package files
COPY services/ws-gateway/package*.json ./services/ws-gateway/

# Install dependencies
WORKDIR /app/services/ws-gateway
RUN npm install --legacy-peer-deps

# Copy service source
COPY services/ws-gateway/ ./

# Build
RUN npm run build

# Production stage
FROM node:20-slim AS production

WORKDIR /app

# Install OpenSSL for runtime
RUN apt-get update -y && apt-get install -y openssl wget && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nodejs

COPY --from=builder /app/services/ws-gateway/dist ./dist
COPY --from=builder /app/services/ws-gateway/node_modules ./node_modules
COPY --from=builder /app/services/ws-gateway/package*.json ./

RUN mkdir -p ../packages/shared
COPY --from=builder /app/packages/shared ../packages/shared

USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/healthz || exit 1

CMD ["node", "dist/index.js"]
