import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dogsh', {
  // Main asks the renderer to repaint after the window is (re)shown, so the
  // terminal never comes back blank from a hidden/GPU-suspended state.
  onReveal: (cb: () => void) => ipcRenderer.on('dogsh:reveal', () => cb()),
  // Edit commands arriving from the app menu (Cmd+C/V/A run as accelerators
  // in main, so the renderer never sees those keydowns).
  onEdit: (cb: (cmd: string) => void) => ipcRenderer.on('dogsh:edit', (_e, cmd) => cb(cmd)),
  // The USER is dragging the window edge (Electron will-resize/resized —
  // never fired by programmatic setContentSize). The renderer refits the
  // grid and reports caps; a DOM resize listener can't tell user drags from
  // the daemon-driven shrink-wrap and would fight it.
  onUserResize: (cb: () => void) => ipcRenderer.on('dogsh:user-resize', () => cb()),
  // Tell main the user is interacting with this face (clears handoffQuiet).
  userPresent: () => ipcRenderer.send('dogsh:user-present'),
  contextMenu: (opts: { hasSelection: boolean }) => ipcRenderer.invoke('dogsh:context-menu', opts),
  clipboardWrite: (text: string) => ipcRenderer.send('dogsh:clipboard-write', text),
  clipboardRead: () => ipcRenderer.invoke('dogsh:clipboard-read'),
  openExternal: (url: string) => ipcRenderer.send('dogsh:open-external', url),
});

// Any real pointer/key in the face is presence — not a focus heuristic.
window.addEventListener(
  'mousedown',
  () => {
    try {
      ipcRenderer.send('dogsh:user-present');
    } catch {
      /* preload teardown */
    }
  },
  true
);
window.addEventListener(
  'keydown',
  () => {
    try {
      ipcRenderer.send('dogsh:user-present');
    } catch {
      /* preload teardown */
    }
  },
  true
);
