// The Albatross sidebar: the Albatross app (chat and all) in Chrome's side panel, plus the controls for the AI in this Chrome.
// The app gets told which tab you're looking at, and with "Follow my tab" on, the AI's browser tools work in that tab.
// the app comes from the Albatross host on this PC: a page from 127.0.0.1 may reach Ollama and the host there without Chrome's
// "local network access" permission, which a sidebar can't ask for
const APP_ORIGIN = "http://127.0.0.1:4747", APP = APP_ORIGIN + "/app/?embed=chrome";
let appReady = false;
const $ = (s) => document.querySelector(s);
const ask = (msg) => chrome.runtime.sendMessage(msg);
const frame = $("#app");
let state = null, winId = null;

// the background script knows the panel is open while this port is connected (follow mode ends when it closes)
chrome.windows.getCurrent().then((w) => { winId = w.id; chrome.runtime.connect({ name: "panel:" + w.id }); refresh(); sendTab(); });

function paint(s) {
  state = s;
  if (!s || s.error) { $("#st").textContent = (s && s.error) || "Something went wrong"; return; }
  $("#dot").className = "dot" + (s.connected ? (s.paused ? " warn" : " ok") : "");
  $("#st").textContent = !s.hostUp ? "Albatross isn't running on this PC" : !s.paired ? "Not connected yet" : !s.connected ? "Connecting…"
    : s.paused ? "Paused: the AI can't use Chrome" : s.follow ? "The AI works in the tab you're on" : s.tab ? "The AI's tab: " + (s.tab.title || s.tab.url) : "Connected";
  $("#pause").hidden = !s.connected;
  $("#pause").textContent = s.paused ? "Resume" : "Pause";
  $("#pause").className = s.paused ? "primary" : "";
  $("#follow").textContent = s.follow ? "Follow my tab: on" : "Follow my tab: off";
  $("#follow").className = s.follow ? "primary" : "";
  $("#show").disabled = $("#closeTab").disabled = !s.tab || s.follow;
  $("#pair").hidden = !s.hostUp || s.paired;
  $("#down").hidden = s.hostUp;
  const showApp = s.hostUp && s.paired;
  if (showApp && !frame.src) frame.src = APP;
  frame.hidden = !showApp;
}
async function refresh(msg = {}) { paint(await ask({ ...msg, windowId: winId })); }

// the tab you're looking at, for the app ("this page")
async function sendTab() {
  if (winId == null) return;
  const [t] = await chrome.tabs.query({ active: true, windowId: winId });
  if (!t || !frame.contentWindow || !appReady) return;     // only once the app has loaded (before that the frame is still empty)
  try { frame.contentWindow.postMessage({ type: "albatross-tab", tab: { title: t.title || "", url: t.url || "", follow: !!(state && state.follow) } }, APP_ORIGIN); } catch {}
}
chrome.tabs.onActivated.addListener((i) => { if (i.windowId === winId) { sendTab(); setTimeout(refresh, 300); } });
chrome.tabs.onUpdated.addListener((id, info, t) => { if (t.windowId === winId && t.active && (info.title || info.url || info.status === "complete")) sendTab(); });
frame.addEventListener("load", () => { appReady = !!frame.src; setTimeout(sendTab, 1500); });
// the app asks for the tab again when it needs it (a new chat, the page reloaded)
addEventListener("message", (e) => { if (e.source === frame.contentWindow && e.origin === APP_ORIGIN && e.data && e.data.type === "albatross-tab?") { appReady = true; sendTab(); } });

$("#moreBtn").onclick = () => { const m = $("#more"); m.hidden = !m.hidden; $("#moreBtn").setAttribute("aria-expanded", String(!m.hidden)); };
$("#pause").onclick = () => refresh({ action: state && state.paused ? "resume" : "pause" });
$("#follow").onclick = async () => { await refresh({ action: "follow", on: !(state && state.follow) }); sendTab(); };
$("#show").onclick = () => refresh({ action: "show" });
$("#closeTab").onclick = () => refresh({ action: "closetab" });
$("#reload").onclick = () => { appReady = false; frame.src = APP; };
$("#openApp").onclick = () => chrome.tabs.create({ url: "https://albatrossassistent.github.io/public/" });
$("#pairGo").onclick = async () => {
  const code = $("#code").value.replace(/\D/g, "");
  if (code.length !== 6) { $("#pairErr").textContent = "The code has 6 digits."; return; }
  $("#pairGo").disabled = true; $("#pairErr").textContent = "";
  const r = await ask({ pair: code });
  $("#pairGo").disabled = false;
  if (!r.ok) $("#pairErr").textContent = r.error || "That didn't work.";
  refresh();
};
$("#code").onkeydown = (e) => { if (e.key === "Enter") $("#pairGo").click(); };
setInterval(refresh, 2500);
