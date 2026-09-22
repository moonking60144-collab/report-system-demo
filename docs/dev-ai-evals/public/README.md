# Public Dev AI Retrieval Eval

這組案例在獨立暫存 knowledge 目錄中執行，只使用公開的 Ragic 技術 seeds 與合成無答案問題，不會讀取執行環境既有的 curated／approved knowledge，也不含公司知識、內網 IP、正式表單／欄位、歷史對話或 Production definitions。

在 `backend/` 執行：

```bash
npm run eval:dev-ai-retrieval
```

預設跑 lexical，不需要 API key、embedding 模型或網路。可在模型已準備後明確執行：

```bash
npm run eval:dev-ai-retrieval -- --mode hybrid
```

評估只檢查 deterministic retrieval：Top-1 預期來源、必要／禁止 evidence，以及 evidence span hash 的一致性。它不把另一個模型當裁判，也不宣稱回答語意已正確。`latest.json` 寫入 `backend/.data/dev-ai/evals/public/`，該目錄不應提交。
