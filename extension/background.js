// Albatross for Chrome: the sidebar (sidepanel.html: the Albatross app plus controls), and the link that lets the AI use this Chrome.
// Connects this Chrome to the Albatross host on the same PC (ws://127.0.0.1:4749) and does what the Agent asks
// in one tab of its own (the "Albatross Agent" tab group), through Chrome's debugger: open a page, read it, click, type, scroll.
// Chrome shows a bar "Albatross Agent started debugging this browser" while it's attached; "Cancel" there pauses the Agent.
// Nothing leaves this PC: the host is on 127.0.0.1, and only after pairing with a code from the app.

const HOST = "ws://127.0.0.1:4749";
const st = { key: "", paused: false, tab: null, follow: true };     // kept in chrome.storage.local
let panelWin = null;    // the window whose sidebar is open (follow mode works there)
let ws = null, ready = false, attached = null, pairWait = null;

const load = async () => Object.assign(st, await chrome.storage.local.get({ key: "", paused: false, tab: null, follow: true }));
const save = () => chrome.storage.local.set({ key: st.key, paused: st.paused, tab: st.tab, follow: st.follow });
const out = (o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function badge() {
  chrome.action.setBadgeText({ text: !ready ? "!" : st.paused ? "II" : "" });
  chrome.action.setBadgeBackgroundColor({ color: !ready ? "#8E8E93" : "#FF9500" });
}
async function tabInfo() {
  if (st.tab == null) return null;
  try { const t = await chrome.tabs.get(st.tab); return { id: t.id, title: t.title || "", url: t.url || "" }; } catch { st.tab = null; save(); return null; }
}
async function sendState() { out({ type: "state", paused: st.paused, tab: await tabInfo(), follow: st.follow }); badge(); }

// ---------- the sidebar ----------
// a click on the Albatross icon opens it
const panelOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
panelOnClick();
// "Follow my tab": the AI's tab is the one you're looking at in the window with the sidebar
async function followTab() {
  if (!st.follow || panelWin == null) return;
  const [t] = await chrome.tabs.query({ active: true, windowId: panelWin });
  if (!t || t.id === st.tab) return;
  await detach(); st.tab = t.id; save(); sendState();
}
chrome.tabs.onActivated.addListener((i) => { if (i.windowId === panelWin) followTab(); });
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("panel:")) return;
  panelWin = Number(port.name.slice(6)); followTab();
  // sidebar closed: stop working in your tab (the next job opens a tab of its own again)
  port.onDisconnect.addListener(async () => { if (panelWin !== Number(port.name.slice(6))) return; panelWin = null; if (st.follow) { await detach(); st.tab = null; save(); sendState(); } });
});

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  await load();
  try { ws = new WebSocket(HOST); } catch { return; }
  ws.onopen = () => { if (st.key) out({ type: "hello", key: st.key, ua: navigator.userAgent, version: chrome.runtime.getManifest().version, paused: st.paused, tab: null }); badge(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  ws.onclose = () => { ws = null; ready = false; badge(); };
  ws.onerror = () => {};
}
// keep the connection (and this background script) alive, and come back when the host restarts
setInterval(() => out({ type: "ping" }), 20000);
chrome.alarms.create("albatross", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => { panelOnClick(); connect(); });
connect();

// ---------- the Agent's tab ----------
async function agentTab(create, url) {
  const t = await tabInfo();
  if (t || !create) return t;
  const n = await chrome.tabs.create({ url: url || "about:blank", active: false });
  try { const g = await chrome.tabs.group({ tabIds: [n.id] }); await chrome.tabGroups.update(g, { title: "Albatross Agent", color: "blue" }); } catch {}
  st.tab = n.id; save();
  return { id: n.id, title: "", url: url || "" };
}
async function attach(tabId) {
  if (attached === tabId) return;
  if (attached != null) { try { await chrome.debugger.detach({ tabId: attached }); } catch {} attached = null; }
  try { await chrome.debugger.attach({ tabId }, "1.3"); }
  catch (e) { throw new Error(/cannot (access|attach)|chrome:\/\/|webstore|extensions gallery/i.test(String(e && e.message)) ? "Chrome doesn't let extensions work on this page (chrome:// pages, the Web Store, other extensions). Switch to a normal web page." : "Couldn't attach to the tab: " + (e && e.message || e)); }
  attached = tabId;
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
}
async function detach() { if (attached != null) { try { await chrome.debugger.detach({ tabId: attached }); } catch {} attached = null; } }
function loaded(tabId, ms = 20000) {
  return new Promise((res) => {
    const end = setTimeout(done, ms);
    function done() { clearTimeout(end); chrome.tabs.onUpdated.removeListener(on); res(); }
    function on(id, info) { if (id === tabId && info.status === "complete") done(); }
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete" && !t.pendingUrl) setTimeout(() => chrome.tabs.get(tabId).then((t2) => { if (t2.status === "complete") done(); }).catch(done), 300); }).catch(done);
  });
}
async function viewport(tabId) {
  try { const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "({ w: innerWidth, h: innerHeight })", returnByValue: true }); return r.result.value; } catch { return null; }
}
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (src.tabId === attached && /^Page\.(frameStartedLoading|frameStoppedLoading|loadEventFired|javascriptDialogOpening|javascriptDialogClosed|screencastFrame)$/.test(method)) out({ type: "event", method, params });
});
chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId !== attached) return;
  attached = null;
  if (reason === "canceled_by_user") { st.paused = true; save(); }   // "Cancel" on Chrome's bar: stop the Agent here
  sendState();
});
chrome.tabs.onRemoved.addListener((id) => { if (id === st.tab) { st.tab = null; if (attached === id) attached = null; save(); sendState(); } });
chrome.tabs.onUpdated.addListener((id, info) => { if (id === st.tab && info.title) sendState(); });

// a new tab for the AI (its web searches): in front, in the "Albatross Agent" group; the AI works there from now on
let searchTab = null;
async function intoGroup(tabId) {
  try {
    const [g] = await chrome.tabGroups.query({ title: "Albatross Agent" });
    if (g) await chrome.tabs.group({ tabIds: [tabId], groupId: g.id });
    else { const id = await chrome.tabs.group({ tabIds: [tabId] }); await chrome.tabGroups.update(id, { title: "Albatross Agent", color: "blue" }); }
  } catch {}
}
async function newTab(url) {
  await detach();
  let t = null;
  if (searchTab != null) { try { t = await chrome.tabs.update(searchTab, { url, active: true }); } catch { t = null; } }
  if (!t) { t = await chrome.tabs.create({ url, active: true, ...(panelWin != null ? { windowId: panelWin } : {}) }); await intoGroup(t.id); }
  searchTab = t.id; st.tab = t.id; save();
  await sleep(300); await loaded(t.id); await attach(t.id);
  sendState();
  return { tab: await tabInfo(), vp: await viewport(t.id) };
}
chrome.tabs.onRemoved.addListener((id) => { if (id === searchTab) searchTab = null; });

// ---------- what the PC asks for ----------
async function run(m) {
  if (m.type === "control") return control(m.action);
  if (st.paused) throw new Error("The Agent is paused in Chrome (Albatross extension). Resume it there or in the app.");
  if (m.type === "newtab") return newTab(m.url);
  if (m.type === "open") {
    const fresh = !(await tabInfo());
    const t = await agentTab(true, m.url);
    await attach(t.id);
    if (!fresh) {
      const r = await chrome.debugger.sendCommand({ tabId: t.id }, "Page.navigate", { url: m.url });
      if (r && r.errorText) throw new Error("Couldn't open the page: " + r.errorText);
      await sleep(300);
    }
    await loaded(t.id);
    sendState();
    return { tab: await tabInfo(), vp: await viewport(t.id) };
  }
  if (m.type === "cdp") {
    const t = await agentTab(false);
    if (!t) throw new Error("The Agent has no tab in Chrome yet: open a page first (browser_open).");
    await attach(t.id);
    return await chrome.debugger.sendCommand({ tabId: t.id }, m.method, m.params || {});
  }
  throw new Error("Unknown request");
}
async function control(action) {
  if (action === "pause") { st.paused = true; await detach(); }
  else if (action === "resume") st.paused = false;
  else if (action === "detach") await detach();
  else if (action === "show") { const t = await tabInfo(); if (t) { const tab = await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } }
  else if (action === "closetab") { const t = await tabInfo(); await detach(); if (t && !st.follow) { try { await chrome.tabs.remove(t.id); } catch {} } st.tab = null; st.follow = false; }
  else if (action === "unpair") { st.key = ""; ready = false; await detach(); }
  save(); sendState();
  return { paused: st.paused, tab: await tabInfo() };
}
async function onMessage(m) {
  if (m.type === "welcome") { ready = true; sendState(); return; }
  if (m.type === "unpaired") { st.key = ""; ready = false; save(); badge(); return; }
  if (m.type === "paired") { if (m.ok) { st.key = m.key; save(); out({ type: "hello", key: st.key, ua: navigator.userAgent, version: chrome.runtime.getManifest().version, paused: st.paused, tab: await tabInfo() }); } if (pairWait) { pairWait(m); pairWait = null; } return; }
  if (!m.id) { if (m.type === "control") control(m.action).catch(() => {}); return; }
  try { out({ id: m.id, ok: true, result: await run(m) }); }
  catch (e) { out({ id: m.id, ok: false, error: String(e && e.message || e) }); }
}

// ---------- the popup ----------
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    if (msg.pair) {
      await connect();
      for (let i = 0; i < 20 && !(ws && ws.readyState === WebSocket.OPEN); i++) await sleep(150);
      if (!(ws && ws.readyState === WebSocket.OPEN)) return { ok: false, error: "Albatross isn't running on this PC (the host is off)." };
      const r = await new Promise((res) => { pairWait = res; out({ type: "pair", code: msg.pair }); setTimeout(() => { if (pairWait) { pairWait = null; res({ ok: false, error: "No answer from Albatross." }); } }, 5000); });
      await sleep(300);
      return r;
    }
    if (msg.action === "useTab") { await detach(); st.tab = msg.tabId; st.follow = false; save(); await sendState(); }
    else if (msg.action === "follow") { st.follow = !!msg.on; if (msg.windowId != null) panelWin = msg.windowId; if (st.follow) { st.paused = false; await followTab(); } else { await detach(); st.tab = null; } save(); await sendState(); }
    else if (msg.action) await control(msg.action);
    if (!ws) connect();
    return { connected: ready, hostUp: !!(ws && ws.readyState === WebSocket.OPEN), paired: !!st.key, paused: st.paused, follow: st.follow, tab: await tabInfo() };
  })().then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});
