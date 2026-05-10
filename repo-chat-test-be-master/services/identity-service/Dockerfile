FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

RUN mkdir -p packages/shared services/identity-service protos
COPY protos ./protos
# Copy shared package files and install
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
RUN cd packages/shared && npm install --production --legacy-peer-deps

# Copy identity-service package files and install
WORKDIR /app/services/identity-service
COPY services/identity-service/package*.json ./
RUN npm install --legacy-peer-deps

# Copy source code (.dockerignore prevents local node_modules from being copied)
COPY services/identity-service/ ./

# Clean prisma cache and generate clients
RUN rm -rf node_modules/.prisma && npm run prisma:generate
RUN npm run build

# --- Stage Production ---
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl wget

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built files from builder
COPY --chown=nodejs:nodejs --from=builder /app/services/identity-service/dist ./dist
COPY --chown=nodejs:nodejs --from=builder /app/services/identity-service/node_modules ./node_modules
COPY --chown=nodejs:nodejs --from=builder /app/services/identity-service/package*.json ./
COPY --chown=nodejs:nodejs --from=builder /app/services/identity-service/prisma ./prisma

# Copy protos needed for gRPC
RUN mkdir -p protos
COPY --chown=nodejs:nodejs --from=builder /app/protos ./protos

RUN mkdir -p ../packages/shared
COPY --chown=nodejs:nodejs --from=builder /app/packages/shared ../packages/shared

USER nodejs

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3010/healthz || exit 1

CMD ["node", "dist/index.js"]