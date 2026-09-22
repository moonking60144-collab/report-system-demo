# 開發、API 與驗證

[返回首頁](../README.md) · [架構細節](architecture.md) · [AI 與 STT 設定](ai-setup.md)

## 本機啟動與故障展示

首頁啟動指令使用 Bash 腳本，適用 macOS／Linux；Windows 可在 WSL 的 Linux 環境內執行。需有 Node.js、npm 與 `lsof`。後端最低要求 Node 20.18.1，但目前前端 Vite 的 engine 要求為 `^20.19.0 || >=22.12.0`，因此完整 Demo 請使用 Node 20.19.x 或 22.12+。

根目錄先執行 `npm install`，再執行 `npm run demo`。子專案缺少 `node_modules` 時，啟動腳本會執行 `npm ci`；第一次安裝所需時間依網路與環境而異。預設前端為 `5174`、後端為 `3300`。

要操作右下「故障模擬」，可在啟動時指定自己的本機展示密鑰：

```bash
DEMO_RESET_KEY=local-interview-demo npm run demo
```

展開面板並在 `X-Demo-Key` 提示中輸入同一值。上述值僅作本機範例。面板提供「啟用故障注入」、「上游失敗率」、「上游延遲」及「寫入時掉欄位機率」。每次只改一個條件，完成展示後關閉故障注入。

- 先在正常狀態新增一筆合成報工，觀察任務中心結果，建立比較基準。
- 開啟上游延遲後，再送出相同類型的操作，對照任務狀態與後端日誌。
- 失敗率或掉欄位測試需搭配實際上游請求／寫入；只讀 SQLite 快取不一定會觸發故障。
- 關閉故障注入後，再驗證新任務；關閉開關本身不代表先前失敗的任務已成功。

控制端點與驗證方式見 [demoFaultInjection.ts](../backend/src/routes/demoFaultInjection.ts)。

## 專案結構

```text
report-system-demo/
├── backend/
│   ├── src/
│   │   ├── ragic/            ← 上游客戶端（含 mockClient + demoFixture）
│   │   ├── routes/           ← Express 路由
│   │   ├── services/         ← 業務邏輯（read/write/idempotency/recalculate）
│   │   ├── infra/            ← scheduler / circuit breaker / retry
│   │   ├── storage/sqlite/   ← SQLite read model
│   │   ├── storage/meeting-minutes/ ← Meeting durable jobs / library
│   │   ├── storage/efficiency-report/ ← 報表版本與 artifact metadata
│   │   ├── workers/          ← Meeting lease/heartbeat worker
│   │   ├── events/           ← SSE 推送
│   │   ├── observability/    ← 日誌 / presence / boot state
│   │   └── server.ts
│   └── .env.demo             ← Demo 環境範例（npm run demo 已自動注入）
├── frontend/
│   └── src/
│       ├── api/              ← axios 工廠
│       ├── components/       ← 共用元件（含 DemoBadge）
│       ├── features/work-report/
│       │   ├── pages/        ← list / detail
│       │   ├── components/   ← 表格 / 過濾 / 分析 / 同步進度
│       │   ├── hooks/        ← 100+ 個專責 hook（dataPipeline / refresh / events）
│       │   └── debug/        ← 開發者模式契約
│       ├── features/meeting-minutes/ ← 錄音、逐字稿、會議記錄與 library
│       ├── features/dev/     ← Definitions explorer 與 provider-based Dev AI
│       └── i18n/             ← 中英繁簡
├── services/meeting-stt/     ← 隔離的 FastAPI + faster-whisper service
├── ragic-definitions/        ← 公開合成 Definitions fixture
├── .github/workflows/ci.yml  ← Node/Python 三條驗證 job
└── scripts/                  ← 本機啟動腳本
```

---

## 主要 API

完整列表見 [backend/src/routes/](../backend/src/routes/)：

```
GET    /api/forms/901/reports                  工令列表（preview）
GET    /api/forms/901/reports/full             全量資料（含子表）
GET    /api/forms/901/reports/facets           分面分析
GET    /api/forms/901/reports/:entryId         單筆 + 子表
POST   /api/forms/901/reports/:entryId         新增報工列（accepted task）
PUT    /api/forms/901/reports/:entryId/:rowId  更新
DELETE /api/forms/901/reports/:entryId/:rowId  刪除（accepted task）
POST   /api/forms/901/reports/:entryId/batch-create  批次新增
POST   /api/forms/901/reports/:entryId/batch-delete   批次刪除
GET    /api/forms/901/tasks                    任務中心列表
GET    /api/downtime/tasks                     停機新增任務列表
GET    /api/downtime/efficiency-reports        效率報表版本歷史
GET    /api/downtime/export/monthly-csv        產生／下載月報 CSV
GET    /api/downtime/export/analysis-xlsx      產生／下載分析 XLSX
POST   /api/meetings/recordings                建立錄音 session
PUT    /api/meetings/recordings/:id/tracks/:source/chunks/:seq  冪等上傳音訊 chunk
POST   /api/meetings/recordings/:id/process    建立音訊處理 job
POST   /api/meetings/recordings/:id/transcriptions  建立逐字稿 job
POST   /api/meetings/recordings/:id/minutes    建立會議記錄 job
GET    /api/integrations/ragic-definitions/state     Definitions source revision
GET    /api/integrations/ragic-definitions/snapshot  Definitions 壓縮快照
POST   /api/forms/901/sync                     觸發 SQLite 同步
GET    /api/events                             SSE 即時事件流
GET    /api/health                             健康 + demoMode flag
```

Demo 下可直接 curl 試：
```bash
curl 'http://localhost:3300/api/forms/901/reports?limit=5'
```

---

## 驗證矩陣

```bash
# Backend：型別、編譯、route/service/storage/worker 測試
cd backend
npm run typecheck
npm run build
npm test

# Frontend：lint、unit/component、production bundle
cd ../frontend
npm run lint
npm test
npm run build

# Meeting STT：fake engine，不下載模型、不需要 GPU
cd ../services/meeting-stt
uv sync --locked --python 3.11 --dev
uv run pytest
```

GitHub Actions 會分別執行 `meeting-stt`、`backend`、`frontend` 三個 job。測試 backend 強制使用獨立暫存 SQLite 與不可連線的假 upstream host，避免開發機 `.env`、本機服務或正式上游污染結果。
