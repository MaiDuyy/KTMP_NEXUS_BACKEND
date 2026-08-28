FROM node:20-alpine AS builder

WORKDIR /app/services/voice-service

COPY services/voice-service/package*.json ./
RUN npm ci --ignore-scripts

COPY services/voice-service/ ./
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS production

WORKDIR /app
RUN apk add --no-cache wget
RUN addgroup -g 1001 -S nodejs && adduser -S voice -u 1001

COPY --from=builder /app/services/voice-service/dist ./dist
COPY --from=builder /app/services/voice-service/node_modules ./node_modules
COPY --from=builder /app/services/voice-service/package.json ./package.json

USER voice
EXPOSE 3035
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:3035/healthz || exit 1

CMD ["node", "dist/index.js"]
