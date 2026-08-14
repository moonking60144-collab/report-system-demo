#!/usr/bin/env bash
# =============================================================================
# Ragic Report Backend Local Test Launcher (Mac / Linux)
# - 對應 run-backend-local.cmd 的 Unix 版
# - 預設 PORT=3300，避開正式 backend/proxy 使用的 3000
# - CORS_ORIGIN 預設同時允許 http://localhost:5174 和 http://127.0.0.1:5174
#   （Vite 有時 bind localhost、有時 bind 127.0.0.1，看 OS / network config）
# =============================================================================

set -euo pipefail

BACKEND_NPM_SCRIPT="${1:-dev}"
case "$BACKEND_NPM_SCRIPT" in
  dev|demo) ;;
  *)
    echo "[ERROR] Unsupported backend mode: $BACKEND_NPM_SCRIPT (expected dev or demo)" >&2
    exit 1
    ;;
esac

# 切到 backend/ 目錄（script 在 專案根/scripts/ 下，往上一層是專案根，再進 backend）
cd "$(dirname "$0")/../backend"

# Node 版本檢查（baseline Node 20）
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

# 依賴
if [ ! -d node_modules ]; then
  echo "[INFO] node_modules not found, running npm ci..."
  npm ci
fi

# 本機 dev override（不影響正式 .env 內值）
export PORT="${PORT:-3300}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5174,http://127.0.0.1:5174}"

# Port 占用檢查
if lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  PID_LIST="$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t)"
  echo "[ERROR] Port $PORT 已被佔用 (PID: $PID_LIST)" >&2
  echo "[HINT] 用 kill $PID_LIST 釋放或改 PORT=3301 ./scripts/run-backend-local.sh" >&2
  exit 1
fi

echo "[INFO] Backend dir: $(pwd)"
echo "[INFO] PORT=$PORT"
echo "[INFO] CORS_ORIGIN=$CORS_ORIGIN"
echo "[INFO] Starting backend with npm run $BACKEND_NPM_SCRIPT..."

npm run "$BACKEND_NPM_SCRIPT"
