const { contextBridge, ipcRenderer } = require('electron');
const events = new Set(['install:progress', 'game:log', 'game:status', 'game:exit', 'multiplayer:status', 'multiplayer:log', 'multiplayer:install']);
contextBridge.exposeInMainWorld('launcher', {
  invoke: (command, args) => ipcRenderer.invoke('core:invoke', command, args),
  listen: (event, handler) => {
    if (!events.has(event)) throw new Error('Unknown event');
    const listener = (_message, name, payload) => { if (name === event) handler(payload); };
    ipcRenderer.on('core:event', listener);
    return () => ipcRenderer.removeListener('core:event', listener);
  },
  openDialog: options => ipcRenderer.invoke('dialog:open', options),
  windowAction: action => ipcRenderer.invoke('window:action', action),
  onResized: handler => {
    const listener = () => handler();
    ipcRenderer.on('window:resized', listener);
    return () => ipcRenderer.removeListener('window:resized', listener);
  },
});
