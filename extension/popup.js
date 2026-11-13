const $ = (s) => document.querySelector(s);
const ask = (msg) => chrome.runtime.sendMessage(msg);

function paint(s) {
  if (!s || s.error) { $("#stateText").textContent = (s && s.error) || "Something went wrong"; return; }
  const dot = $("#dot");
  dot.className = "dot" + (s.connected ? (s.paused ? " warn" : " ok") : "");
  $("#stateText").textContent = !s.hostUp ? "Albatross isn't running on this PC" : !s.paired ? "Not connected yet" : !s.connected ? "Connecting…" : s.paused ? "Paused: the Agent can't use Chrome" : "Connected: the Agent can use Chrome";
  $("#tabText").textContent = s.tab ? "Agent's tab: " + (s.tab.title || s.tab.url) : s.connected ? "No Agent tab open" : "";
  $("#pairBox").hidden = !s.hostUp || s.paired;
  $("#ctlBox").hidden = !s.connected;
  $("#pause").textContent = s.paused ? "Resume" : "Pause";
  $("#pause").className = s.paused ? "primary" : "";
  $("#show").disabled = $("#closeTab").disabled = !s.tab;
}
async function refresh(msg = {}) { paint(await ask(msg)); }

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
$("#pause").onclick = () => refresh({ action: $("#pause").textContent === "Resume" ? "resume" : "pause" });
$("#show").onclick = () => refresh({ action: "show" });
$("#closeTab").onclick = () => refresh({ action: "closetab" });
$("#useTab").onclick = async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); if (t) refresh({ action: "useTab", tabId: t.id }); };
$("#openApp").onclick = () => chrome.tabs.create({ url: "https://albatrossassistent.github.io/public/" });

refresh();
setInterval(refresh, 2000);
