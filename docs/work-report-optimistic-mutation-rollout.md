# Work Report optimistic mutation rollout

## 開關

這兩個 Vite build-time 開關可獨立控制畫面上的 optimistic overlay：

| Domain | 環境變數 | 預設 | 關閉後行為 |
| --- | --- | --- | --- |
| Work Report 104/105 | `VITE_WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED` | `true` | 不套用 temporary row／entry patch；task polling、retry、indeterminate metadata 與 authoritative refresh 保留 |
| Form 16 | `VITE_FORM16_OPTIMISTIC_MUTATIONS_ENABLED` | `true` | 不套用 temporary row／record patch；update/delete 切回既有同步 route，create 仍使用原有 task-backed route |

只有 `0`、`false`、`off`（不分大小寫）會關閉；未設定時啟用。修改後必須重新 build frontend。

## 分階段啟用

1. 先啟用 Work Report，驗證 104/105 single mutation 與既有 sort rollback。
2. 驗證 main-machine、close/reopen、batch partial result 與 reload recovery。
3. 再啟用 Form 16，驗證 create/update/delete、snapshot conflict 與 chart authoritative refresh。
4. 每階段分開觀察 accepted latency、terminal latency、rollback、indeterminate、projection lag 與 duplicate/idempotency conflict。

## 回滾

1. 只關閉發生問題 domain 的 frontend flag並重新部署 frontend；不要刪除 task/retry localStorage。
2. Work Report backend 的 additive async contract與既有 authoritative worker guards保留；已受理 task 繼續 polling/reconcile，不重送 mutation。
3. Form 16 flag 關閉後，新 update/delete 使用既有同步 route；已存在的 async task仍由 task registry完成與查詢。
4. 若要完整撤回版本，以 normal revert commit回復 frontend consumer；不要 force-push，也不要清除 pending/indeterminate metadata。

## 驗證限制

本次 rollout readiness 使用 mock transport、暫存 SQLite 與 no-write browser tests。未執行 production deploy，也未執行任何 live Ragic mutation；受控 accepted latency 不能當成 production Ragic terminal SLA。
