// For the selection overlay only (side panel → Box / Circle): it gets a still picture of its display and the mode, and gives back
// what was picked (as pictures), or that it was cancelled. Nothing else.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("albatrossSelect", {
  onStart: (fn) => ipcRenderer.on("select-start", (_e, info) => fn(info)),
  done: (result) => ipcRenderer.send("select-done", result),
  cancel: () => ipcRenderer.send("select-cancel"),
});
