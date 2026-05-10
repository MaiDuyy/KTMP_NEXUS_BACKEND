@echo off
echo [OTT CHAT] Starting Microservices Pipeline...

:: 1. Start Infrastructure
echo 🐳 Starting Infrastructure (Postgres, Redis, NATS)...
docker compose up -d postgres redis nats

:: 2. Start Services
echo 🔑 Starting Identity Service...
start "Identity Service" /d "services/identity-service" cmd /k "npm run dev"

echo 💬 Starting Messaging Service...
start "Messaging Service" /d "services/messaging-service" cmd /k "npm run dev"

echo 🌐 Starting API Gateway...
start "API Gateway" /d "services/api-gateway" cmd /k "npm run dev"

echo 🔌 Starting WS Gateway...
start "WS Gateway" /d "services/ws-gateway" cmd /k "npm run dev"

echo 📧 Starting Notification Service...
start "Notification Service" /d "services/notification-service" cmd /k "npm run dev"

echo 📁 Starting File Service...
start "File Service" /d "services/file-service" cmd /k "npm run dev"

echo ✅ All services are starting in separate windows.
pause
