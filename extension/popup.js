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
