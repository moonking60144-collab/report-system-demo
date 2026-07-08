#!/usr/bin/env bash
# =============================================================================
# Ragic Report Frontend Local Test Launcher (Mac / Linux)
# - 對應 run-frontend-local.cmd 的 Unix 版
# - VITE_API_BASE_URL 預設 http://localhost:3300/api（對應 run-backend-local.sh）
# - FRONTEND_PORT 預設 5174，避開一般 Vite default 5173
# =============================================================================

set -euo pipefail

# 切到 frontend/ 目錄（script 在 專案根/scripts/ 下，往上一層是專案根，再進 frontend）
cd "$(dirname "$0")/../frontend"

NODE_VER="$(node -v 2>/dev/null || echo 'NOT_FOUND')"
if [ "$NODE_VER" = "NOT_FOUND" ]; then
  echo "[ERROR] node 不在 PATH。請先 brew install node 或 nvm install 20" >&2
  exit 1
fi
echo "[INFO] Using Node: $NODE_VER"
case "$NODE_VER" in
  v20.*) ;;
  *) echo "[WARN] Project baseline is Node 20.x. Current: $NODE_VER (dev 仍會繼續)" ;;
esac

if [ ! -d node_modules ]; then
  echo "[INFO] node_modules not found, running npm ci..."
  npm ci
fi

# 本機 dev 沒設就用預設；若你 backend 跑其他 port，可覆寫 VITE_API_BASE_URL。
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://localhost:3300/api}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"

if lsof -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  PID_LIST="$(lsof -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN -t)"
  echo "[ERROR] Port $FRONTEND_PORT 已被佔用 (PID: $PID_LIST)" >&2
  echo "[HINT] 用 kill $PID_LIST 釋放或改 FRONTEND_PORT=5175 ./scripts/run-frontend-local.sh" >&2
  exit 1
fi

echo "[INFO] Frontend dir: $(pwd)"
echo "[INFO] VITE_API_BASE_URL=$VITE_API_BASE_URL"
echo "[INFO] FRONTEND_PORT=$FRONTEND_PORT"
echo "[INFO] Starting frontend in DEV mode..."

npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT"
