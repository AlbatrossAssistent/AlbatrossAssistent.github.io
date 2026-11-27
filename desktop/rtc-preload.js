// The hidden remote-desktop window (rtc.html) may only tell the app two things: the connection's state, and an input from the other
// device (as the text that came over the data channel; rtc.js checks it).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rtcApp", {
  state: (s) => ipcRenderer.send("rtc-state", String(s)),
  input: (s) => { if (typeof s === "string" && s.length < 5000) ipcRenderer.send("rtc-input", s); },
});
