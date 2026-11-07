import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_CANCELLED_CODE,
  coreCancelledError,
  isCancelledError,
  isCoreCancelledResult,
} from "./coreResult.ts";

test("只有带 __cancelled 标记的结果才算取消", () => {
  assert.equal(isCoreCancelledResult({ __cancelled: true, message: "下载已取消" }), true);
  assert.equal(isCoreCancelledResult({ __cancelled: false }), false);
  assert.equal(isCoreCancelledResult({ success: true }), false);
  assert.equal(isCoreCancelledResult(null), false);
  assert.equal(isCoreCancelledResult("下载已取消"), false);
});

test("取消结果被还原成带 code 的异常，文案保留", () => {
  const error = coreCancelledError({ __cancelled: true, message: "下载任务已被用户取消或暂停" });
  assert.equal(error.message, "下载任务已被用户取消或暂停");
  assert.equal((error as Error & { code?: string }).code, CORE_CANCELLED_CODE);
  assert.equal(isCancelledError(error), true);
});

test("取消结果没有文案时给出可读的默认值", () => {
  const error = coreCancelledError({ __cancelled: true, message: "   " });
  assert.equal(error.message, "任务已被用户取消");
  assert.equal(isCancelledError(error), true);
});

test("真正的故障不会被当成取消", () => {
  assert.equal(isCancelledError(new Error("下载失败 (http://x): HTTP 404")), false);
  assert.equal(isCancelledError({ code: "ENOSPC" }), false);
  assert.equal(isCancelledError(null), false);
  assert.equal(isCancelledError("下载已取消"), false);
});
