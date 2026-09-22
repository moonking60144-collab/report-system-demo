# Ragic Definitions Source API v1

## 目的

這個 API 是 Ragic Builder definitions 的唯讀 production integration boundary，提供給經授權的外部 consumer 下載一致版本的 definitions snapshot。`ragic-report` 內部 Dev AI 直接使用 `ragicDefinitionsReadService`，不透過 HTTP 呼叫自己。

```text
Ragic Builder .nui
  -> Node.js deterministic export
  -> ragic-definitions tracked baseline
  -> immutable compressed snapshot
  -> read-only integration API
  -> authorized external consumer（若未來需要）
```

Node.js 只負責：

- 從 `.nui` 匯出表單、欄位、公式與 workflow。
- 遮蔽既有 exporter 已辨識的 secrets。
- 產生 deterministic revision。
- 原子發布 baseline 與不可變快照。
- 提供 read-only API。

Node.js 不負責：

- 依欄位名稱或畫面位置推測來源關係。
- 建 dependency graph、matrix 或其他衍生分析結果。
- 替 consumer 決定衍生資料的 business rules。
- 透過此 API 修改 Ragic、formula、Git baseline 或 Dev AI。

## Source of truth 與資料邊界

| 層級 | 用途 | 是否 source of truth |
| --- | --- | --- |
| Ragic Builder `.nui` | Ragic 表單設計原始來源 | 是 |
| `ragic-definitions/forms/**` | 可 Git diff 的 deterministic baseline | 是，為 `.nui` 的唯讀投影 |
| `ragic-definitions/manifest.json` | active revision、artifact/count contract | 是，為 active baseline descriptor |
| `ragic-definitions/.snapshots/*.json.gz` | API delivery cache／retained revision | 否，可刪除後重建 |
| Dev AI definitions context | `ragic-report` 內部檢索 read model | 否，必須標示 source revision |
| 外部衍生 read model | 未來 consumer 自己的索引或分析結果 | 否，必須綁定 source revision |

`.snapshots` 已被 Git ignore。清除它不會刪除 `.nui` 或 tracked baseline；下一次下載會重新 materialize。

## Revision

Manifest v2：

```json
{
  "schemaVersion": 2,
  "revision": "sha256:0123456789abcdef...",
  "revisionAlgorithm": "sha256-path-content-v1",
  "artifactCount": 3394,
  "namespaceFilter": {
    "mode": "include",
    "namespaces": ["default"]
  },
  "counts": {
    "forms": 929,
    "fields": 53526,
    "formulas": 11292,
    "workflows": 607
  }
}
```

`revision` 由所有支援的 definition artifacts 依相對路徑做 ordinal 排序後計算，包含：

- `form.json`
- `fields.json`
- `formulas.json`
- `workflows/*.js`
- canonical `manifest.contract.json`（目前包含 snapshot schema version 與 namespace filter；不是額外實體檔）

時間戳不參與 revision。相同來源內容重匯時 revision 不變；任一 artifact 內容或路徑改變，revision 就改變。
`artifactCount` 只計算實體 definition artifacts，不包含 virtual manifest contract。

舊 manifest v1 仍可讀。第一次讀取會從目前 baseline 推導 revision；下一次成功 re-export 會發布 manifest v2。

## Snapshot JSON

下載並解壓後：

```json
{
  "schemaVersion": 1,
  "revision": "sha256:0123456789abcdef...",
  "revisionAlgorithm": "sha256-path-content-v1",
  "artifactCount": 3394,
  "manifest": {
    "schemaVersion": 2,
    "revision": "sha256:0123456789abcdef...",
    "counts": {
      "forms": 929,
      "fields": 53526,
      "formulas": 11292,
      "workflows": 607
    }
  },
  "forms": [
    {
      "form": {
        "formPath": "default/devtest/51",
        "formName": "TestForm1",
        "sourceRelativePath": "default/devtest/51_Sheet51_index.nui"
      },
      "fields": [],
      "formulas": [],
      "workflows": []
    }
  ]
}
```

所有 form 都在同一份 response，因此 consumer 不會在多次請求間混到兩個 revision。

## Authentication

設定獨立 read-only token：

```dotenv
RAGIC_DEFINITIONS_SOURCE_API_TOKEN=<至少 32 字元的隨機值>
RAGIC_DEFINITIONS_SNAPSHOT_RETAIN_COUNT=10
```

Windows PowerShell 5.1 產生 token：

```powershell
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[Convert]::ToBase64String($bytes)
```

macOS／Linux：

```bash
openssl rand -base64 48
```

Token 未設定或不足 32 字元時，integration API fail-closed 回：

```http
503 RAGIC_DEFINITIONS_SOURCE_API_DISABLED
```

這個 token 只由 `/api/integrations/ragic-definitions/*` middleware 驗證，不是 Dev session token，沒有 formula apply、rollback、AI、commit 或 push 權限。

## Endpoints

### 讀取 current descriptor

```http
GET /api/integrations/ragic-definitions/state
Authorization: Bearer <source-token>
If-None-Match: W/"sha256-..."
```

回傳不包含 server filesystem path、Git status 或 Dev 使用者資訊。
Current revision 未變時可回 `304 Not Modified`，供外部 consumer 低成本輪詢。

### 下載 current snapshot

```http
GET /api/integrations/ragic-definitions/snapshot
Authorization: Bearer <source-token>
If-None-Match: W/"sha256-..."
Accept-Encoding: gzip
```

重要 response headers：

```http
ETag: W/"sha256-..."
X-Ragic-Definitions-Revision: sha256:...
X-Ragic-Definitions-Payload-SHA256: <解壓後 JSON bytes 的 SHA-256 hex>
X-Ragic-Definitions-Schema: ragic-definitions-source-v1
Content-Type: application/json; charset=utf-8
Content-Encoding: gzip
Cache-Control: private, no-cache
Vary: Accept-Encoding
```

- ETag 相同時回 `304 Not Modified`。
- Client 接受 gzip 時直接傳送預先產生的壓縮 artifact。
- Cold read 與 runtime cache 重建使用非同步檔案 I/O、Web Crypto SHA-256 與 libuv zlib；避免把整段檔案讀取與 level-9 gzip 連續阻塞在 Node.js event loop。JSON parse／serialize 仍有一次性的 CPU 工作。
- 驗證期間會短暫持有解壓後 bytes；cache 不存在時會從 active manifest/forms 自我重建，不要求把 `.snapshots` 部署進 Git。
- 驗證完成後會依 data/metadata fingerprint 快取已驗證的壓縮 artifact；未變更的後續下載不會重複解壓與雜湊。
- Client 使用 `Accept-Encoding: identity` 時，server 從已驗證的壓縮 artifact 串流解壓 JSON，不會把解壓後 payload 常駐在 service cache。
- `X-Ragic-Definitions-Payload-SHA256` 一律對「解壓後 JSON bytes」計算，因此兩種 transport encoding 都能驗證同一份 payload。
- `HEAD`、ETag 命中的 `304` 與不支援 encoding 的 `406` 只讀 descriptor，不載入 snapshot body。

### 列出 retained snapshots

```http
GET /api/integrations/ragic-definitions/snapshots
Authorization: Bearer <source-token>
```

### 下載 retained revision

兩種格式都接受：

```http
GET /api/integrations/ragic-definitions/snapshots/<64-hex>
GET /api/integrations/ragic-definitions/snapshots/sha256:<64-hex>
```

Revision 已被 retention 淘汰時回：

```http
404 RAGIC_DEFINITIONS_SNAPSHOT_NOT_FOUND
```

## 外部 consumer 同步演算法

外部 consumer 應把 source revision 當成一次完整 ingestion 的 transaction boundary：

```text
1. GET /state
2. current.revision == local active sourceRevision
   -> 結束，不重算
3. GET /snapshot，帶上一版 ETag
4. 收到 304
   -> 結束
5. 收到 200
   -> 先寫入 temporary file
   -> 若 Content-Encoding=gzip，解壓
   -> 對解壓後原始 JSON bytes 算 SHA-256
   -> 比對 X-Ragic-Definitions-Payload-SHA256
   -> parse JSON
   -> 比對 body.revision、header revision、state revision 三者相同
   -> 在新的 ingestion transaction/schema namespace 處理
   -> 所有 validation 成功後，atomic promote active sourceRevision
6. 任一步驟失敗
   -> 保留上一個 active derived revision
   -> 不發布半套結果
```

衍生 record 至少保存：

```json
{
  "sourceRevision": "sha256:...",
  "consumerVersion": "1.0.0",
  "derivedAt": "2026-08-03T12:00:00+08:00"
}
```

若未來建立獨立索引，也必須保存：

```json
{
  "sourceRevision": "sha256:...",
  "derivedRevision": "consumer-derived:...",
  "embeddingModel": "...",
  "indexedAt": "..."
}
```

不得將不同 revision 的 chunks 混在同一個 active index。

## Atomic publication

每次 re-export：

```text
保留可讀的舊 revision snapshot（若舊 baseline 完整）
-> 將所有新 forms 寫入 temporary export directory
-> 驗證 form/field/formula/workflow counts
-> 計算 deterministic revision
-> prepare gzip data（尚無 sidecar，不會出現在 history/open）
-> rollback-safe swap forms + manifest
-> publish snapshot sidecar（此時 retained history 才可讀）
-> retention cleanup
```

- Candidate export 或 snapshot prepare 失敗時，不切換 active forms/manifest。
- Baseline swap 失敗時，candidate gzip 沒有 sidecar，不會被 retained API 列出或下載。
- Sidecar publication 在 baseline swap 後失敗時，active baseline 仍成立；API 下一次讀取會從 active baseline 重建快照，Dev UI 同時收到 warning。
- Retention cleanup 失敗不回滾已成功發布的 baseline，但會回傳 warning 給 Dev UI。
- Formula apply、rollback 與 watcher 都沿用同一個 exporter，因此 revision 不會漏更新。
- API process 會以 manifest bytes 的 SHA-256 辨識跨 process 發布，並對 Windows rename 期間的短暫 manifest 空窗做 bounded retry；不會把一次暫時性缺檔永久快取成 unavailable。

## Retention

- 預設保留最近 10 個 materialized revisions。
- 可用 `RAGIC_DEFINITIONS_SNAPSHOT_RETAIN_COUNT` 設定 1 到 100。
- Active revision 永遠受保護。
- Retention 只刪 ignored gzip cache 與 sidecar metadata，不刪 tracked baseline 或 consumer 自己的衍生資料。
- 發布失敗或檔案損壞留下的 orphan artifact 先保留一小時，避免碰到仍在進行的跨 process publication；之後會在下一次 exporter retention cleanup 清除。HTTP runtime 自我重建只補 cache、不跨 revision 刪檔。

## 部署

1. 更新 backend code。
2. 只有確定存在外部 consumer 時，才在 server `backend/.env` 加入 source token 與 retention；純內部 Dev AI 不需要啟用這個 API。
3. 重新 build backend。
4. 重啟 backend，讓新的 route 與 env 生效。
5. 先呼叫 `GET /state`。
6. 再下載 `GET /snapshot` 並驗證三個 revision 與 payload hash。
7. 外部 consumer 先以 shadow ingestion 驗證，完成後才切 active。

不需要 DB migration，也不會呼叫 Ragic 寫入 API。
