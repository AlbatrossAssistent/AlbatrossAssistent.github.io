// The bridge between the Albatross page and the Windows app: only these few calls, nothing else of the app or the PC.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("albatrossDesktop", {
  isDesktop: true,
  version: () => ipcRenderer.invoke("version"),
  // start at boot (before sign-in): Windows asks for admin rights and your password
  setBootStart: (on) => ipcRenderer.invoke("boot", !!on),
  checkUpdate: () => ipcRenderer.invoke("update-check"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  onUpdate: (fn) => ipcRenderer.on("update", (_e, info) => fn(info)),});
