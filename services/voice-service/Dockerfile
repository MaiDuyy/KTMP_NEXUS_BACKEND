FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy shared package source
COPY packages/shared ./packages/shared
# Copy voice-service source
COPY services/voice-service ./services/voice-service

# Build shared package
WORKDIR /app/packages/shared
RUN npm ci && npm run build && npm prune --omit=dev

# Build voice-service
WORKDIR /app/services/voice-service
RUN npm ci
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS production

WORKDIR /app
RUN apt-get update && apt-get install -y wget && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1001 nodejs && useradd -m -u 1001 -g nodejs voice

# Copy shared package (needed at runtime by file: dependency)
COPY --from=builder /app/packages/shared /app/packages/shared

# Copy voice-service
COPY --from=builder /app/services/voice-service/dist ./services/voice-service/dist
COPY --from=builder /app/services/voice-service/node_modules ./services/voice-service/node_modules
COPY --from=builder /app/services/voice-service/package.json ./services/voice-service/package.json
COPY --from=builder /app/services/voice-service/package-lock.json ./services/voice-service/package-lock.json

WORKDIR /app/services/voice-service

USER voice
EXPOSE 3035
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:3035/healthz || exit 1

CMD ["node", "dist/index.js"]
