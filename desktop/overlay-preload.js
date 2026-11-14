// For the screen-help overlay window only: it receives the shapes to draw (and the cue to fade out), and can do nothing else.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("albatrossOverlay", {
  onShapes: (fn) => ipcRenderer.on("shapes", (_e, shapes) => fn(shapes)),
  onFade: (fn) => ipcRenderer.on("fade", () => fn()),
});
