// For the side panel only: the AI on this PC, picking a part of the screen, and (when you start it) the AI's mouse and keyboard.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("albatrossPanel", {
  models: () => ipcRenderer.invoke("panel-models"),
  chat: (id, body) => ipcRenderer.invoke("panel-chat", id, body),
  abort: (id) => ipcRenderer.invoke("panel-abort", id),
  onChunk: (fn) => ipcRenderer.on("ai-chunk", (_e, id, part) => fn(id, part)),
  select: (mode) => ipcRenderer.invoke("panel-select", mode),
  config: (change) => ipcRenderer.invoke("panel-config", change || null),
  window: (what) => ipcRenderer.invoke("panel-window", what),
  control: {
    start: () => ipcRenderer.invoke("control-start"),
    stop: () => ipcRenderer.invoke("control-stop"),
    look: (opts) => ipcRenderer.invoke("control-look", opts),
    act: (a) => ipcRenderer.invoke("control-act", a),
    point: (items) => ipcRenderer.invoke("control-point", items),
    onStopped: (fn) => ipcRenderer.on("control-stopped", () => fn()),
  },
});
