FROM node:20-slim AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

RUN mkdir -p packages/shared services/chat-service

COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
RUN cd packages/shared && npm install --production --legacy-peer-deps

COPY services/chat-service/package*.json ./services/chat-service/

WORKDIR /app/services/chat-service
RUN npm install --legacy-peer-deps

COPY services/chat-service/ ./

RUN npx prisma generate
RUN npm run build

FROM node:20-slim AS production

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apt-get update -y && apt-get install -y openssl wget && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nodejs

COPY --from=builder /app/services/chat-service/dist ./dist
COPY --from=builder /app/services/chat-service/node_modules ./node_modules
COPY --from=builder /app/services/chat-service/package*.json ./
COPY --from=builder /app/services/chat-service/prisma ./prisma

RUN mkdir -p ../packages/shared
COPY --from=builder /app/packages/shared ../packages/shared

USER nodejs

EXPOSE 3013

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3013/healthz || exit 1

CMD ["node", "dist/index.js"]
