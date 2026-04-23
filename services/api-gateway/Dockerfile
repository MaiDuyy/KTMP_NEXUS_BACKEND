FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Create directory structure matching monorepo
RUN mkdir -p packages/shared services/api-gateway

# Copy shared package first (preserving relative path structure)
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
RUN cd packages/shared && npm install --production --legacy-peer-deps

# Copy service package files
COPY services/api-gateway/package*.json ./services/api-gateway/

# Install dependencies from service directory
WORKDIR /app/services/api-gateway
RUN npm install --legacy-peer-deps

# Copy service source
COPY services/api-gateway/ ./

# Build
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built files and node_modules
COPY --from=builder /app/services/api-gateway/dist ./dist
COPY --from=builder /app/services/api-gateway/node_modules ./node_modules
COPY --from=builder /app/services/api-gateway/package*.json ./

# Also need shared package in correct relative location
RUN mkdir -p ../packages/shared
COPY --from=builder /app/packages/shared ../packages/shared

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

# Start
CMD ["node", "dist/index.js"]
