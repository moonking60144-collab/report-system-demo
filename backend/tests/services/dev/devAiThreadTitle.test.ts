import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEV_AI_THREAD_TITLE,
  normalizeGeneratedDevAiThreadTitle,
  shouldApplyGeneratedDevAiThreadTitle,
} from "../../../src/services/dev/ai/devAiThreadTitle";

test("Dev AI 產生的 thread 標題只保留繁體中文或英文標題字元", () => {
  assert.equal(normalizeGeneratedDevAiThreadTitle("  「Ragic 公式風險」  "), "Ragic 公式風險");
  assert.equal(normalizeGeneratedDevAiThreadTitle("Ragic Formula Review"), "Ragic Formula Review");
  assert.equal(normalizeGeneratedDevAiThreadTitle("后台任务"), "後臺任務");
  assert.equal(normalizeGeneratedDevAiThreadTitle("用户设置"), "使用者設定");
  assert.equal(normalizeGeneratedDevAiThreadTitle("系统设置"), "系統設定");
  assert.equal(normalizeGeneratedDevAiThreadTitle("Ragic 数据来源"), "Ragic 資料來源");
  assert.equal(normalizeGeneratedDevAiThreadTitle("開発フロー🚀"), DEFAULT_DEV_AI_THREAD_TITLE);
});

test("Dev AI 產生的 thread 標題限制為 4 到 24 個 Unicode 字元", () => {
  assert.equal(normalizeGeneratedDevAiThreadTitle("問"), DEFAULT_DEV_AI_THREAD_TITLE);
  assert.equal(normalizeGeneratedDevAiThreadTitle("資料流檢查"), "資料流檢查");
  assert.equal(
    normalizeGeneratedDevAiThreadTitle("一二三四五六七八九十一二三四五六七八九十一二三四"),
    "一二三四五六七八九十一二三四五六七八九十一二三四"
  );
  const truncated = normalizeGeneratedDevAiThreadTitle(
    "這是一個超過二十四個字而且需要截短的繁體中文對話標題範例"
  );
  assert.equal([...truncated].length, 24);
  assert.equal(truncated.endsWith("…"), true);
});

test("Dev AI 只會替預設標題套用模型產生的標題", () => {
  assert.equal(shouldApplyGeneratedDevAiThreadTitle(DEFAULT_DEV_AI_THREAD_TITLE), true);
  assert.equal(shouldApplyGeneratedDevAiThreadTitle("報工異常排查"), false);
});
