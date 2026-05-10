FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

RUN mkdir -p packages/shared services/ws-gateway protos
COPY protos ./protos

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
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl wget

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

COPY --from=builder /app/services/ws-gateway/dist ./dist
COPY --from=builder /app/services/ws-gateway/node_modules ./node_modules
COPY --from=builder /app/services/ws-gateway/package*.json ./

RUN mkdir -p protos
COPY --from=builder /app/protos ./protos


RUN mkdir -p ../packages/shared
COPY --from=builder /app/packages/shared ../packages/shared

USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/healthz || exit 1

CMD ["node", "dist/index.js"]
