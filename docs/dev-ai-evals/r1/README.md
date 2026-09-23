# Demo RAG 檢索回歸集

這組題目只使用公開合成文件。Runner 走 `ThreadService → ChatService → knowledge search`，以記憶體資料庫保留同一 episode 的多輪對話；生成模型使用固定回應，因此結果只表示預期來源與證據是否進入回答 context，不代表 AI 回答本身正確。一般 Demo 仍預設關閉 Dev AI、使用 lexical 檢索，也不會下載模型。

在 `backend/` 執行：

```sh
npm run eval:dev-ai-retrieval:r1 -- --dry-run
npm run eval:dev-ai-retrieval:r1 -- --mode lexical --output /tmp/demo-r1-lexical.json
npm run eval:dev-ai-retrieval:r1 -- --mode lexical --lexical-profile legacy --output /tmp/demo-r1-legacy.json
```

已離線準備固定 embedding 模型時，才另外執行：

```sh
DEV_AI_EMBEDDING_ALLOW_DOWNLOAD=false npm run eval:dev-ai-retrieval:r1 -- --mode hybrid --output /tmp/demo-r1-hybrid.json
```

`legacy` 是同一份程式內的舊詞法計分對照；預設 `phrase` 會辨識連續繁中詞組與明確欄位／函式識別碼。輸出分開記錄候選、真正送入 context 的來源、必要證據、檢索耗時，以及程式、案例、知識與模型產物的版本指紋。公開六題簡易檢索評估仍可用 `npm run eval:dev-ai-retrieval` 執行。

2026-09-23 的本機固定題集有 3 個 episode、4 輪、4 個預期來源與 7 段必要證據。lexical `legacy` 的 context 命中為 1/4、證據 2/7；lexical `phrase` 與離線 hybrid `phrase` 均為 4/4、7/7。這是受控合成案例，不代表所有 Ragic 問題的準確率。Demo 的表單 definitions 也是合成樣本，不能用這些題目驗證正式 Ragic 紀錄同步。
