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
// The icon opens a small menu (popup.html: the YouTube ad setting and "Open chat"), so Albatross stays out of the way when you only
// want the ad skipper; with "iconOpens" = "chat" (set in that menu) it opens the chat sidebar directly, as it used to.
const panelOnClick = async () => {
  const { iconOpens } = await chrome.storage.local.get("iconOpens");
  const chat = iconOpens === "chat";
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: chat }).catch(() => {});
  await chrome.action.setPopup({ popup: chat ? "" : "popup.html" }).catch(() => {});
};
chrome.storage.onChanged.addListener((c) => { if (c.iconOpens) panelOnClick(); });
panelOnClick();
// "Follow my tab": the AI's tab is the one you're looking at in the window with the sidebar
async function followTab() {
  if (!st.follow) return;
  const [t] = await chrome.tabs.query(panelWin != null ? { active: true, windowId: panelWin } : { active: true, lastFocusedWindow: true });
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
    if (!(await tabInfo())) await followTab();
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

// ---------- the user's own tools ----------
// Made in the sidebar (sidepanel.js, "My tools") and kept in chrome.storage.local. The chat only ever sends a name and the inputs;
// the code is looked up here, so nothing in a page or in the AI's answer can bring its own code.
//   page tool:   the code is the body of an async function (inputs in "args") that runs in the AI's tab, the page you're on with "Follow my tab"
//   prompt tool: the text comes back to the AI with {{input}} replaced by what it passed in
const CUSTOM_LIMIT = 8000;
const asText = (v) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
async function runCustomTool({ name, args, draft }) {
  const { tools } = await chrome.storage.local.get({ tools: [] });
  const t = draft || tools.find((x) => x && x.name === name);
  if (!t) throw new Error('There is no tool called "' + name + '" (any more).');
  args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  if (t.kind === "prompt") {
    let text = String(t.code || "");
    for (const [k, v] of Object.entries(args)) text = text.split("{{" + k + "}}").join(asText(v));
    return text.slice(0, CUSTOM_LIMIT);
  }
  if (st.paused) throw new Error("The AI is paused in Chrome (Albatross extension), so tools can't run on the page. Resume it first.");
  if (!(await tabInfo())) await followTab();
  const tab = await tabInfo();
  if (!tab) throw new Error("There is no page to run the tool on. Open a normal web page in this window first.");
  await attach(tab.id);
  const expression = "(async (args) => {\n" + String(t.code || "") + "\n})(" + JSON.stringify(args) + ")";
  let timer;
  const r = await Promise.race([
    chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
    new Promise((_, no) => { timer = setTimeout(() => no(new Error("The tool took longer than 30 seconds and was stopped waiting for.")), 30000); }),
  ]).finally(() => clearTimeout(timer));
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error("The tool's code failed: " + ((d.exception && (d.exception.description || d.exception.value)) || d.text || "error").toString().split("\n")[0].slice(0, 300));
  }
  const v = r.result && r.result.value;
  return (v === undefined ? "(the tool returned nothing: end the code with return ...)" : asText(v)).slice(0, CUSTOM_LIMIT);
}

// ---------- YouTube, "swap": a second copy in a hidden tab watches the ads ahead (see youtube.js) ----------
// For each tab you watch on (main) there is one hidden, muted tab (helper) in a collapsed group "Ads ahead". Every look from the
// main tab (4 a second) is passed on to the helper, which answers how far it has had its ads ("clear"). When the main tab gets an
// ad at a second the helper is already clear past, the two swap: the helper is shown at that second, the main tab is muted and
// hidden and becomes the helper.
const ytPairs = new Map();          // main tab id -> { helper, v, t, clear, hv, had, busy }
const ytHelperOf = new Map();       // helper tab id -> main tab id
const ytUrl = (v, t) => "https://www.youtube.com/watch?v=" + encodeURIComponent(v) + "&t=" + Math.max(0, Math.floor(t)) + "s";
async function ytMode() { const s = await chrome.storage.local.get(["ytMode", "ytAds"]); return s.ytMode || (s.ytAds === false ? "off" : "skip"); }
async function ytHide(tabId, windowId) {
  try {
    const g = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(g, { title: "Ads ahead", collapsed: true, color: "grey" });
  } catch {}
}
async function ytHelperFor(tab, v, t) {
  const h = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: false, url: ytUrl(v, t + 60) });
  // muted (the tab, not the video: Chrome keeps playing a tab that "has sound"), and never thrown out of memory to save it
  try { await chrome.tabs.update(h.id, { muted: true, autoDiscardable: false }); } catch {}
  await ytHide(h.id, tab.windowId);
  return h.id;
}
function ytDrop(mainId, closeHelper) {
  const p = ytPairs.get(mainId); if (!p) return;
  ytPairs.delete(mainId); ytHelperOf.delete(p.helper);
  if (closeHelper) chrome.tabs.remove(p.helper).catch(() => {});
}
async function ytSwap(mainId, p, msg) {
  p.busy = true;
  const helper = p.helper;
  try {
    const [oldTab, newTab] = await Promise.all([chrome.tabs.get(mainId), chrome.tabs.get(helper)]);
    // the roles change first, so looks that arrive meanwhile go to the right place
    ytPairs.delete(mainId); ytHelperOf.delete(helper);
    ytPairs.set(helper, { helper: mainId, v: p.v, t: msg.t, clear: msg.t, hv: p.v, had: true });
    ytHelperOf.set(mainId, helper);
    try { await chrome.tabs.ungroup(helper); } catch {}
    await chrome.tabs.move(helper, { windowId: oldTab.windowId, index: oldTab.index });
    await chrome.tabs.update(helper, { muted: false, active: true, autoDiscardable: true });
    await chrome.tabs.sendMessage(helper, { yt: "become", t: msg.t, rate: msg.rate, volume: msg.volume }).catch(() => {});
    await chrome.tabs.update(mainId, { muted: true, autoDiscardable: false });
    await chrome.tabs.sendMessage(mainId, { yt: "demote", t: msg.t }).catch(() => {});
    await ytHide(mainId, newTab.windowId);
  } catch { /* a tab was closed meanwhile: the next look sorts it out */ }
  finally { p.busy = false; }
}
async function ytTick(msg, tab) {
  if (!tab || tab.id == null) return { role: "none" };
  if ((await ytMode()) !== "swap") {
    for (const id of [...ytPairs.keys()]) ytDrop(id, true);
    return { role: "none" };
  }
  if (ytHelperOf.has(tab.id)) return { role: "helper" };
  let p = ytPairs.get(tab.id);
  if (!p) {
    if (ytTick.making && ytTick.making.has(tab.id)) return { role: "main" };
    (ytTick.making = ytTick.making || new Set()).add(tab.id);
    try { const helper = await ytHelperFor(tab, msg.v, msg.t); p = { helper, v: msg.v, t: msg.t, clear: 0, hv: "", had: false }; ytPairs.set(tab.id, p); ytHelperOf.set(helper, tab.id); }
    finally { ytTick.making.delete(tab.id); }
    return { role: "main" };
  }
  if (p.busy) return { role: "main" };
  if (p.v !== msg.v) { p.v = msg.v; p.clear = 0; p.hv = ""; }        // another video: the helper follows (it opens it itself)
  p.t = msg.t;
  if (msg.ad && p.hv === p.v && !p.had && p.clear > msg.t + 0.5) { ytSwap(tab.id, p, msg); return { role: "main" }; }
  const r = await chrome.tabs.sendMessage(p.helper, { yt: "lead", v: p.v, lead: p.t }).catch(() => null);
  if (r) { p.hv = r.v; p.clear = r.clear; p.had = r.ad; }
  return { role: "main" };
}
chrome.tabs.onRemoved.addListener((id) => {
  if (ytPairs.has(id)) ytDrop(id, true);                                       // closed the video: its helper goes too
  else if (ytHelperOf.has(id)) { const m = ytHelperOf.get(id); ytHelperOf.delete(id); ytPairs.delete(m); }   // closed the helper: a new one comes
});
chrome.tabs.onUpdated.addListener((id, info) => {
  // the main tab left YouTube: no helper needed anymore
  if (info.url && ytPairs.has(id) && !/^https:\/\/(www|m)\.youtube\.com\//.test(info.url)) ytDrop(id, true);
});
chrome.storage.onChanged.addListener((c) => { if (c.ytMode && c.ytMode.newValue !== "swap") for (const id of [...ytPairs.keys()]) ytDrop(id, true); });

// ---------- the popup ----------
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg && msg.ytNote) return;                 // for the sidebar (what happened at an ad place), not for here
  if (msg && msg.det) return;                    // Detect on a tab: its own listener below
  if (msg && msg.yt === "tick") { ytTick(msg, _s.tab).then(reply, () => reply({ role: "none" })); return true; }
  (async () => {
    if (msg.customTool) {
      // "draft" (a tool being tested before it's saved) only from our own pages
      const mine = _s.id === chrome.runtime.id && String(_s.url || "").startsWith(chrome.runtime.getURL(""));
      const { name, args, draft } = msg.customTool;
      return { ok: true, result: await runCustomTool({ name, args, draft: mine ? draft : null }) };
    }
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

// ---------- Detect on a tab: the AI finds people on the page and detect-overlay.js draws boxes around them ----------
// The menu starts it (only a click there may capture a tab): the tab's picture goes to a hidden page (detect-offscreen.html), which
// runs the detector; its results come back here and go to the overlay in that tab. It only looks: it never clicks, aims or types.
let detTab = null;
async function detStop() {
  const t = detTab; detTab = null;
  chrome.runtime.sendMessage({ det: "offscreen", cmd: "stop" }).catch(() => {});
  if (t != null) chrome.tabs.sendMessage(t, { det: "overlay", end: true }).catch(() => {});
  try { await chrome.offscreen.closeDocument(); } catch {}
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.det) return;
  if (msg.det === "start") {
    (async () => {
      await detStop();
      await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["detect-overlay.js"] });
      try { await chrome.offscreen.createDocument({ url: "detect-offscreen.html", reasons: ["USER_MEDIA"], justification: "Find people in the picture of the tab you chose" }); } catch {}
      detTab = msg.tabId;
      chrome.runtime.sendMessage({ det: "offscreen", cmd: "start", tabId: msg.tabId, streamId: msg.streamId }).catch(() => {});
      return { ok: true };
    })().then(reply, (e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.det === "stop") { detStop().then(() => reply({ ok: true })); return true; }
  if (msg.det === "state") { reply({ tab: detTab }); return; }
  if (msg.det === "result" && msg.tabId === detTab) {
    chrome.tabs.sendMessage(detTab, { ...msg, det: "overlay" }).catch(() => {});
    if (msg.end) detStop();
  }
});
chrome.tabs.onRemoved.addListener((id) => { if (id === detTab) detStop(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (id === detTab && info.status === "loading") detStop(); });   // a new page: start again from the menu
