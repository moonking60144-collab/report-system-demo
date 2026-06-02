# syntax=docker/dockerfile:1.7
# Multi-stage build for Fly.io single-service deployment.
# Frontend (Vite) + Backend (Express/TS) built separately, then combined
# into one runtime image that serves SPA + API from the same Node process.

# ---------------------------------------------------------------------------
# Stage 1 — Frontend builder
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# Single-service deploy: API lives on the same origin (relative /api),
# so VITE_API_BASE_URL stays unset and apiClient falls back to "/api".
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Backend builder
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS backend-builder
WORKDIR /app/backend

# sqlite3 is a native module — needs python3 + build-essential to compile
# during `npm ci` (no prebuilt binary for some node/glibc combos).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
RUN npm run build

# Separate production install so we ship only runtime deps in stage 3.
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 3 — Runtime
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app/backend

# sqlite3 native module needs libstdc++ at runtime; bookworm-slim already has
# it, but install the minimal runtime libs explicitly so future base-image
# bumps don't silently break.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=3000 \
    SERVE_FRONTEND_FROM_BACKEND=true \
    FRONTEND_STATIC_DIR=/app/frontend/dist \
    DEMO_MODE=true \
    SQLITE_DB_FILE=/data/work-report-read-model.v1.sqlite3 \
    REPORT_FULL_CACHE_FILE=/data/reports-104-full.v1.json \
    CREATE_TASK_STORE_FILE=/data/create-report-tasks.v1.json \
    RAGIC_CALLBACK_TASK_STORE_FILE=/data/ragic-callback-tasks.v1.json \
    WORK_REPORT_TASK_REGISTRY_STORE_FILE=/data/work-report-task-registry.v1.json \
    SYSTEM_NOTICE_FILE=/data/system-notice.v1.json

COPY --from=backend-builder /app/backend/package.json ./package.json
COPY --from=backend-builder /app/backend/node_modules ./node_modules
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# /data is mounted from a Fly volume; create it so first boot before mount
# (e.g. local `docker run` without -v) still works.
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "dist/server.js"]
