/**
 * 前端 app version — 顯示在主標題旁。
 *
 * 進位規則：
 * - patch：每次 bug fix / 小調整 +1
 * - patch=9 進位 → minor +1、patch 歸 0（0.0.9 → 0.1.0）
 * - minor=9 進位 → major +1、minor + patch 歸 0（0.9.9 → 1.0.0）
 * - major 不設上限（9.9.9 → 10.0.0）
 *
 * 每次 commit 想 bump 版本就改這個常數一行。沒打算自動讀 git tag / package.json，
 * 維持「使用者明示更新」的語意。
 */
export const APP_VERSION = "0.1.3";
