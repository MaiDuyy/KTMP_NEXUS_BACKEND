FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

RUN mkdir -p packages/shared services/messaging-service protos
COPY protos ./protos
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
RUN cd packages/shared && npm install --production --legacy-peer-deps

COPY services/messaging-service/package*.json ./services/messaging-service/

WORKDIR /app/services/messaging-service
RUN npm install --legacy-peer-deps

COPY services/messaging-service/ ./

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl wget

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

COPY --from=builder /app/services/messaging-service/dist ./dist
COPY --from=builder /app/services/messaging-service/node_modules ./node_modules
COPY --from=builder /app/services/messaging-service/package*.json ./
COPY --from=builder /app/services/messaging-service/prisma ./prisma

# Copy protos needed for gRPC
RUN mkdir -p protos
COPY --from=builder /app/protos ./protos

RUN mkdir -p ../packages/shared
COPY --from=builder /app/packages/shared ../packages/shared

USER nodejs

EXPOSE 3020

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3020/healthz || exit 1

CMD ["node", "dist/index.js"]
