# Work Report / Downtime 資料流邊界

## 目的

這份文件固定 `work-report`、104/105 報工、Form 16 停機紀錄與 Ragic/SQLite/task registry 的資料流邊界。後續修改時先對照這裡，避免把不同 task shape、retry payload、read model 與 Ragic 寫入流程混在一起。

## Source of truth

- **Ragic 是業務資料寫入 source-of-truth。**
  - 新增、更新、刪除是否真的成功，以 Ragic 寫入結果與後端 post-write verify / callback / refresh 結果為準。
  - 前端不能用 polling timeout 自行判定 task failed。
- **SQLite 是 read model / projection。**
  - 可用於列表、明細快取、統計圖表、facet、snapshot 與 fallback 讀取。
  - 不可單獨作為 mutation gate；工令狀態、Ragic workflow / formula / action button side effect 仍需由後端 live read / worker precheck / post-write verify 處理。
- **`WorkReportTaskRegistryService` 是 UI-facing task status source。**
  - 前端查任務狀態應以 registry route 回傳為準。
  - local task map 只代表 worker runtime 狀態，不應成為前端可見狀態的唯一依據。
- **前端 `localStorage` 只保存本機 retry payload。**
  - retry payload 不寫入 task registry。
  - 不同 domain 的 retry store 不共用。

## 104 / 105 報工 mutation

### Shared entry mutation queue

- queue key 統一使用 `${formId}:${entryId}`。
- async create/update、batch create、single/batch delete、sync create/update、main-machine、close/reopen 都使用同一條 entry queue。
- 同一工令串行；不同工令仍可平行。
- 同步 HTTP mutation 若尚未開始且 server 已觀測到 client disconnect，queue 會跳過該 worker；Ragic write 一旦開始則不做假取消。
- update 與 delete 的 audit `beforeSnapshot` 必須在取得 entry queue 後、真正 mutation 前擷取。

### Async create / update

- `POST /api/forms/:formId/reports/:entryId?async=1`
- `PUT /api/forms/:formId/reports/:entryId/:rowId?async=1`
- 必須帶 `x-client-mutation-id`。
- queue key 使用：

```text
${formId}:${entryId}
```

- 同一工令的 create/update mutation 串行，避免 Ragic 黑盒寫入 race。
- `clientMutationId` 是單次 task attempt identity，用於 task-level dedupe；每次安全重送都建立新的 attempt id。
- async create 另以 `x-create-idempotency-key` 保存穩定的業務建立 key；同一筆 create retry 必須重用這個 key。舊 caller 未帶此 header 時，後端才向後相容地 fallback 到 `clientMutationId`。
- worker 狀態會同步到 `WorkReportTaskRegistryService`。
- 前端 104/105 retry payload 存在：

```text
frontend/src/features/work-report/taskRetryStore.ts
```

### Create 狀態預檢

- async create 不應用 stale timestamp 在 route 入口直接擋掉新增。
- worker 內會重試讀取工令狀態；若 Ragic 讀取持續失敗，worker 標 failed 並保留後端錯誤訊息。
- 前端只能顯示 registry 回報的 terminal 狀態；查詢逾時只能提示重新整理。
- create worker 若回報 `writeIndeterminate`，代表 Ragic 寫入結果無法確認；任務中心不可直接重送，必須先重新整理並確認資料是否已建立。

### Batch create / delete

- batch create 的每一列都必須帶自己的 `clientRowKey`，用於 durable row-level idempotency；舊 localStorage payload 若缺 key，必須 fail-closed，不可裸重送。
- batch delete 的外層 task 仍與其他 mutation 共用 `${formId}:${entryId}` queue，確保同一工令不與其他 mutation 交錯。
- batch delete worker 取得 entry queue 後，才以設定的 bounded concurrency 對多列送出 Ragic delete；這是同一 task 內的受控平行，不代表同一工令可同時執行多個 mutation task。

## Form 16 停機紀錄

### Shared downtime mutation barrier

- create / update / delete 共用固定 queue key：

```text
16:downtime:mutation
```

- create 對前端仍是 `202 accepted task`；update / delete 對前端仍是同步 HTTP mutation record。三者的 API shape 不混用，但真正的 Ragic mutation 都必須經過同一條 backend barrier，避免彼此競態。
- update / delete 不因共用 barrier 而變成可重送的 create task。

### Create downtime

- `POST /api/downtime/records`
- 必須帶 `clientRowKey`。
- 採全域串行，避免 Ragic create、duplicate check 與 update/delete 寫入 race。
- 重送時必須重用同一個 `clientRowKey`，不可產生新 key。
- 若 worker 回報 ambiguous / indeterminate write，前端不可直接重送；必須先查 durable mapping、重新整理並確認 Ragic 是否已建立。
- 後端 create 流程仍由 `form16DowntimeService.createRecord()` 負責：
  - Type / DEP / ProdType 等 create-time required fields。
  - duplicate check。
  - post-write verify。
  - action button。
  - SQLite refresh。
  - `checkOrCreateForm16Entry` idempotency。
- 前端 downtime create retry payload 存在：

```text
frontend/src/features/work-report/downtimeTaskRetryStore.ts
```

### Update / delete downtime

- `PATCH /api/downtime/records/:entryId`
- `DELETE /api/downtime/records/:entryId`
- 目前是同步 mutation record，不是 queued retryable create task；但後端仍經過 `16:downtime:mutation` barrier。
- 這兩種 task type 可寫入 registry 供 UI 顯示狀態，但第一版不開本機 payload retry：

```text
update-downtime = synchronous mutation record
delete-downtime = synchronous mutation record
```

- 若未來要把 update/delete 改成 accepted task，需另開 API / retry contract 設計，不可偷塞進 `create-downtime` task shape。

## Task registry 與 local task map

- local task service 負責：
  - enqueue。
  - worker runtime。
  - local active/pending 狀態。
  - 重啟後將未完成任務標 recovered failed。
- task registry 負責：
  - UI-facing task status。
  - task list / task detail 查詢。
  - terminal task history。
  - shutdown flush 後的可觀測狀態。
- 若 local task map 與 registry 同時有同一 task，狀態 precedence 必須一致：

```text
success > failed > running > pending
```

- 同 rank 狀態以較新的 `updatedAt` 為準。
- 這條 precedence 是資料流 invariant；若要調整，必須同時更新 registry merge、route merge 與測試。

## Ragic 讀取與背景任務

- Ragic read 應標明 priority lane：

```text
user | mutation | sync | background
```

- retry log 應包含：
  - label。
  - priority。
  - timeoutMs。
  - attempt / maxRetries。
  - scheduler snapshot。

### Startup Ragic reads

- backend listen 後不可直接啟動大量 Ragic read。
- 任何 startup Ragic read job 都應具備：
  - startup delay env。
  - scheduled log。
  - shutdown stop / timer cleanup。
  - 明確 priority lane。
- 目前啟動錯峰原則：
  - options prewarm：延遲啟動，104/105 串行。
  - planned idle sync：延遲啟動。
  - SQLite auto sync：可背景跑，但不可作為 mutation gate。
  - field index refresh：背景工具讀取，不應擠壓 mutation 判斷。

## 不該做的事

- 不把 16 downtime payload 塞進 104/105 `taskRetryStore`。
- 不把 104/105 與 Form 16 的 retry store / task shape 混用。兩者都需要穩定 durable create key，但各自維持 domain API 與 payload 契約。
- 不讓前端 timeout 自行把 task 標成 failed。
- 不讓 SQLite 成為唯一 mutation gate。
- 不在 backend listen 後直接 fire 大量 Ragic read。
- 不為了共用而過早泛化 backend task runtime。
- 不把 `create-downtime` 塞進 `CreateReportTaskService`。
- 不把 update/delete downtime 偷塞進 create queue。

## 優先整理方向

1. 先維持清楚 source-of-truth 邊界。
2. 共用 task status precedence helper，避免 rank logic drift。
3. 補 route/registry precedence contract tests。
4. 以重啟後 Ragic scheduler log baseline 決定是否調整 startup helper。
5. 若要共用 UI，只共用 presentation components，不共用 retry store / domain payload / API client。
