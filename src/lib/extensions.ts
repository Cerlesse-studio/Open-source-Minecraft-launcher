import type { ExtensionItem } from "./types";
import { executeExtensionRust } from "./backend";

export interface ExtensionLogEntry {
  id: string;
  extensionId: string;
  level: "info" | "warn" | "error";
  message: string;
  time: string;
}

type NotificationHandler = (
  title: string,
  message: string,
  type?: "info" | "success" | "warning" | "error",
) => void;

type ChromeListener = (...args: unknown[]) => unknown;

interface ChromeEvent {
  addListener(listener: ChromeListener): void;
  removeListener(listener: ChromeListener): void;
  hasListener(listener: ChromeListener): boolean;
  listeners: Set<ChromeListener>;
}

function createChromeEvent(): ChromeEvent {
  const listeners = new Set<ChromeListener>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    hasListener: (listener) => listeners.has(listener),
    listeners,
  };
}

function storagePrefix(extensionId: string): string {
  return `osml_ext_${extensionId}_`;
}

function readStorage(extensionId: string): Record<string, unknown> {
  const prefix = storagePrefix(extensionId);
  const result: Record<string, unknown> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        result[key.slice(prefix.length)] = JSON.parse(raw);
      } catch {
        result[key.slice(prefix.length)] = raw;
      }
    }
  } catch {
    // Sandboxed frames without storage fall back to an empty view.
  }
  return result;
}

function writeStorage(extensionId: string, key: string, value: unknown): void {
  try {
    localStorage.setItem(storagePrefix(extensionId) + key, JSON.stringify(value));
  } catch {
    // Ignore quota/sandbox failures; Chrome extensions handle `lastError` themselves.
  }
}

function removeStorage(extensionId: string, key: string): void {
  try {
    localStorage.removeItem(storagePrefix(extensionId) + key);
  } catch {
    // ignore
  }
}

function createStorageArea(extensionId: string): Record<string, unknown> {
  const get = (keys?: unknown): Record<string, unknown> => {
    const all = readStorage(extensionId);
    if (keys == null) return all;
    if (typeof keys === "string") {
      return Object.prototype.hasOwnProperty.call(all, keys) ? { [keys]: all[keys] } : {};
    }
    if (Array.isArray(keys)) {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key === "string" && Object.prototype.hasOwnProperty.call(all, key)) {
          result[key] = all[key];
        }
      }
      return result;
    }
    if (typeof keys === "object") {
      const result = { ...(keys as Record<string, unknown>) };
      for (const key of Object.keys(result)) {
        if (Object.prototype.hasOwnProperty.call(all, key)) result[key] = all[key];
      }
      return result;
    }
    return {};
  };

  return {
    get: (keys?: unknown, callback?: (items: Record<string, unknown>) => void) => {
      if (typeof keys === "function") {
        callback = keys as (items: Record<string, unknown>) => void;
        keys = undefined;
      }
      const promise = Promise.resolve(get(keys));
      if (callback) promise.then(callback);
      return promise;
    },
    set: (items: Record<string, unknown>, callback?: () => void) => {
      for (const [key, value] of Object.entries(items)) {
        writeStorage(extensionId, key, value);
      }
      const promise = Promise.resolve();
      if (callback) promise.then(callback);
      return promise;
    },
    remove: (keys: string | string[], callback?: () => void) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        removeStorage(extensionId, key);
      }
      const promise = Promise.resolve();
      if (callback) promise.then(callback);
      return promise;
    },
    clear: (callback?: () => void) => {
      for (const key of Object.keys(readStorage(extensionId))) {
        removeStorage(extensionId, key);
      }
      const promise = Promise.resolve();
      if (callback) promise.then(callback);
      return promise;
    },
  };
}

class ExtensionRuntimeManager {
  private activeExtensions = new Map<string, ExtensionItem>();
  private onLaunchListeners: Array<(event: unknown) => void> = [];
  private onExitListeners: Array<(event: unknown) => void> = [];
  private logs: ExtensionLogEntry[] = [];
  private logListeners: Array<(logs: ExtensionLogEntry[]) => void> = [];
  private notificationHandler: NotificationHandler | null = null;
  private wasmInstances = new Map<string, WebAssembly.Instance>();
  private runtimeEvents = new Map<string, ChromeEvent>();
  private enabled = true;

  /** Master switch from Settings → Developer; disabling releases every hook. */
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.activeExtensions.clear();
      this.onLaunchListeners = [];
      this.onExitListeners = [];
      this.wasmInstances.clear();
      this.runtimeEvents.clear();
      this.logs = [];
      this.notifyLogListeners();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setNotificationHandler(handler: NotificationHandler) {
    this.notificationHandler = handler;
  }

  addLogListener(listener: (logs: ExtensionLogEntry[]) => void): () => void {
    this.logListeners.push(listener);
    listener([...this.logs]);
    return () => {
      this.logListeners = this.logListeners.filter((l) => l !== listener);
    };
  }

  getLogs(): ExtensionLogEntry[] {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
    this.notifyLogListeners();
  }

  private appendLog(extensionId: string, level: "info" | "warn" | "error", message: string) {
    const entry: ExtensionLogEntry = {
      id: Math.random().toString(36).slice(2),
      extensionId,
      level,
      message,
      time: new Date().toLocaleTimeString(),
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) {
      this.logs.pop();
    }
    this.notifyLogListeners();
  }

  private notifyLogListeners() {
    const snapshot = [...this.logs];
    for (const listener of this.logListeners) {
      try {
        listener(snapshot);
      } catch {
        // ignore
      }
    }
  }

  // Load and instantiate WebAssembly binary if available
  async getOrInitWasm(ext: ExtensionItem): Promise<WebAssembly.Instance | null> {
    if (!this.enabled) return null;
    if (this.wasmInstances.has(ext.id)) {
      return this.wasmInstances.get(ext.id)!;
    }
    if (!ext.wasmBase64) {
      return null;
    }

    try {
      const binaryString = atob(ext.wasmBase64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const wasmModule = await WebAssembly.instantiate(bytes, {
        env: {
          abort: () => console.warn("WASM abort called"),
        },
      });
      const instance = wasmModule.instance;
      this.wasmInstances.set(ext.id, instance);
      this.appendLog(ext.id, "info", "WebAssembly 协处理器已成功编译并挂载！");
      return instance;
    } catch (err) {
      this.appendLog(ext.id, "error", `WebAssembly 模块初始化失败: ${String(err)}`);
      return null;
    }
  }

  /**
   * A deliberately small `chrome.*` subset. The manifest-driven popup/background
   * compatibility matrix and the unsupported APIs live in docs/extensions.md.
   */
  private createChromeApi(ext: ExtensionItem, runtimeEvent: ChromeEvent): Record<string, unknown> {
    const storageArea = createStorageArea(ext.id);

    const runtime = {
      id: ext.id,
      getManifest: () => ext.manifest,
      getURL: (path: unknown) => String(path ?? ""),
      sendMessage: (message: unknown, callback?: (response: unknown) => void) => {
        const promise = this.dispatchMessage(ext.id, message, { id: ext.id, url: "background" });
        if (callback) promise.then(callback, () => callback(undefined));
        return promise;
      },
      onMessage: runtimeEvent,
    };

    const notifications = {
      create: (
        idOrOptions: unknown,
        maybeOptions?: unknown,
        callback?: (id: string) => void,
      ) => {
        const id = typeof idOrOptions === "string" ? idOrOptions : `ext-${Date.now()}`;
        const options = (typeof idOrOptions === "string" ? maybeOptions : idOrOptions) ?? {};
        const cb = (typeof maybeOptions === "function" ? maybeOptions : callback) as
          | ((id: string) => void)
          | undefined;
        const payload = options as { title?: unknown; message?: unknown; type?: unknown };
        const title = typeof payload.title === "string" ? payload.title : ext.manifest.name;
        const message = typeof payload.message === "string" ? payload.message : "";
        const type =
          payload.type === "error" || payload.type === "warning" || payload.type === "success"
            ? payload.type
            : "info";
        this.notificationHandler?.(title, message, type);
        cb?.(id);
        return Promise.resolve(id);
      },
    };

    const i18n = {
      getMessage: (key: unknown, substitutions?: unknown) => {
        const raw = ext.i18n?.[String(key)] ?? ext.i18n?.[String(key).toLowerCase()];
        if (raw == null) return "";
        const values = Array.isArray(substitutions)
          ? substitutions
          : substitutions == null
            ? []
            : [substitutions];
        return raw.replace(/\$(\d)/g, (match, index: string) => {
          const value = values[Number(index) - 1];
          return value == null ? match : String(value);
        });
      },
    };

    return {
      storage: { local: storageArea, sync: storageArea },
      runtime,
      notifications,
      i18n,
    };
  }

  /** Delivers a `chrome.runtime.sendMessage` to background listeners. */
  async dispatchMessage(extensionId: string, message: unknown, sender: unknown): Promise<unknown> {
    if (!this.enabled) return undefined;
    const event = this.runtimeEvents.get(extensionId);
    if (!event) return undefined;

    for (const listener of Array.from(event.listeners)) {
      const response = await new Promise<unknown>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        timer = setTimeout(() => finish(undefined), 10_000);
        const sendResponse = (value?: unknown) => finish(value);
        let result: unknown;
        try {
          result = listener(message, sender, sendResponse);
        } catch (error) {
          this.appendLog(extensionId, "error", `扩展消息处理失败: ${String(error)}`);
          finish(undefined);
          return;
        }
        if (result === true) return;
        if (result && typeof (result as { then?: unknown }).then === "function") {
          (result as Promise<unknown>).then(finish, () => finish(undefined));
          return;
        }
        finish(result);
      });
      if (response !== undefined) return response;
    }
    return undefined;
  }

  // Execute background script with the `launcher` API bridge
  async activateExtension(ext: ExtensionItem) {
    if (!this.enabled || !ext.enabled || !ext.jsCode) {
      return;
    }
    this.activeExtensions.set(ext.id, ext);
    this.appendLog(ext.id, "info", `正在启动扩展后台服务: ${ext.manifest.name} (v${ext.manifest.version})`);

    const wasmInstance = await this.getOrInitWasm(ext);
    if (!this.enabled) return;
    const runtimeEvent = createChromeEvent();
    this.runtimeEvents.set(ext.id, runtimeEvent);
    const chromeApi = this.createChromeApi(ext, runtimeEvent);

    // Build the `launcher` bridge
    const storagePrefix = `osml_ext_${ext.id}_`;
    const launcherBridge = {
      storage: {
        get: async (key: string) => {
          try {
            const raw = localStorage.getItem(storagePrefix + key);
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        },
        set: async (key: string, val: unknown) => {
          try {
            localStorage.setItem(storagePrefix + key, JSON.stringify(val));
          } catch {
            // ignore
          }
        },
        remove: async (key: string) => {
          localStorage.removeItem(storagePrefix + key);
        },
      },
      game: {
        onLaunch: (callback: (event: unknown) => void) => {
          this.onLaunchListeners.push(callback);
        },
        onExit: (callback: (event: unknown) => void) => {
          this.onExitListeners.push(callback);
        },
      },
      ui: {
        notify: (opts: { title: string; message: string; type?: "info" | "success" | "warning" | "error" }) => {
          this.appendLog(ext.id, "info", `[通知] ${opts.title}: ${opts.message}`);
          if (this.notificationHandler) {
            this.notificationHandler(opts.title, opts.message, opts.type || "info");
          }
        },
      },
      rust: {
        call: async (fnName: string, args: Record<string, unknown> = {}) => {
          this.appendLog(ext.id, "info", `[Rust 调用] 函数: ${fnName}, 入参: ${JSON.stringify(args)}`);
          // 1. Try local WebAssembly export first if available
          if (wasmInstance && wasmInstance.exports && typeof (wasmInstance.exports as Record<string, unknown>)[fnName] === "function") {
            try {
              const wasmFn = (wasmInstance.exports as Record<string, unknown>)[fnName] as (...a: unknown[]) => unknown;
              const a = Number(args.a || 0);
              const b = Number(args.b || 0);
              const res = wasmFn(a, b);
              this.appendLog(ext.id, "info", `[Rust WASM 导出函数执行成功]: ${res}`);
              return { result: res, source: "wasm" };
            } catch (wasmErr) {
              this.appendLog(ext.id, "warn", `WASM 执行失败，尝试转发后端 Rust: ${String(wasmErr)}`);
            }
          }
          // 2. Forward to native Rust backend
          try {
            const res = await executeExtensionRust(ext.id, fnName, args);
            this.appendLog(ext.id, "info", `[Rust 原生引擎执行成功]: ${JSON.stringify(res)}`);
            return res;
          } catch (rustErr) {
            this.appendLog(ext.id, "error", `Rust 逻辑执行异常: ${String(rustErr)}`);
            throw rustErr;
          }
        },
      },
    };

    // Sandboxed execution of background.js
    try {
      const sandboxFn = new Function(
        "launcher",
        "chrome",
        "browser",
        "console",
        `"use strict";\n${ext.jsCode}\n`
      );

      const scopedConsole = {
        log: (...args: unknown[]) => this.appendLog(ext.id, "info", args.map(String).join(" ")),
        warn: (...args: unknown[]) => this.appendLog(ext.id, "warn", args.map(String).join(" ")),
        error: (...args: unknown[]) => this.appendLog(ext.id, "error", args.map(String).join(" ")),
        info: (...args: unknown[]) => this.appendLog(ext.id, "info", args.map(String).join(" ")),
      };

      sandboxFn(launcherBridge, chromeApi, chromeApi, scopedConsole);
      this.appendLog(ext.id, "info", "后台脚本执行完毕并常驻监听。");
    } catch (err) {
      this.appendLog(ext.id, "error", `执行 background.js 错误: ${String(err)}`);
    }
  }

  // Trigger game lifecycle hooks
  notifyGameLaunch(event: unknown) {
    if (!this.enabled) return;
    this.appendLog("system", "info", `分发游戏启动生命周期事件给 ${this.onLaunchListeners.length} 个监听器`);
    for (const listener of this.onLaunchListeners) {
      try {
        listener(event);
      } catch (err) {
        this.appendLog("system", "error", `扩展处理 onLaunch 报错: ${String(err)}`);
      }
    }
  }

  notifyGameExit(event: unknown) {
    if (!this.enabled) return;
    this.appendLog("system", "info", `分发游戏退出生命周期事件给 ${this.onExitListeners.length} 个监听器`);
    for (const listener of this.onExitListeners) {
      try {
        listener(event);
      } catch (err) {
        this.appendLog("system", "error", `扩展处理 onExit 报错: ${String(err)}`);
      }
    }
  }

  /** String form of the same subset, injected into a popup's sandboxed iframe. */
  private buildChromePopupBridge(ext: ExtensionItem): string {
    const manifest = JSON.stringify(ext.manifest).replace(/</g, "\\u003c");
    const messages = JSON.stringify(ext.i18n ?? {}).replace(/</g, "\\u003c");
    const prefix = JSON.stringify(storagePrefix(ext.id));
    const extensionId = JSON.stringify(ext.id);
    return `
    <script>
    (function () {
      var PREFIX = ${prefix};
      var MESSAGES = ${messages};
      var MANIFEST = ${manifest};
      var memory = {};
      var listeners = new Set();
      function readRaw(key) {
        try { return localStorage.getItem(PREFIX + key); }
        catch (error) { return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null; }
      }
      function writeRaw(key, value) {
        try { localStorage.setItem(PREFIX + key, value); }
        catch (error) { memory[key] = value; }
      }
      function removeRaw(key) {
        try { localStorage.removeItem(PREFIX + key); } catch (error) {}
        delete memory[key];
      }
      function readAll() {
        var result = {};
        try {
          for (var index = 0; index < localStorage.length; index += 1) {
            var key = localStorage.key(index);
            if (key && key.indexOf(PREFIX) === 0) {
              var raw = localStorage.getItem(key);
              if (raw !== null) {
                try { result[key.slice(PREFIX.length)] = JSON.parse(raw); }
                catch (error) { result[key.slice(PREFIX.length)] = raw; }
              }
            }
          }
        } catch (error) {
          Object.keys(memory).forEach(function (key) {
            var raw = memory[key];
            try { result[key] = JSON.parse(raw); } catch (e) { result[key] = raw; }
          });
        }
        return result;
      }
      function getKeys(keys) {
        var all = readAll();
        if (keys === null || keys === undefined) return all;
        if (typeof keys === "string") {
          var one = {};
          if (Object.prototype.hasOwnProperty.call(all, keys)) one[keys] = all[keys];
          return one;
        }
        if (Array.isArray(keys)) {
          var many = {};
          keys.forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(all, key)) many[key] = all[key];
          });
          return many;
        }
        var defaults = {};
        Object.keys(keys || {}).forEach(function (key) {
          defaults[key] = Object.prototype.hasOwnProperty.call(all, key) ? all[key] : keys[key];
        });
        return defaults;
      }
      function done(callback) {
        var promise = Promise.resolve();
        if (callback) promise.then(callback);
        return promise;
      }
      var area = {
        get: function (keys, callback) {
          if (typeof keys === "function") { callback = keys; keys = null; }
          var promise = Promise.resolve(getKeys(keys));
          if (callback) promise.then(callback);
          return promise;
        },
        set: function (items, callback) {
          Object.keys(items || {}).forEach(function (key) { writeRaw(key, JSON.stringify(items[key])); });
          return done(callback);
        },
        remove: function (keys, callback) {
          (Array.isArray(keys) ? keys : [keys]).forEach(removeRaw);
          return done(callback);
        },
        clear: function (callback) {
          Object.keys(readAll()).forEach(removeRaw);
          return done(callback);
        }
      };
      var rpcId = 0;
      function sendMessage(message, callback) {
        var callId = "rpc-" + (++rpcId) + "-" + Math.random().toString(36).slice(2);
        var promise = new Promise(function (resolve, reject) {
          var timer = setTimeout(function () {
            window.removeEventListener("message", onMessage);
            reject(new Error("runtime.sendMessage 超时"));
          }, 10000);
          function onMessage(event) {
            if (!event.data || event.data.type !== "EXT_RUNTIME_RESPONSE" || event.data.callId !== callId) return;
            clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data.response);
          }
          window.addEventListener("message", onMessage);
          window.parent.postMessage({ type: "EXT_RUNTIME_SEND", callId: callId, extId: ${extensionId}, message: message }, "*");
        });
        if (callback) promise.then(callback, function () { callback(undefined); });
        return promise;
      }
      var runtime = {
        id: ${extensionId},
        getManifest: function () { return MANIFEST; },
        getURL: function (path) { return String(path == null ? "" : path); },
        sendMessage: sendMessage,
        onMessage: {
          addListener: function (fn) { if (typeof fn === "function") listeners.add(fn); },
          removeListener: function (fn) { listeners.delete(fn); },
          hasListener: function (fn) { return listeners.has(fn); }
        }
      };
      var notifications = {
        create: function (idOrOptions, maybeOptions, callback) {
          var id = typeof idOrOptions === "string" ? idOrOptions : "ext-" + Date.now();
          var options = (typeof idOrOptions === "string" ? maybeOptions : idOrOptions) || {};
          var cb = typeof maybeOptions === "function" ? maybeOptions : callback;
          window.parent.postMessage({ type: "EXT_NOTIFY", payload: { title: options.title || MANIFEST.name, message: options.message || "", type: "info" } }, "*");
          if (cb) cb(id);
          return Promise.resolve(id);
        }
      };
      var i18n = {
        getMessage: function (key, substitutions) {
          var raw = MESSAGES[String(key)] || MESSAGES[String(key).toLowerCase()] || "";
          var values = Array.isArray(substitutions) ? substitutions : (substitutions == null ? [] : [substitutions]);
          var output = raw;
          for (var index = values.length; index >= 1; index -= 1) {
            output = output.split("$" + index).join(String(values[index - 1]));
          }
          return output;
        }
      };
      window.chrome = { storage: { local: area, sync: area }, runtime: runtime, notifications: notifications, i18n: i18n };
      window.browser = window.chrome;
    })();
    </script>
    `;
  }

  // Inject launcher API into popup UI HTML
  preparePopupHtml(ext: ExtensionItem): string {
    if (!ext.uiHtml) {
      return "<div style='color: white; padding: 20px;'>扩展未提供用户界面</div>";
    }

    const storagePrefix = `osml_ext_${ext.id}_`;
    const bridgeScript = `
    <script>
      window.launcher = {
        storage: {
          get: async function(key) {
            try {
              const raw = localStorage.getItem("${storagePrefix}" + key);
              return raw ? JSON.parse(raw) : null;
            } catch(e) { return null; }
          },
          set: async function(key, val) {
            try {
              localStorage.setItem("${storagePrefix}" + key, JSON.stringify(val));
            } catch(e) {}
          },
          remove: async function(key) {
            localStorage.removeItem("${storagePrefix}" + key);
          }
        },
        ui: {
          notify: function(opts) {
            window.parent.postMessage({ type: "EXT_NOTIFY", payload: opts, extId: "${ext.id}" }, "*");
          }
        },
        rust: {
          call: async function(fnName, args) {
            return new Promise((resolve, reject) => {
              const callId = Math.random().toString(36).slice(2);
              function onMsg(ev) {
                if (ev.data && ev.data.type === "EXT_RUST_RESULT" && ev.data.callId === callId) {
                  window.removeEventListener("message", onMsg);
                  if (ev.data.error) reject(new Error(ev.data.error));
                  else resolve(ev.data.result);
                }
              }
              window.addEventListener("message", onMsg);
              window.parent.postMessage({ type: "EXT_CALL_RUST", callId: callId, fnName: fnName, args: args || {}, extId: "${ext.id}" }, "*");
            });
          }
        }
      };
    </script>
    `;

    const injected =
      bridgeScript + (ext.format === "chrome" ? this.buildChromePopupBridge(ext) : "");
    if (ext.uiHtml.includes("<head>")) {
      return ext.uiHtml.replace("<head>", `<head>${injected}`);
    }
    return injected + ext.uiHtml;
  }
}

export const extensionRuntime = new ExtensionRuntimeManager();
