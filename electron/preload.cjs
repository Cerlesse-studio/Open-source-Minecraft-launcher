const { contextBridge, ipcRenderer } = require('electron');
const events = new Set([
  'install:progress',
  'content:progress',
  'game:log',
  'game:status',
  'game:exit',
  'multiplayer:status',
  'multiplayer:log',
  'multiplayer:install',
  'multiplayer:clone',
  'update:progress',
]);

// Single multiplexed IPC event dispatcher to avoid per-listener ipcRenderer overhead.
const eventListeners = new Map();

function dispatchEvent(name, payload) {
  const handlers = eventListeners.get(name);
  if (!handlers || handlers.size === 0) return;
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[preload] Event handler error (${name}):`, err);
    }
  }
}

ipcRenderer.on('core:event', (_message, name, payload) => {
  dispatchEvent(name, payload);
});

ipcRenderer.on('core:events', (_message, batch) => {
  if (!Array.isArray(batch)) return;
  for (let i = 0; i < batch.length; i += 1) {
    const item = batch[i];
    if (item && item.event) {
      dispatchEvent(item.event, item.payload);
    }
  }
});

contextBridge.exposeInMainWorld('launcher', {
  invoke: (command, args) => ipcRenderer.invoke('core:invoke', command, args),
  listen: (event, handler) => {
    if (!events.has(event)) throw new Error('Unknown event');
    let set = eventListeners.get(event);
    if (!set) {
      set = new Set();
      eventListeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  },
  openDialog: options => ipcRenderer.invoke('dialog:open', options),
  windowAction: action => ipcRenderer.invoke('window:action', action),
  onResized: handler => {
    const listener = () => handler();
    ipcRenderer.on('window:resized', listener);
    return () => ipcRenderer.removeListener('window:resized', listener);
  },
});
