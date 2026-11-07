/**
 * 核心进程的“任务被用户取消/暂停”结果。
 *
 * Rust 侧的错误只有一句字符串，没有错误码；主进程（`electron/main.cjs`）按
 * 已知的取消文案分类，把这类错误作为**正常结果**返回 `{ __cancelled: true }`，
 * 因为 `ipcMain.handle` 一旦 reject，Electron 就会自行打印
 * “Error occurred in handler for 'core:invoke'”，把一次正常取消变成异常噪声。
 *
 * 渲染进程这一侧（`desktop.ts`）再把标记还原成带 `code` 的异常，调用方原有的
 * `catch` 行为完全不变，同时可以用 `isCancelledError` 区分“用户取消”和真正的
 * 下载故障（网络中断、磁盘写入失败等）——后者仍然照常报错。
 */
export const CORE_CANCELLED_CODE = "CANCELLED";

export interface CoreCancelledResult {
  __cancelled: true;
  message?: string;
}

export function isCoreCancelledResult(value: unknown): value is CoreCancelledResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __cancelled?: unknown }).__cancelled === true
  );
}

/** 把标记还原成渲染进程习惯的异常：保留核心给出的文案，补上可判定的 code。 */
export function coreCancelledError(result: CoreCancelledResult): Error {
  const error = new Error(result.message?.trim() || "任务已被用户取消");
  (error as Error & { code?: string }).code = CORE_CANCELLED_CODE;
  return error;
}

/** 这个异常是不是“用户主动取消/暂停”，而不是真正的故障。 */
export function isCancelledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === CORE_CANCELLED_CODE
  );
}
