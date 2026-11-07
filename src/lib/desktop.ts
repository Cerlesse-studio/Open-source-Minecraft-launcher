import {
  coreCancelledError,
  isCoreCancelledResult,
  type CoreCancelledResult,
} from "./coreResult";

export { CORE_CANCELLED_CODE, isCancelledError } from "./coreResult";

interface OpenDialogOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}
interface LauncherBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(event: string, handler: (payload: unknown) => void): () => void;
  openDialog(options: OpenDialogOptions): Promise<string | string[] | null>;
  windowAction(action: string): Promise<unknown>;
  onResized(handler: () => void): () => void;
}
declare global { interface Window { launcher?: LauncherBridge } }
export const isDesktop = Boolean(window.launcher);
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.launcher) throw new Error('桌面核心不可用');
  const result = await window.launcher.invoke<T | CoreCancelledResult>(command, args);
  // 主进程把“用户取消/暂停”当作正常结果返回（否则 Electron 会把一次取消
  // 打成未处理异常）。这里还原成带 code 的异常，调用方的 catch 行为不变。
  if (isCoreCancelledResult(result)) throw coreCancelledError(result);
  return result as T;
}
export async function listen<T>(event: string, handler: (message: { payload: T }) => void): Promise<() => void> {
  if (!window.launcher) throw new Error('桌面核心不可用');
  return window.launcher.listen(event, payload => handler({ payload: payload as T }));
}
export async function open(options: OpenDialogOptions): Promise<string | string[] | null> {
  if (!window.launcher) throw new Error('桌面对话框不可用');
  return window.launcher.openDialog(options);
}
export function getCurrentWindow() {
  const action = async (name: string) => { await window.launcher?.windowAction(name); };
  return {
    close: () => action('close'), hide: () => action('hide'), show: () => action('show'),
    setFocus: () => action('setFocus'), minimize: () => action('minimize'),
    toggleMaximize: () => action('toggleMaximize'),
    isMaximized: async () => Boolean(await window.launcher?.windowAction('isMaximized')),
    onResized: async (handler: () => void) => window.launcher?.onResized(handler) ?? (() => {}),
  };
}
