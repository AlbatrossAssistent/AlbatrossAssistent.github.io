// For the slowdown-warning window only: it receives the problems to show, can ask for a fix, a snooze or "off", and resize itself.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("albatrossHealth", {
  onIssues: (fn) => ipcRenderer.on("issues", (_e, issues) => fn(issues)),
  action: (type, id) => ipcRenderer.invoke("health-action", type, id),
  size: (h) => ipcRenderer.send("health-size", h),
});
