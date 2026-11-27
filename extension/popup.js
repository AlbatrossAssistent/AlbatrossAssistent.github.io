// The small menu behind the icon: the YouTube ad setting (youtube.js) and the way to the chat sidebar, so the chat only shows when
// you want it. "The icon opens the chat directly" goes back to the old way (background.js switches the icon over).
const $ = (s) => document.querySelector(s);
chrome.storage.local.get(["ytMode", "ytAds", "iconOpens"], (v) => {
  const mode = v.ytMode || (v.ytAds === false ? "off" : "skip");
  const r = document.querySelector(`input[name=yt][value="${mode}"]`); if (r) r.checked = true;
  $("#direct").checked = v.iconOpens === "chat";
});
for (const r of document.querySelectorAll("input[name=yt]")) r.onchange = () => chrome.storage.local.set({ ytMode: r.value });
$("#direct").onchange = (e) => chrome.storage.local.set({ iconOpens: e.target.checked ? "chat" : "menu" });
$("#chat").onclick = async () => {
  const w = await chrome.windows.getCurrent();
  try { await chrome.sidePanel.open({ windowId: w.id }); } catch {}
  window.close();
};
// Detect on this tab: the click here is what Chrome needs to let the extension see the tab's picture
chrome.runtime.sendMessage({ det: "state" }, (r) => { if (r && r.tab != null) $("#detect").textContent = "Stop finding people"; });
$("#detect").onclick = async () => {
  const b = $("#detect");
  if (b.textContent.startsWith("Stop")) { await chrome.runtime.sendMessage({ det: "stop" }); window.close(); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) { b.textContent = "Only on web pages"; return; }
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const r = await chrome.runtime.sendMessage({ det: "start", tabId: tab.id, streamId });
    if (r && r.ok === false) throw new Error(r.error);
    window.close();
  } catch (e) { b.textContent = "Couldn't: " + String(e.message || e).slice(0, 60); }
};
