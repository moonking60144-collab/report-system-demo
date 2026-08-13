# Meeting STT Service

這是 `ragic-report` Meeting 子系統的獨立開源語音轉文字服務。Node backend 繼續負責錄音、SQLite job、10 分鐘 chunk checkpoint、retry、逐字稿合併與 Meeting Minutes；本服務只接收一段 canonical WAV，回傳逐字稿 segments。

## 元件與授權

- `faster-whisper`：MIT，執行 Whisper 模型。
- Whisper `large-v3`：預設模型，準確度優先。
- OpenCC `s2twp`：將簡體字與部分詞彙轉成臺灣正體用語。
- `pyannote.audio`：可選 speaker diarization；預設關閉，不阻擋逐字稿。

沒有每分鐘雲端 STT API 費用，但模型推論會消耗自有 CPU/GPU、記憶體、磁碟與電力。第一次啟動會下載模型到 `MEETING_STT_MODEL_CACHE_DIR`；正式環境應先完成下載與短音檔驗收，再啟用 Node provider。

## 資料流與隔離

```text
Meeting worker
  -> POST /v1/transcriptions (multipart WAV)
  -> faster-whisper
  -> OpenCC s2twp
  -> { model, segments[] }
  -> Node validator/checkpoint/merge
```

本服務不連 Ragic、不讀報工 SQLite、不執行 Form 16、不使用 Dev AI 或 Meeting Minutes quota，也不管理錄音原檔。

## 安裝

需要 Python 3.11。以下命令都在 `services/meeting-stt` 執行。

```bash
cp .env.example .env
uv sync --locked --python 3.11 --no-dev
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
uv sync --locked --python 3.11 --no-dev
```

若要啟用 pyannote：

```bash
uv sync --locked --python 3.11 --no-dev --extra diarization
```

並在 `.env` 設定 `MEETING_STT_DIARIZATION_ENABLED=true`、`HF_TOKEN`。若已依 pyannote 官方離線流程把 community model 完整下載到本機，也可以把 `MEETING_STT_DIARIZATION_MODEL` 指向該目錄而不填 token。未啟用時 `speakerLabel=null`，既有雙音軌來源仍由 Node 保留。

## 啟動

```bash
uv run --no-sync python -m app
```

請維持單一 service process；`MEETING_STT_MAX_CONCURRENCY` 已在 process 內控制推論數。若另外啟動多個 Uvicorn worker，每個 process 都會各載入一份模型並各自取得 concurrency 配額，GPU 記憶體與總負載不再受單一 gate 約束。

預設只監聽 `127.0.0.1:8010`。若 STT 跑在獨立 GPU 主機，改成：

```dotenv
MEETING_STT_HOST=0.0.0.0
MEETING_STT_API_TOKEN=<內網隨機 token>
MEETING_STT_DEVICE=cuda
MEETING_STT_COMPUTE_TYPE=float16
```

CPU 主機可先使用：

```dotenv
MEETING_STT_DEVICE=cpu
MEETING_STT_COMPUTE_TYPE=int8
```

`large-v3` 在 CPU 上可能無法即時處理長會議；正式吞吐量必須用公司實際會議音訊與目標硬體量測。不要只用單句錄音判定 production capacity。

## Node backend 設定

Backend `.env`：

```dotenv
MEETING_WORKER_ENABLED=true
MEETING_TRANSCRIPTION_PROVIDER=local-whisper
MEETING_TRANSCRIPTION_LOCAL_URL=http://127.0.0.1:8010/v1/transcriptions
MEETING_TRANSCRIPTION_LOCAL_TOKEN=<與 STT service 相同；loopback 可留空>
MEETING_TRANSCRIPTION_LOCAL_MODEL=large-v3
MEETING_TRANSCRIPTION_LANGUAGE=zh-TW
MEETING_TRANSCRIPTION_CHUNK_MS=600000
```

`MEETING_TRANSCRIPTION_LOCAL_URL` 是完整 endpoint。Backend model 必須與 STT service model 完全一致，避免部署切換時把不同模型的 checkpoint 混在同一個 job。

## 驗證

Service health：

```bash
curl -H "Authorization: Bearer $MEETING_STT_API_TOKEN" \
  http://127.0.0.1:8010/health
```

Windows PowerShell：

```powershell
$headers = @{ Authorization = "Bearer $env:MEETING_STT_API_TOKEN" }
Invoke-RestMethod -Uri "http://127.0.0.1:8010/health" -Headers $headers
```

Backend 的 `/api/health?detail=1` 只驗證 Node env 是否可用，不會替代 STT service health 或真實音檔測試。正式切換順序：

1. 啟動 STT service，確認 `/health` 的 model 正確。
2. 用 production 相同 endpoint/token/model 送一段實際臺灣中文短 WAV。
3. 確認 Node Meeting transcription job 產生 merged JSON/text artifact。
4. 才將正式 backend 的 provider 從 `disabled` 改成 `local-whisper` 並重啟。

回滾只需把 Node 設為 `MEETING_TRANSCRIPTION_PROVIDER=disabled` 並重啟。錄音、audio processing 與既有 artifacts 不會被刪除。

## 測試

```bash
uv sync --locked --python 3.11 --dev
uv run pytest
```

測試使用 fake engine，不下載 Whisper 模型、不需要 GPU，也不呼叫外部 API。
