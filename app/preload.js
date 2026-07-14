const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dogsh', {
  // Main asks the renderer to repaint after the window is (re)shown, so the
  // terminal never comes back blank from a hidden/GPU-suspended state.
  onReveal: (cb) => ipcRenderer.on('dogsh:reveal', () => cb()),
  // Edit commands arriving from the app menu (Cmd+C/V/A run as accelerators
  // in main, so the renderer never sees those keydowns).
  onEdit: (cb) => ipcRenderer.on('dogsh:edit', (_e, cmd) => cb(cmd)),
  contextMenu: (opts) => ipcRenderer.invoke('dogsh:context-menu', opts),
  clipboardWrite: (text) => ipcRenderer.send('dogsh:clipboard-write', text),
  clipboardRead: () => ipcRenderer.invoke('dogsh:clipboard-read'),
  openExternal: (url) => ipcRenderer.send('dogsh:open-external', url),
});
