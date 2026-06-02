# Ragic 報工系統 — Demo 版

> 內網生產用的工廠報工管理系統，原為自有部署，本 repo 已加入 **Demo Mode**：上游 Ragic SaaS 替換成記憶體假倉，可以 zero-config 在本機完整啟動。

技術棧：**React 19 + Vite 7 + AntD 6** 前端／**Express 4 + TypeScript 5.9 + Node 20 + SQLite** 後端。

---

## 30 秒啟動

需要 Node 20+。

```bash
# 後端
cd backend
npm install
npm run demo

# 另開 terminal
cd frontend
npm install
npm run dev
```

打開 [http://localhost:5173](http://localhost:5173)，右上角會看到「DEMO MODE」徽章，列表已預載 80 筆假工令、約 400 筆報工列、150 筆停機紀錄。

> 啟動時 80 筆工令與 6 條 linked source 表（機台 / 操作員 / 工序）會 deterministic 生成。重啟服務會回到初始 fixture。

---

## 核心技術亮點

這套系統是給工廠作業員 24 小時運作的內網生產系統。Demo 保留了下面所有機制（除了上游 Ragic 改成 mock），可以在面試現場一邊操作 UI 一邊講設計考量。

### 上游治理（[backend/src/infra/](backend/src/infra/)）
- **Token bucket 全域限流** — `RAGIC_GLOBAL_RATE_PER_SECOND` + `BURST_CAPACITY`，4 條 lane（user / sync / background / write）共用同一個 bucket，避免 22 個 slot burst 打爆上游
- **多 lane scheduler** — user / sync / background / write 各自獨立 concurrency，背景任務不會擠掉使用者請求
- **Circuit breaker** — 連續失敗 N 次 cooldown，retry 移出 lane（背壓不阻塞 slot）
- **Read/Write retry** — 分讀寫策略，read 可重試、create 不重試（避免重複建立）

### 讀取分層（[backend/src/services/work-report/](backend/src/services/work-report/)）
- **三層快取**：node-cache（記憶體）+ full snapshot cache（檔案）+ SQLite read model
- **Preview-first**：列表預設只讀主表欄位、面板互動才 on-demand full hydration
- **Stale-while-revalidate** 模式 + 啟動預熱（demo 下關閉）

### 寫入一致性
- **Idempotency**：`x-client-mutation-id` 透過 `clientRowKey` 對應 Ragic rowId，重送同 ID 不會重複建立 — 見 [backend/src/services/workReportService.ts](backend/src/services/workReportService.ts)
- **Form 16 ↔ Form 104/105 子表連動**：報工列建立在 Form 16 (停機紀錄)，由 Ragic workflow 自動推回工令子表；mock 在 [backend/src/ragic/mockClient.ts](backend/src/ragic/mockClient.ts) 模擬同樣的 propagation 語意
- **Write verify**：create 完立刻讀回比對，欄位不一致就自動 DELETE 止血（避免 orphan 種子）
- **Post-create polling**：拿到 form 16 rowId 後輪詢工令子表確認 row 出現再回應

### 即時推送（[backend/src/events/realtimeEventBus.ts](backend/src/events/realtimeEventBus.ts)）
- Server-Sent Events 全域 bus，每次 mutation 發布 form / row update 事件
- 前端 [useWorkReportListDataSync](frontend/src/features/work-report/hooks/useWorkReportListDataSync.ts) 自動 reconnect、去重、deferred refresh

### 觀測性 / 開發者模式
- 後端結構化日誌（Pino）+ 全棧 boot/deploy version
- 前端 [Developer Contract](frontend/src/features/work-report/debug/workReportDeveloperContract.ts) — ui / api / task / realtime / navigation 事件契約全紀錄
- 診斷面板可即時查 hydration source、cache state、SSE 連線、SQLite snapshot age

### 認證 / 多裝置
- **無密碼、IP 黑名單** — 工廠固定設備 + admin 可即時封鎖異常裝置（HTTP 423 語意化）
- `x-client-id` + `x-tab-id` 多維追蹤，同機多 tab 可獨立識別
- env-fallback admin + scrypt 密碼雜湊 + 多帳號管理（[backend/src/services/userManagementService.ts](backend/src/services/userManagementService.ts) 等）

### 資料治理
- **Record audit log**：每筆 update / delete 全量前後快照、操作人、時戳，前端 UI 可看歷史
- **Form 16 孤兒清理**：背景週期掃 createdAt > 10 分鐘且符合條件的記錄做 soft delete（demo 下關閉）

---

## Demo 模式怎麼運作

| 元件 | 真實版 | Demo 版 |
|---|---|---|
| Ragic 讀寫 | HTTPS → `demo.local/...` | 記憶體 Map，毫秒回應 |
| SQLite read model | 啟動同步 | 仍可用，但預設不預載（避免冷啟動延遲）|
| Token bucket / scheduler | 真正排程 | 仍運作，stats 可從 [debug clients](backend/src/routes/debugClients.ts) 看到 |
| SSE 推送 | 真實 | 真實 |
| Idempotency | clientRowKey ↔ Ragic ID | clientRowKey ↔ mock ID |
| Form 16 連動 | Ragic workflow | mockClient.propagateForm16ToParentSubtable |
| 預熱 / 自動同步 | 啟用 | 預設關閉（無外部 SaaS 可同步） |

關鍵實作：
- **替換點**：[backend/src/ragic/client.ts](backend/src/ragic/client.ts) 出口處 `createRagicClient()` 依 `env.DEMO_MODE` 決定 export `RagicClient` 還是 `MockRagicClient`
- **業務邏輯零修改**：所有 routes / services / hooks 都用同一個 `ragicClient`，沒人知道底下是 mock 還是 SaaS
- **環境變數注入**：[backend/src/config/env.ts](backend/src/config/env.ts) 在 `DEMO_MODE=true` 時自動填入必填的 Ragic env 預設值，免設定即可啟動

---

## 專案結構

```text
ragic-report/
├── backend/
│   ├── src/
│   │   ├── ragic/            ← 上游客戶端（含 mockClient + demoFixture）
│   │   ├── routes/           ← Express 路由
│   │   ├── services/         ← 業務邏輯（read/write/idempotency/recalculate）
│   │   ├── infra/            ← scheduler / circuit breaker / retry
│   │   ├── storage/sqlite/   ← SQLite read model
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
│       └── i18n/             ← 中英繁簡
└── scripts/                  ← 部署打包腳本
```

---

## 主要 API

完整列表見 [backend/src/routes/](backend/src/routes/)；幾條最有代表性的：

```
GET    /api/forms/104/reports                  工令列表（preview）
GET    /api/forms/104/reports/full             全量資料（含子表）
GET    /api/forms/104/reports/facets           分面分析
GET    /api/forms/104/reports/:entryId         單筆 + 子表
POST   /api/forms/104/reports/:entryId         新增報工列
PUT    /api/forms/104/reports/:entryId/:rowId  更新
DELETE /api/forms/104/reports/:entryId/:rowId  刪除
POST   /api/forms/104/sync                     觸發 SQLite 同步
GET    /api/events                             SSE 即時事件流
GET    /api/health                             健康 + demoMode flag
```

Demo 下可直接 curl 試（不需驗證 header）：
```bash
curl http://localhost:3000/api/forms/104/reports?limit=5
```

---

## Deploy to Render（推薦 — 不用信用卡）

repo 內有 [render.yaml](render.yaml) Blueprint，**zero CLI**。流程：

1. 在 [dashboard.render.com](https://dashboard.render.com) 註冊（GitHub OAuth，免信用卡）
2. New + → Blueprint → 連結這個 GitHub repo
3. Render 讀 [render.yaml](render.yaml)，自動建立 web service + 隨機產生 `DEMO_RESET_KEY` 並注入
4. 等首次 build（~5-10 分鐘，sqlite3 native module 要編）
5. Live URL：`https://ragic-report-demo-<hash>.onrender.com`

之後 push 到 `main` 自動重 build + redeploy。

注意點：
- Free tier 容器 idle 15 分鐘自動 sleep，下次訪問 cold start ~30-50 秒（給面試官第一次點要心理準備）
- Filesystem 是 ephemeral，SQLite / JSON state 每次重啟重設 — 但 demo mode 本來就 zero-config 重啟回 fixture，沒差
- `DEMO_RESET_KEY` 在 Render dashboard → Environment 查（前端 FaultInjectionPanel 第一次展開會跟你要）

---

## Deploy to Fly.io（要綁信用卡）

把 demo 版直接丟上公開網址（單一服務、SPA + API 同源、SQLite 落地在 Fly volume）。前置：裝 [flyctl](https://fly.io/docs/flyctl/install/) 並 `fly auth login`。

```bash
# 1. 第一次部署：建立 app（會問名字，並用 repo 的 fly.toml 當範本；別讓它自動 deploy）
fly launch --no-deploy --copy-config

# 2. 建持久 volume（SQLite + 各種 JSON state 都寫進 /data）
fly volumes create data --region nrt --size 1

# 3. 設定 secrets — DEMO_RESET_KEY 用來呼叫重置 fixture endpoint（自行決定強度）
fly secrets set DEMO_RESET_KEY="$(openssl rand -hex 16)"

# 4. 部署
fly deploy

# 5. 開啟瀏覽器看結果
fly open
```

部署後：

- `fly status` 看機器狀態、`fly logs` 看 boot log（注意 `event: listen` 跟 `frontend-static-enabled`）
- 容器內 `/data` 由 volume 提供，重啟 / 重新部署都會保留 SQLite + cache
- `fly.toml` 預設 `auto_stop_machines = true` + `min_machines_running = 0`，沒流量時自動停機省錢；下次請求會冷啟（~5 秒）
- 多 region / 多機器擴展前要先確認 SQLite write target 只有一台機器寫（Fly volume 不能共享）

---

## 真實版部署

> 以下是給原始 IT 維護者看的；面試 demo 用不到。

打包腳本：
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-server-package.ps1
```

產物在 `.deploy/<時間戳>-ragic-report-updated-version-sever/`。
複製到 Windows server（保留現場 `.env`、`.cache`、`.data`），`npm run start` 啟動。

開發機跑真實版（要 `.env` 含 `RAGIC_API_KEY` 等）：
```bash
cd backend && npm run dev
cd frontend && npm run dev
```

---

## 排查

- **列表資料怪**：先看 `GET /api/forms/104/reports/full?refresh=1` 跟 SQLite sync 狀態
- **建立 / 編輯 hang**：看 backend log 的 `lane` / `circuit-breaker` 事件、`/api/debug/clients` 看 in-flight
- **SSE 沒推送**：看 `GET /api/events` 是否 200，前端 hook 的 reconnect 狀態
- **DEMO 徽章不見**：`curl http://localhost:3000/api/health` 看 `demoMode` 是否 true
