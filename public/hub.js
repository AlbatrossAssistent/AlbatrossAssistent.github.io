"use strict";
// The Hub: a grid of big buttons, like a stream deck, to control the PC from any device. Drag controls from the tray into the
// grid (or tap them), move tiles by dragging, remove them with ×; then use it, or go full screen. The PC-side actions go to the
// host (/pc/media, /pc/launch, /pc/openurl, /pc/lockpc, /pc/sleep), which does them on the desktop.
// Uses the main page's helpers: $, esc, S, saveSettings, toast, pcCall, setView, newChat, send, jarvisCall, fsElemOn.
(() => {
const I = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  playpause: I('<path d="M6 5v14l8-7z" fill="currentColor"/><path d="M16 5v14M20 5v14"/>'), next: I('<path d="M5 5v14l9-7z" fill="currentColor"/><path d="M18 5v14"/>'),
  prev: I('<path d="M19 5v14l-9-7z" fill="currentColor"/><path d="M6 5v14"/>'), volup: I('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"/>'),
  voldown: I('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9a4 4 0 0 1 0 6"/>'), mute: I('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  app: I('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  pcurl: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'), lock: I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  sleep: I('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'), jarvis: I('<circle cx="12" cy="12" r="9"/><path d="M9 10.5v2M15 10.5v2" stroke-width="2.4"/>'),
  ask: I('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'), page: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/>'),
  link: I('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), stats: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
};
// what can go into the grid: [kind, label, icon, needs (what to ask for), group]
const KINDS = [
  ["playpause", "Play / Pause", "playpause", "", "Media"], ["prev", "Previous", "prev", "", "Media"], ["next", "Next", "next", "", "Media"],
  ["voldown", "Volume −", "voldown", "", "Media"], ["volup", "Volume +", "volup", "", "Media"], ["mute", "Mute", "mute", "", "Media"],
  ["app", "Program", "app", "app", "PC"], ["pcurl", "Website on the PC", "pcurl", "url", "PC"], ["lock", "Lock PC", "lock", "", "PC"], ["sleep", "Sleep", "sleep", "", "PC"],
  ["jarvis", "Jarvis command", "jarvis", "text", "AI"], ["ask", "Ask the AI", "ask", "text", "AI"],
  ["page", "Albatross page", "page", "page", "Albatross"], ["link", "Link here", "link", "url", "Albatross"],
  ["clock", "Clock", "clock", "", "Live"], ["stats", "PC load", "stats", "", "Live"],
];
const KIND = Object.fromEntries(KINDS.map((k) => [k[0], { label: k[1], icon: k[2], needs: k[3], group: k[4] }]));
const MEDIA = { playpause: 1, prev: 1, next: 1, voldown: 1, volup: 1, mute: 1 };
const PAGES = { chat: "Chat", notes: "Notes", mail: "Mail", browser: "Browser", jarvis: "Jarvis", agent: "Agent", home: "Home" };
const COLORS = ["#0A84FF", "#30D158", "#FF9F0A", "#FF375F", "#BF5AF2", "#64D2FF", "#FFD60A", "#8E8E93"];
const GROUP_COLOR = { Media: "#0A84FF", PC: "#FF9F0A", AI: "#BF5AF2", Albatross: "#30D158", Live: "#64D2FF" };
const hub = () => (S.hub = S.hub && Array.isArray(S.hub.tiles) ? S.hub : { tiles: [
  { id: "t1", kind: "prev" }, { id: "t2", kind: "playpause" }, { id: "t3", kind: "next" }, { id: "t4", kind: "voldown" }, { id: "t5", kind: "volup" }, { id: "t6", kind: "mute" },
  { id: "t7", kind: "clock" }, { id: "t8", kind: "stats" }, { id: "t9", kind: "lock" }] });
const tid = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
let editing = false, statsT = 0, clockT = 0, stats = null;

// ---------- the page ----------
function render() {
  const page = $("#hubPage"); if (!page) return;
  page.innerHTML = `<div class="hub-wrap">
    <div class="hub-bar"><h1>Hub</h1><span class="hub-sub">Tap a tile to control your PC.</span><span style="flex:1"></span>
      <button class="btn small" id="hubEdit" type="button">${editing ? "Done" : "Edit"}</button>
      <button class="btn small primary" id="hubFull" type="button">Full screen</button></div>
    <div class="hub-body"><div class="hub-grid" id="hubGrid"></div>${editing ? '<div class="hub-tray" id="hubTray"></div>' : ""}</div></div>`;
  page.classList.toggle("editing", editing);
  drawGrid(); if (editing) drawTray();
  $("#hubEdit").onclick = () => { editing = !editing; render(); };
  $("#hubFull").onclick = () => fullSet(!page.classList.contains("hub-fs"));
  live();
}
function tileEl(t) {
  const k = KIND[t.kind] || KIND.app, el = document.createElement("button");
  el.type = "button"; el.className = "hub-tile k-" + t.kind; el.dataset.id = t.id;
  el.style.setProperty("--c", t.color || GROUP_COLOR[k.group] || COLORS[0]);
  el.innerHTML = `<span class="ht-ic">${ICON[k.icon]}</span><span class="ht-lb"></span><span class="ht-sub"></span>${editing ? '<span class="ht-x" role="button" aria-label="Remove">×</span>' : ""}`;
  el.querySelector(".ht-lb").textContent = t.label || k.label;
  el.querySelector(".ht-sub").textContent = t.kind === "app" || t.kind === "page" ? "" : t.arg ? String(t.arg).replace(/^https?:\/\//, "").slice(0, 40) : "";
  return el;
}
function drawGrid() {
  const g = $("#hubGrid"); if (!g) return; g.innerHTML = "";
  for (const t of hub().tiles) g.appendChild(tileEl(t));
  if (!hub().tiles.length) g.innerHTML = `<div class="empty-note">Nothing here yet. Press Edit and drag controls in.</div>`;
  live();
}
function drawTray() {
  const tray = $("#hubTray"); tray.innerHTML = '<p class="hub-tip">Drag a control into the grid, or tap it to add it at the end. In the grid, drag tiles to move them; × removes one.</p>';
  for (const grp of ["Media", "PC", "AI", "Albatross", "Live"]) {
    const box = document.createElement("div"); box.className = "hub-grp"; box.innerHTML = `<h3>${grp}</h3><div class="hub-grp-list"></div>`;
    for (const [kind, label, icon] of KINDS.filter((k) => k[4] === grp)) {
      const b = document.createElement("button"); b.type = "button"; b.className = "hub-src"; b.dataset.kind = kind; b.style.setProperty("--c", GROUP_COLOR[grp]);
      b.innerHTML = `<span class="ht-ic">${ICON[icon]}</span><span></span>`; b.lastChild.textContent = label;
      box.querySelector(".hub-grp-list").appendChild(b);
    }
    tray.appendChild(box);
  }
}

// ---------- dragging (mouse and touch alike) ----------
let drag = null;
function startDrag(e, from) {
  const src = from === "tray" ? e.target.closest(".hub-src") : e.target.closest(".hub-tile");
  if (!src || (from === "grid" && e.target.closest(".ht-x"))) return;
  const r = src.getBoundingClientRect();
  drag = { from, src, kind: src.dataset.kind, id: src.dataset.id, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, moved: false, pid: e.pointerId, fixed: from === "grid" && !editing };   // outside Edit a tile is only tapped, never moved
}
function moveDrag(e) {
  if (!drag || e.pointerId !== drag.pid || drag.fixed) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
    drag.moved = true;
    drag.ghost = drag.src.cloneNode(true); drag.ghost.classList.add("hub-ghost"); drag.ghost.style.width = drag.w + "px"; drag.ghost.style.height = drag.h + "px";
    document.body.appendChild(drag.ghost);
    if (drag.from === "grid") drag.src.classList.add("hub-hole");
  }
  e.preventDefault();
  drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
  const g = $("#hubGrid"), gr = g.getBoundingClientRect(), inside = e.clientX >= gr.left && e.clientX <= gr.right && e.clientY >= gr.top && e.clientY <= gr.bottom + 40;
  g.classList.toggle("drop-on", inside); drag.over = inside ? indexAt(e.clientX, e.clientY) : -1;
  g.querySelectorAll(".hub-tile").forEach((t, i) => t.classList.toggle("drop-before", inside && i === drag.over));
  g.classList.toggle("drop-end", inside && drag.over === hub().tiles.length);
}
function indexAt(x, y) {
  const tiles = [...$("#hubGrid").querySelectorAll(".hub-tile")]; let best = tiles.length, bd = Infinity;
  tiles.forEach((t, i) => { const r = t.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = Math.hypot(x - cx, y - cy); if (d < bd) { bd = d; best = x > cx && Math.abs(y - cy) < r.height / 2 ? i + 1 : i; } });
  return best;
}
function endDrag(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  if (d.ghost) d.ghost.remove();
  const g = $("#hubGrid"); g.classList.remove("drop-on", "drop-end"); g.querySelectorAll(".drop-before").forEach((t) => t.classList.remove("drop-before"));
  const tiles = hub().tiles;
  if (!d.moved) { if (d.from === "tray") addTile(d.kind, tiles.length); else if (!editing) run(tiles.find((t) => t.id === d.id), d.src); return; }
  if (d.from === "tray") { if (d.over >= 0) addTile(d.kind, d.over); return; }
  const i = tiles.findIndex((t) => t.id === d.id); if (i < 0) return;
  if (d.over < 0) { drawGrid(); return; }
  const [t] = tiles.splice(i, 1); tiles.splice(d.over > i ? d.over - 1 : d.over, 0, t); saveSettings(); drawGrid();
}
document.addEventListener("pointerdown", (e) => {
  if (!$("#hubPage") || !e.target.closest("#hubPage")) return;
  if (e.target.closest(".ht-x")) { const id = e.target.closest(".hub-tile").dataset.id; hub().tiles = hub().tiles.filter((t) => t.id !== id); saveSettings(); drawGrid(); return; }
  if (e.target.closest(".hub-src")) startDrag(e, "tray"); else if (e.target.closest(".hub-tile")) startDrag(e, "grid");
});
document.addEventListener("pointermove", moveDrag, { passive: false });
document.addEventListener("pointerup", endDrag); document.addEventListener("pointercancel", (e) => { if (drag && drag.ghost) drag.ghost.remove(); drag = null; drawGrid(); });
// tiles are buttons: a tap runs them through pointerup above, so clicks (keyboard: Enter) are handled here only when no pointer came first
document.addEventListener("click", (e) => { const t = e.target.closest("#hubPage .hub-tile"); if (!t || editing || e.detail) return; run(hub().tiles.find((x) => x.id === t.dataset.id), t); });

// ---------- adding a tile: some ask a question first (which program, which address, what to say) ----------
async function addTile(kind, at) {
  const k = KIND[kind]; let t = { id: tid(), kind };
  if (k.needs) { const r = await askFor(kind); if (!r) return; t = { ...t, ...r }; }
  hub().tiles.splice(Math.min(at, hub().tiles.length), 0, t); saveSettings(); drawGrid();
}
function askFor(kind) {
  return new Promise((done) => {
    const k = KIND[kind], box = document.createElement("div"); box.className = "hub-ask";
    box.innerHTML = `<div class="hub-ask-card"><h3></h3><div class="hub-ask-body"></div><div class="row"><span style="flex:1"></span><button class="btn small" data-a="no" type="button">Cancel</button><button class="btn small primary" data-a="ok" type="button">Add</button></div></div>`;
    box.querySelector("h3").textContent = "Add: " + k.label;
    const body = box.querySelector(".hub-ask-body"), finish = (v) => { box.remove(); done(v); };
    let value = () => null;
    if (k.needs === "app") {
      body.innerHTML = '<input class="hub-in" placeholder="Search your programs…" autocomplete="off"><div class="hub-apps"><div class="empty-note">Loading the programs on your PC…</div></div>';
      let apps = [], pick = null;
      const list = body.querySelector(".hub-apps"), q = body.querySelector("input");
      const draw = () => { list.innerHTML = ""; for (const a of apps.filter((a) => a.name.toLowerCase().includes(q.value.toLowerCase())).slice(0, 80)) { const b = document.createElement("button"); b.type = "button"; b.textContent = a.name; b.className = pick === a ? "on" : ""; b.onclick = () => { pick = a; draw(); }; b.ondblclick = () => box.querySelector('[data-a="ok"]').click(); list.appendChild(b); } };
      pcCall("/pc/apps", null, "GET").then((j) => { apps = j.apps || []; draw(); }).catch((e) => { list.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; });
      q.oninput = draw; value = () => pick && { arg: pick.id, label: pick.name };
    } else if (k.needs === "page") {
      body.innerHTML = `<select class="hub-in">${Object.entries(PAGES).map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>`;
      value = () => { const v = body.querySelector("select").value; return { arg: v, label: PAGES[v] }; };
    } else {
      const ph = k.needs === "url" ? "https://…" : kind === "jarvis" ? "e.g. open Spotify and play my liked songs" : "e.g. What's the weather like today?";
      body.innerHTML = `<input class="hub-in" data-f="arg" placeholder="${esc(ph)}" autocomplete="off"><input class="hub-in" data-f="label" placeholder="Name on the tile (optional)" autocomplete="off">`;
      value = () => {
        let a = body.querySelector('[data-f="arg"]').value.trim(); if (!a) return null;
        if (k.needs === "url" && !/^https?:\/\//i.test(a)) a = "https://" + a;
        return { arg: a, label: body.querySelector('[data-f="label"]').value.trim() || (k.needs === "url" ? a.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : a.slice(0, 28)) };
      };
    }
    box.querySelector('[data-a="no"]').onclick = () => finish(null);
    box.querySelector('[data-a="ok"]').onclick = () => { const v = value(); if (v) finish(v); };
    box.addEventListener("keydown", (e) => { if (e.key === "Enter") box.querySelector('[data-a="ok"]').click(); if (e.key === "Escape") finish(null); });
    ($("#hubPage").classList.contains("hub-fs") ? $("#hubPage") : document.body).appendChild(box);
    setTimeout(() => box.querySelector(".hub-in")?.focus(), 30);
  });
}

// ---------- running a tile ----------
async function run(t, el) {
  if (!t) return;
  el && (el.classList.remove("hit"), void el.offsetWidth, el.classList.add("hit"));
  try {
    if (MEDIA[t.kind]) await pcCall("/pc/media", { key: t.kind });
    else if (t.kind === "app") { await pcCall("/pc/launch", { id: t.arg }); toast("Opening " + (t.label || "the program") + " on your PC"); }
    else if (t.kind === "pcurl") { await pcCall("/pc/openurl", { url: t.arg }); toast("Opened on your PC"); }
    else if (t.kind === "lock") { await pcCall("/pc/lockpc"); toast("Your PC is locked"); }
    else if (t.kind === "sleep") { if (!el || el.dataset.armed !== "1") { if (el) { el.dataset.armed = "1"; el.querySelector(".ht-sub").textContent = "Tap again to sleep"; setTimeout(() => { el.dataset.armed = ""; el.querySelector(".ht-sub").textContent = ""; }, 4000); } return; } await pcCall("/pc/sleep"); toast("Your PC is going to sleep"); }
    else if (t.kind === "jarvis") { const { status, j } = await jarvisCall("POST", "/ask", { text: t.arg }); if (status !== 200) throw new Error(j.error || "Jarvis didn't take that"); toast("Jarvis: " + t.arg); }
    else if (t.kind === "ask") { fullSet(false); newChat("chat", "", false); setView("chat"); $("#prompt").value = t.arg; send(); }
    else if (t.kind === "page") { fullSet(false); if (t.arg === "chat") { newChat("chat", "", false); setView("chat"); } else setView(t.arg); }
    else if (t.kind === "link") window.open(t.arg, "_blank", "noopener");
    if (el) el.classList.add("ok");
  } catch (e) { toast(e.message); if (el) el.classList.add("bad"); }
  if (el) setTimeout(() => el.classList.remove("ok", "bad"), 900);
}

// ---------- live tiles: the clock, and the PC's load ----------
function live() {
  clearInterval(clockT); clearInterval(statsT);
  const on = document.body.classList.contains("hub-view") || $("#hubPage")?.classList.contains("hub-fs");
  if (!on) return;
  const paintClock = () => document.querySelectorAll("#hubGrid .k-clock").forEach((el) => { const d = new Date(); el.querySelector(".ht-lb").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); el.querySelector(".ht-sub").textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }); });
  if (document.querySelector("#hubGrid .k-clock")) { paintClock(); clockT = setInterval(paintClock, 10000); }
  const paintStats = () => document.querySelectorAll("#hubGrid .k-stats").forEach((el) => { if (!stats) return; el.querySelector(".ht-lb").textContent = `CPU ${Math.round(stats.cpu || 0)}%`; el.querySelector(".ht-sub").textContent = [stats.gpu ? `GPU ${Math.round(stats.gpu.util || 0)}% · ${Math.round(stats.gpu.temp || 0)}°C` : "", `RAM ${(stats.memUsedGB || 0).toFixed(1)} GB`].filter(Boolean).join(" · "); });
  const getStats = async () => { try { stats = await pcCall("/pc/stats", null, "GET"); paintStats(); } catch {} };
  if (document.querySelector("#hubGrid .k-stats")) { paintStats(); getStats(); statsT = setInterval(getStats, 3000); }
}

// ---------- full screen: only the tiles, big ----------
function fullSet(on) {
  const page = $("#hubPage"); if (!page || page.classList.contains("hub-fs") === on) return;
  if (on) { editing = false; fullSet.home = [page.parentNode, page.nextSibling]; document.body.appendChild(page); page.classList.add("hub-fs"); render(); window.fsElemOn && window.fsElemOn(page); }
  else {
    page.classList.remove("hub-fs"); const d = document;
    if ((d.fullscreenElement || d.webkitFullscreenElement) === page) try { (d.exitFullscreen || d.webkitExitFullscreen).call(d); } catch {}
    const [p, n] = fullSet.home || []; if (p && p.isConnected) p.insertBefore(page, n && n.parentNode === p ? n : null); render();
  }
}
const fsLeft = () => { if ($("#hubPage")?.classList.contains("hub-fs") && window.fsElemLeftByUser && window.fsElemLeftByUser()) fullSet(false); };
document.addEventListener("fullscreenchange", fsLeft); document.addEventListener("webkitfullscreenchange", fsLeft);
addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#hubPage")?.classList.contains("hub-fs") && !document.querySelector(".hub-ask")) fullSet(false); });

window.hubOpen = render;
window.hubClose = () => { if (!$("#hubPage")?.classList.contains("hub-fs")) { clearInterval(clockT); clearInterval(statsT); } };
})();
