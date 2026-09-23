# AI 與 STT 設定

[返回首頁](../README.md) · [架構細節](architecture.md) · [開發與驗證](development.md)

## 預設模式與選用功能

一般 Demo 預設關閉 Dev AI 與 Meeting AI/STT provider，不需 AI API key，也不下載 embedding 或語音模型。報工、Definitions 瀏覽與錄音介面可先展示；真實 AI 回答、逐字稿及 AI 會議摘要需要另外啟用對應 provider。

Dev AI 的 lexical retrieval 不需 embedding；hybrid/vector 模式則使用本機多語 embedding 與 SQLite 向量索引。`contextSources` 保存送進模型的來源，`citedEvidence` 保存回答明確引用的證據，兩者分開記錄。檢索設計與程式入口見 [架構細節](architecture.md)。

## 本機向量 RAG

請先依首頁完成依賴安裝，並使用與後續啟動相同的資料目錄設定。

一般 `npm run demo` 仍是 zero-download：Dev AI 關閉、檢索模式為 `lexical`，不需要模型或 provider key。要測試 hybrid RAG，先在 backend 明確下載固定版本的 embedding 模型並建立 SQLite 索引：

```bash
cd backend

# 第一次準備：允許下載固定版本模型，並建立／更新向量索引
npm run knowledge:prepare -- --download

# 後續離線驗證：只使用現有模型快取與索引，不允許下載
npm run knowledge:prepare
```

本版向量索引改依 Markdown 章節切塊，舊索引 profile 會失效；啟用 hybrid 前請在相同資料目錄重新執行 `knowledge:prepare`。公開合成檢索回歸案例與新舊詞法計分的比較方式見 [R1 評估說明](dev-ai-evals/r1/README.md)。

準備完成後回到專案根目錄（`cd ..`），以自己的 provider key 啟動。以下以 MiniMax 為例：

```bash
DEV_AI_ENABLED=true \
DEV_AI_PROVIDER=minimax \
MINIMAX_API_KEY=your-key \
DEV_AI_RETRIEVAL_MODE=hybrid \
DEV_AI_EMBEDDING_ALLOW_DOWNLOAD=false \
npm run demo
```

目前固定使用 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` 的指定 revision。首次準備的本機模型快取約 145 MiB，實際大小會依平台略有不同。模型快取、向量 SQLite 與知識文件都位於 `backend/.data/dev-ai/`，已由 `.gitignore` 排除。Runtime 若找不到已準備的模型，會回傳明確的 `503`，不會在使用者送出問題時偷偷下載模型，也不會在檢索失敗後繼續產生沒有證據的回答。

## Python 語音辨識與會議摘要

語音辨識由獨立的 FastAPI + faster-whisper service 執行；Python service 接收音訊，報工 API 與背景任務仍由 Node.js 處理。這個 Python service 與 Dev AI 的 Node.js embedding worker 是不同元件。

Python 環境、模型與啟動步驟見 [Meeting STT README](../services/meeting-stt/README.md)。依該文件啟動服務後，再依 [backend 環境設定範例](../backend/.env.example) 啟用 STT provider；AI 會議摘要另需設定對應的摘要 provider。單純完成錄音不等同已完成逐字稿或 AI 摘要。

模型、索引、錄音與產出檔應保留在本機資料目錄；provider key 不加入 Git。
