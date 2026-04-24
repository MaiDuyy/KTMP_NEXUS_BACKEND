FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

RUN mkdir -p packages/shared services/stats-service

COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
RUN cd packages/shared && npm install --production --legacy-peer-deps

COPY services/stats-service/package*.json ./services/stats-service/

WORKDIR /app/services/stats-service
RUN npm install --legacy-peer-deps

COPY services/stats-service/ ./

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

COPY --from=builder /app/services/stats-service/dist ./dist
COPY --from=builder /app/services/stats-service/node_modules ./node_modules
COPY --from=builder /app/services/stats-service/package*.json ./
COPY --from=builder /app/services/stats-service/prisma ./prisma

RUN mkdir -p ../packages/shared
COPY --from=builder /app/packages/shared ../packages/shared

USER nodejs

EXPOSE 3015

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3015/healthz || exit 1

CMD ["node", "dist/index.js"]
