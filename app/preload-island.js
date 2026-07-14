const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dogshIsland', {
  onBark: (cb) => ipcRenderer.on('dogsh:bark', () => cb()),
  onConfig: (cb) => ipcRenderer.on('dogsh:island-config', (_e, cfg) => cb(cfg)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('dogsh:island-ignore', ignore),
  exitDoghouse: () => ipcRenderer.send('dogsh:island-exit'),
});
