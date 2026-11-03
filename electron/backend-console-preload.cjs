const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('backendConsole', {
  onSnapshot: (handler) => subscribe('backend:snapshot', handler),
  onLine: (handler) => subscribe('backend:log', handler),
});
