import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dogshIsland', {
  onBark: (cb: () => void) => ipcRenderer.on('dogsh:bark', () => cb()),
  onConfig: (cb: (cfg: unknown) => void) =>
    ipcRenderer.on('dogsh:island-config', (_e, cfg) => cb(cfg)),
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send('dogsh:island-ignore', ignore),
  exitDoghouse: () => ipcRenderer.send('dogsh:island-exit'),
});
