@echo off
echo [OTT CHAT] Stopping Microservices Pipeline...

:: 1. Stop Docker Infrastructure
echo 🐳 Stopping Infrastructure (Postgres, Redis, NATS)...
docker compose down

:: 2. Kill Node processes
:: Note: This will stop all node processes. Use with caution if you have other node apps running.
echo 🔪 Terminating Node.js and TSX processes...
taskkill /F /IM node.exe /T >nul 2>&1

echo ✅ All services have been stopped.
pause
