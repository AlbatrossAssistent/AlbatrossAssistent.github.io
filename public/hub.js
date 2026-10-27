"use strict";
// The Hub: a board of controls, like a stream deck, to control the PC from any device. Tiles sit on a 12-column grid: in Edit
// they float while you drag them, snap to the grid when you let go (never on top of another one), and change size from their
// corner. Besides buttons there are knobs and bars (volume, brightness), what is playing now, and routines (several steps on
// one tile). The PC-side actions go to the host (/pc/media, /pc/volume, /pc/bright, /pc/playing, /pc/launch, /pc/openurl,
// /pc/lockpc, /pc/sleep), which does them on the desktop.
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
  knob: I('<circle cx="12" cy="12" r="8"/><path d="M12 12l4-4"/>'), bar: I('<rect x="3" y="9" width="18" height="6" rx="3"/><rect x="3" y="9" width="11" height="6" rx="3" fill="currentColor"/>'),
  sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  playing: I('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M10 8v8l6-4z" fill="currentColor"/>'), routine: I('<path d="M5 6h10M5 12h14M5 18h8"/><circle cx="19" cy="6" r="1.6" fill="currentColor"/><circle cx="17" cy="18" r="1.6" fill="currentColor"/>'),
};
// what can go onto the board: [kind, label, icon, needs (what to ask for), group, default size w×h]
const KINDS = [
  ["playpause", "Play / Pause", "playpause", "", "Media", [2, 2]], ["prev", "Previous", "prev", "", "Media", [2, 2]], ["next", "Next", "next", "", "Media", [2, 2]],
  ["voldown", "Volume −", "voldown", "", "Media", [2, 2]], ["volup", "Volume +", "volup", "", "Media", [2, 2]], ["mute", "Mute", "mute", "", "Media", [2, 2]],
  ["playing", "Now playing", "playing", "", "Media", [4, 2]],
  ["volknob", "Volume knob", "knob", "", "Knobs & bars", [2, 2]], ["volbar", "Volume bar", "bar", "", "Knobs & bars", [4, 1]],
  ["brightknob", "Brightness knob", "sun", "", "Knobs & bars", [2, 2]], ["brightbar", "Brightness bar", "bar", "", "Knobs & bars", [4, 1]],
  ["app", "Program", "app", "app", "PC", [2, 2]], ["pcurl", "Website on the PC", "pcurl", "url", "PC", [2, 2]], ["lock", "Lock PC", "lock", "", "PC", [2, 2]], ["sleep", "Sleep", "sleep", "", "PC", [2, 2]],
  ["routine", "Routine", "routine", "routine", "PC", [2, 2]],
  ["jarvis", "Jarvis command", "jarvis", "text", "AI", [2, 2]], ["ask", "Ask the AI", "ask", "text", "AI", [2, 2]],
  ["page", "Albatross page", "page", "page", "Albatross", [2, 2]], ["link", "Link here", "link", "url", "Albatross", [2, 2]],
  ["clock", "Clock", "clock", "", "Live", [2, 2]], ["stats", "PC load", "stats", "", "Live", [2, 2]],
];
const KIND = Object.fromEntries(KINDS.map((k) => [k[0], { label: k[1], icon: k[2], needs: k[3], group: k[4], size: k[5] }]));
const MEDIA = { playpause: 1, prev: 1, next: 1, voldown: 1, volup: 1, mute: 1 };
const LEVEL = { volknob: "volume", volbar: "volume", brightknob: "bright", brightbar: "bright" };   // knobs and bars: what they set
const PAGES = { chat: "Chat", notes: "Notes", mail: "Mail", browser: "Browser", jarvis: "Jarvis", agent: "Agent", home: "Home" };
const GROUP_COLOR = { Media: "#0A84FF", "Knobs & bars": "#5E5CE6", PC: "#FF9F0A", AI: "#BF5AF2", Albatross: "#30D158", Live: "#64D2FF" };
const COLS = 12, MAXW = 12, MAXH = 8;
const tid = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
let editing = false, statsT = 0, clockT = 0, playT = 0, levelT = 0, stats = null, playing = null;
const levels = {};   // volume / bright -> { level, mute } as last seen

// ---------- the board's tiles, each with a place on the grid (older boards without places get them in order) ----------
function hub() {
  if (!S.hub || !Array.isArray(S.hub.tiles)) S.hub = { tiles: [
    { id: "t1", kind: "prev" }, { id: "t2", kind: "playpause" }, { id: "t3", kind: "next" }, { id: "t4", kind: "volknob" }, { id: "t5", kind: "volbar", w: 4, h: 1 },
    { id: "t6", kind: "playing" }, { id: "t7", kind: "clock" }, { id: "t8", kind: "stats" }, { id: "t9", kind: "lock" }] };
  const tiles = S.hub.tiles, placed = tiles.filter((t) => Number.isInteger(t.x));
  for (const t of tiles) {
    const [dw, dh] = (KIND[t.kind] || KIND.app).size;
    t.w = clamp(t.w || dw, 1, MAXW); t.h = clamp(t.h || dh, 1, MAXH);
    if (!Number.isInteger(t.x) || !Number.isInteger(t.y)) { const p = firstFree(t, placed); t.x = p.x; t.y = p.y; placed.push(t); }
  }
  return S.hub;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// the first free place reading left to right, top to bottom (where new tiles go when nobody chose a place)
function firstFree(t, others) {
  for (let py = 0; ; py++) for (let px = 0; px + t.w <= COLS; px++) if (!others.some((o) => o !== t && overlaps({ x: px, y: py, w: t.w, h: t.h }, o))) return { x: px, y: py };
}
// the free place nearest to (x, y) for a tile of t's size
function freeSpot(t, others, x, y) {
  const fits = (px, py) => px >= 0 && py >= 0 && px + t.w <= COLS && !others.some((o) => o !== t && overlaps({ x: px, y: py, w: t.w, h: t.h }, o));
  if (fits(x, y)) return { x, y };
  let best = null, bd = Infinity;
  const rows = others.reduce((m, o) => Math.max(m, o.y + o.h), 0) + t.h + 1;
  for (let py = 0; py <= rows; py++) for (let px = 0; px + t.w <= COLS; px++) {
    if (!fits(px, py)) continue;
    const d = Math.hypot(px - x, (py - y) * 1.15); if (d < bd) { bd = d; best = { x: px, y: py }; }
  }
  return best || { x: 0, y: rows };
}

// ---------- the page ----------
function render() {
  const page = $("#hubPage"); if (!page) return;
  hub();
  page.innerHTML = `<div class="hub-wrap">
    <div class="hub-bar"><h1>Hub</h1><span class="hub-sub">${editing ? "Drag tiles anywhere: they snap to the grid. The corner handle changes the size." : "Tap a tile to control your PC."}</span><span style="flex:1"></span>
      <button class="btn small" id="hubEdit" type="button">${editing ? "Done" : "Edit"}</button>
      <button class="btn small primary" id="hubFull" type="button">Full screen</button></div>
    <div class="hub-body"><div class="hub-board" id="hubGrid"></div>${editing ? '<div class="hub-tray" id="hubTray"></div>' : ""}</div></div>`;
  page.classList.toggle("editing", editing);
  drawGrid(); if (editing) drawTray();
  $("#hubEdit").onclick = () => { editing = !editing; render(); };
  $("#hubFull").onclick = () => fullSet(!page.classList.contains("hub-fs"));
  live();
}
// the size of one grid cell in pixels (12 columns over the board's width)
const cellOf = () => { const g = $("#hubGrid"); return g ? g.clientWidth / COLS : 80; };
function place(el, t, c) { el.style.left = t.x * c + "px"; el.style.top = t.y * c + "px"; el.style.width = t.w * c + "px"; el.style.height = t.h * c + "px"; }
function tileEl(t) {
  const k = KIND[t.kind] || KIND.app, el = document.createElement("div");
  el.className = `hub-tile k-${t.kind}${LEVEL[t.kind] ? " is-level " + (t.kind.endsWith("bar") ? "is-bar" : "is-knob") : ""}${t.w >= t.h * 2 ? " wide" : ""}${t.h >= t.w * 2 ? " tall" : ""}`;
  el.dataset.id = t.id; el.tabIndex = 0; el.setAttribute("role", "button");
  el.style.setProperty("--c", t.color || GROUP_COLOR[k.group] || "#0A84FF");
  const label = t.label || k.label;
  if (t.kind.endsWith("knob")) el.innerHTML = `<div class="kn-dial"><svg viewBox="0 0 100 100" aria-hidden="true"><path class="kn-track" d="M24.6 80.4 A36 36 0 1 1 75.4 80.4"/><path class="kn-fill" d="M24.6 80.4 A36 36 0 1 1 75.4 80.4"/></svg><i class="kn-dot"></i><b class="kn-val">–</b></div><span class="ht-lb"></span>`;
  else if (t.kind.endsWith("bar")) el.innerHTML = `<span class="ht-lb"></span><div class="br-track"><i class="br-fill"></i><b class="br-val">–</b></div>`;
  else if (t.kind === "playing") el.innerHTML = `<div class="pl-cover"></div><div class="pl-tx"><b class="pl-title">Nothing playing</b><span class="pl-artist"></span><div class="pl-ctl"><button type="button" data-k="prev" aria-label="Previous">${ICON.prev}</button><button type="button" data-k="playpause" aria-label="Play or pause">${ICON.playpause}</button><button type="button" data-k="next" aria-label="Next">${ICON.next}</button></div></div>`;
  else el.innerHTML = `<span class="ht-ic">${ICON[k.icon]}</span><span class="ht-lb"></span><span class="ht-sub"></span>`;
  const lb = el.querySelector(".ht-lb"); if (lb) lb.textContent = label;
  const sub = el.querySelector(".ht-sub");
  if (sub) sub.textContent = t.kind === "routine" ? `${(t.steps || []).length} step${(t.steps || []).length === 1 ? "" : "s"}` : t.kind === "app" || t.kind === "page" ? "" : t.arg ? String(t.arg).replace(/^https?:\/\//, "").slice(0, 40) : "";
  if (editing) el.insertAdjacentHTML("beforeend", '<span class="ht-x" role="button" aria-label="Remove">×</span><span class="ht-rs" aria-label="Change the size"></span>');
  return el;
}
function drawGrid() {
  const g = $("#hubGrid"); if (!g) return;
  const { tiles } = hub(), c = cellOf();
  g.innerHTML = "";
  const rows = Math.max(4, tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0) + (editing ? 2 : 0));
  g.style.height = rows * c + "px"; g.style.setProperty("--cell", c + "px");
  for (const t of tiles) { const el = tileEl(t); place(el, t, c); g.appendChild(el); }
  if (!tiles.length) g.insertAdjacentHTML("beforeend", `<div class="empty-note">Nothing here yet. Press Edit and drag controls in.</div>`);
  paintLevels(); paintPlaying(); live();
}
function drawTray() {
  const tray = $("#hubTray"); tray.innerHTML = '<p class="hub-tip">Drag a control onto the board, or tap it to add it. On the board, drag tiles to move them; the corner changes the size; × removes one.</p>';
  for (const grp of Object.keys(GROUP_COLOR)) {
    const box = document.createElement("div"); box.className = "hub-grp"; box.innerHTML = `<h3>${grp}</h3><div class="hub-grp-list"></div>`;
    for (const [kind, label, icon] of KINDS.filter((k) => k[4] === grp)) {
      const b = document.createElement("button"); b.type = "button"; b.className = "hub-src"; b.dataset.kind = kind; b.style.setProperty("--c", GROUP_COLOR[grp]);
      b.innerHTML = `<span class="ht-ic">${ICON[icon]}</span><span></span>`; b.lastChild.textContent = label;
      box.querySelector(".hub-grp-list").appendChild(b);
    }
    tray.appendChild(box);
  }
}
addEventListener("resize", () => { if (document.body.classList.contains("hub-view") || $("#hubPage")?.classList.contains("hub-fs")) drawGrid(); });

// ---------- dragging: moving, resizing, bringing new controls in; turning knobs and sliding bars ----------
let drag = null;
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest || !e.target.closest("#hubPage") || e.button > 0) return;
  const x = e.target.closest(".ht-x");
  if (x) { const id = x.closest(".hub-tile").dataset.id; hub().tiles = hub().tiles.filter((t) => t.id !== id); saveSettings(); drawGrid(); return; }
  const src = e.target.closest(".hub-src"), tileE = e.target.closest(".hub-tile"), t = tileE && hub().tiles.find((y) => y.id === tileE.dataset.id);
  const base = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
  if (src) drag = { ...base, mode: "new", kind: src.dataset.kind, src };
  else if (t && editing && e.target.closest(".ht-rs")) drag = { ...base, mode: "size", t, el: tileE, w0: t.w, h0: t.h };
  else if (t && editing) { const r = tileE.getBoundingClientRect(); drag = { ...base, mode: "move", t, el: tileE, dx: e.clientX - r.left, dy: e.clientY - r.top }; }
  else if (t && LEVEL[t.kind]) { drag = { ...base, mode: "level", t, el: tileE, start: (levels[LEVEL[t.kind]] || {}).level ?? 50 }; levelFromPointer(drag, e); }
  else if (t && !e.target.closest(".pl-ctl button")) drag = { ...base, mode: "tap", t, el: tileE };
  if (drag && drag.mode !== "tap") { e.preventDefault(); try { e.target.setPointerCapture?.(e.pointerId); } catch {} }
});
document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
  drag.moved = true;
  const g = $("#hubGrid"), c = cellOf(), gr = g.getBoundingClientRect();
  if (drag.mode === "level") { levelFromPointer(drag, e); return; }
  if (drag.mode === "tap") return;
  e.preventDefault();
  if (drag.mode === "size") {
    const t = drag.t, w = clamp(Math.round(drag.w0 + (e.clientX - drag.x0) / c), 1, Math.min(MAXW, COLS - t.x)), h = clamp(Math.round(drag.h0 + (e.clientY - drag.y0) / c), 1, MAXH);
    drag.el.style.width = w * c + "px"; drag.el.style.height = h * c + "px"; drag.w = w; drag.h = h;
    const clash = hub().tiles.some((o) => o !== t && overlaps({ x: t.x, y: t.y, w, h }, o)); drag.el.classList.toggle("clash", clash);
    return;
  }
  // moving (a tile, or a new control from the tray): the tile floats under the pointer, a shadow shows where it will snap
  if (drag.mode === "new" && !drag.el) {
    const k = KIND[drag.kind]; drag.t = { id: tid(), kind: drag.kind, w: k.size[0], h: k.size[1], x: 0, y: 0 };
    drag.el = tileEl(drag.t); drag.el.classList.add("hub-floating"); place(drag.el, drag.t, c); g.appendChild(drag.el);
    drag.dx = c * drag.t.w / 2; drag.dy = c * drag.t.h / 2;
  }
  drag.el.classList.add("hub-floating");
  const left = e.clientX - gr.left - drag.dx, top = e.clientY - gr.top - drag.dy;
  drag.el.style.left = left + "px"; drag.el.style.top = top + "px";
  const t = drag.t, sx = clamp(Math.round(left / c), 0, COLS - t.w), sy = Math.max(0, Math.round(top / c));
  const inside = e.clientX >= gr.left - 20 && e.clientX <= gr.right + 20 && e.clientY >= gr.top - 20 && e.clientY <= gr.bottom + 3 * c;
  const spot = inside ? freeSpot(t, hub().tiles, sx, sy) : null;
  let sh = g.querySelector(".hub-snap"); if (!sh) { sh = document.createElement("i"); sh.className = "hub-snap"; g.appendChild(sh); }
  sh.hidden = !spot; if (spot) place(sh, { ...spot, w: t.w, h: t.h }, c);
  drag.spot = spot;
}, { passive: false });
function finish(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  $("#hubGrid")?.querySelector(".hub-snap")?.remove();
  if (d.mode === "level") { if (d.moved || true) sendLevel(d.t, true); return; }
  if (d.mode === "tap") { if (!d.moved && !editing) run(d.t, d.el); return; }
  if (d.mode === "size") { if (d.moved) { const t = d.t, clash = hub().tiles.some((o) => o !== t && overlaps({ x: t.x, y: t.y, w: d.w, h: d.h }, o)); if (!clash) { t.w = d.w; t.h = d.h; saveSettings(); } } drawGrid(); return; }
  if (d.mode === "new" && !d.moved) { addTile(d.kind, null); return; }
  if (d.mode === "new") { if (d.spot) addTile(d.kind, d.spot); else drawGrid(); return; }
  if (d.mode === "move") { if (d.moved && d.spot) { d.t.x = d.spot.x; d.t.y = d.spot.y; saveSettings(); } drawGrid(); }
}
document.addEventListener("pointerup", finish);
document.addEventListener("pointercancel", (e) => { if (drag && e.pointerId === drag.pid) { drag = null; drawGrid(); } });
// keyboard: Enter or Space on a tile runs it
document.addEventListener("keydown", (e) => { const el = e.target.closest?.("#hubPage .hub-tile"); if (!el || editing || (e.key !== "Enter" && e.key !== " ")) return; e.preventDefault(); run(hub().tiles.find((x) => x.id === el.dataset.id), el); });
// the small buttons inside "Now playing"
document.addEventListener("click", async (e) => { const b = e.target.closest?.("#hubPage .pl-ctl button"); if (!b || editing) return; try { await pcCall("/pc/media", { key: b.dataset.k }); setTimeout(pollPlaying, 600); } catch (err) { toast(err.message); } });

// ---------- knobs and bars ----------
function levelFromPointer(d, e) {
  const r = d.el.getBoundingClientRect(); let v;
  if (d.t.kind.endsWith("bar")) {
    const vertical = r.height > r.width * 1.3, track = d.el.querySelector(".br-track").getBoundingClientRect();
    v = vertical ? (track.bottom - e.clientY) / track.height : (e.clientX - track.left) / track.width;
    v = clamp(Math.round(v * 100), 0, 100);
  } else v = clamp(Math.round(d.start + (d.y0 - e.clientY) * 0.6 + (e.clientX - d.x0) * 0.25), 0, 100);   // up or right turns it up
  const key = LEVEL[d.t.kind]; levels[key] = { ...(levels[key] || {}), level: v }; paintLevels(); sendLevel(d.t, false);
}
let levelSendT = 0, levelBusy = false, levelAgain = false;
async function sendLevel(t, final) {
  const key = LEVEL[t.kind], v = (levels[key] || {}).level; if (v == null) return;
  clearTimeout(levelSendT);
  if (levelBusy) { levelAgain = true; return; }
  levelBusy = true;
  try { const r = await pcCall("/pc/" + key, { level: v }); if (final) { levels[key] = r; paintLevels(); } }
  catch (e) { if (final) toast(e.message); }
  levelBusy = false;
  if (levelAgain) { levelAgain = false; levelSendT = setTimeout(() => sendLevel(t, final), 30); }
}
function paintLevels() {
  for (const el of document.querySelectorAll("#hubGrid .is-level")) {
    const t = hub().tiles.find((x) => x.id === el.dataset.id); if (!t) continue;
    const s = levels[LEVEL[t.kind]], v = s && typeof s.level === "number" ? s.level : null;
    el.classList.toggle("unknown", v == null); el.classList.toggle("muted", !!(s && s.mute));
    if (el.classList.contains("is-knob")) {
      const fill = el.querySelector(".kn-fill"), len = fill.getTotalLength ? fill.getTotalLength() : 170;
      fill.style.strokeDasharray = `${len} ${len}`; fill.style.strokeDashoffset = String(len * (1 - (v || 0) / 100));
      el.querySelector(".kn-dot").style.transform = `rotate(${-135 + 270 * (v || 0) / 100}deg)`;
      el.querySelector(".kn-val").textContent = v == null ? "–" : v + (s.mute ? " 🔇" : "");
    } else {
      const vertical = el.getBoundingClientRect().height > el.getBoundingClientRect().width * 1.3;
      el.classList.toggle("vertical", vertical);
      const f = el.querySelector(".br-fill"); f.style.width = vertical ? "100%" : (v || 0) + "%"; f.style.height = vertical ? (v || 0) + "%" : "100%";
      el.querySelector(".br-val").textContent = v == null ? "–" : v + "%";
    }
  }
}
async function pollLevels() {
  const keys = new Set(hub().tiles.map((t) => LEVEL[t.kind]).filter(Boolean));
  for (const k of keys) { if (drag && drag.mode === "level") return; try { levels[k] = await pcCall("/pc/" + k, null, "GET"); } catch (e) { levels[k] = { error: e.message }; } }
  paintLevels();
}

// ---------- now playing ----------
function paintPlaying() {
  for (const el of document.querySelectorAll("#hubGrid .k-playing")) {
    const p = playing, none = !p || p.none || !p.title;
    el.classList.toggle("idle", none); el.classList.toggle("paused", !!(p && /paused/i.test(p.status || "")));
    el.querySelector(".pl-title").textContent = none ? "Nothing playing" : p.title;
    el.querySelector(".pl-artist").textContent = none ? "" : [p.artist, (p.app || "").replace(/^.*[\\!]/, "").replace(/\.exe$/i, "")].filter(Boolean).join(" · ");
    const cov = el.querySelector(".pl-cover"); cov.style.backgroundImage = !none && p.coverUrl ? `url(${p.coverUrl})` : "";
  }
}
async function pollPlaying() {
  if (!document.querySelector("#hubGrid .k-playing")) return;
  try {
    const r = await pcCall("/pc/playing", { coverKey: playing && playing.coverKey || "" });
    if (r && !r.none) r.coverUrl = r.cover ? "data:image/jpeg;base64," + r.cover : (playing && playing.coverKey === r.coverKey ? playing.coverUrl : "");
    playing = r; paintPlaying();
  } catch {}
}

// ---------- adding a tile: some ask a question first (which program, which address, what to say, which steps) ----------
async function addTile(kind, spot) {
  const k = KIND[kind]; let t = { id: tid(), kind, w: k.size[0], h: k.size[1] };
  if (k.needs) { const r = await askFor(kind); if (!r) { drawGrid(); return; } t = { ...t, ...r }; }
  const p = spot ? freeSpot(t, hub().tiles, spot.x, spot.y) : firstFree(t, hub().tiles);
  t.x = p.x; t.y = p.y; hub().tiles.push(t); saveSettings(); drawGrid();
}
const STEP_HELP = `One step per line:
jarvis: open Spotify          (tell Jarvis)
app: Spotify                  (open a program by name)
url: https://youtube.com      (a website on the PC)
key: playpause                (playpause, next, prev, mute, volup, voldown)
volume: 30                    (set the volume)
wait: 2                       (seconds)`;
function askFor(kind) {
  return new Promise((done) => {
    const k = KIND[kind], box = document.createElement("div"); box.className = "hub-ask";
    box.innerHTML = `<div class="hub-ask-card"><h3></h3><div class="hub-ask-body"></div><div class="row"><span style="flex:1"></span><button class="btn small" data-a="no" type="button">Cancel</button><button class="btn small primary" data-a="ok" type="button">Add</button></div></div>`;
    box.querySelector("h3").textContent = "Add: " + k.label;
    const body = box.querySelector(".hub-ask-body"), finishIt = (v) => { box.remove(); done(v); };
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
    } else if (k.needs === "routine") {
      body.innerHTML = `<input class="hub-in" data-f="label" placeholder="Name, e.g. Movie night" autocomplete="off"><textarea class="hub-in" data-f="steps" rows="7" spellcheck="false" placeholder="${esc(STEP_HELP)}"></textarea><small class="hub-tip">${esc(STEP_HELP).replace(/\n/g, "<br>")}</small>`;
      value = () => {
        const steps = body.querySelector('[data-f="steps"]').value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(\w+)\s*:\s*(.+)$/.exec(l); return m ? { kind: m[1].toLowerCase(), arg: m[2].trim() } : null; }).filter(Boolean);
        if (!steps.length) return null;
        return { steps, label: body.querySelector('[data-f="label"]').value.trim() || "Routine" };
      };
    } else {
      const ph = k.needs === "url" ? "https://…" : kind === "jarvis" ? "e.g. open Spotify and play my liked songs" : "e.g. What's the weather like today?";
      body.innerHTML = `<input class="hub-in" data-f="arg" placeholder="${esc(ph)}" autocomplete="off"><input class="hub-in" data-f="label" placeholder="Name on the tile (optional)" autocomplete="off">`;
      value = () => {
        let a = body.querySelector('[data-f="arg"]').value.trim(); if (!a) return null;
        if (k.needs === "url" && !/^https?:\/\//i.test(a)) a = "https://" + a;
        return { arg: a, label: body.querySelector('[data-f="label"]').value.trim() || (k.needs === "url" ? a.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : a.slice(0, 28)) };
      };
    }
    box.querySelector('[data-a="no"]').onclick = () => finishIt(null);
    box.querySelector('[data-a="ok"]').onclick = () => { const v = value(); if (v) finishIt(v); };
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") box.querySelector('[data-a="ok"]').click(); if (e.key === "Escape") finishIt(null); });
    ($("#hubPage").classList.contains("hub-fs") ? $("#hubPage") : document.body).appendChild(box);
    setTimeout(() => box.querySelector(".hub-in")?.focus(), 30);
  });
}

// ---------- running a tile ----------
let appsCache = null;
async function runStep(s) {
  const k = s.kind, a = s.arg;
  if (k === "wait") return new Promise((r) => setTimeout(r, clamp(Number(a) || 1, 0, 60) * 1000));
  if (k === "jarvis") { const { status, j } = await jarvisCall("POST", "/ask", { text: a }); if (status !== 200) throw new Error(j.error || "Jarvis didn't take that"); return; }
  if (k === "key") { if (!MEDIA[a]) throw new Error(`"${a}" isn't a key the Hub knows`); return pcCall("/pc/media", { key: a }); }
  if (k === "volume") return pcCall("/pc/volume", { level: clamp(Number(a) || 0, 0, 100) });
  if (k === "url") return pcCall("/pc/openurl", { url: /^https?:\/\//i.test(a) ? a : "https://" + a });
  if (k === "app") {
    appsCache = appsCache || (await pcCall("/pc/apps", null, "GET")).apps || [];
    const want = a.toLowerCase(), hit = appsCache.find((x) => x.name.toLowerCase() === want) || appsCache.find((x) => x.name.toLowerCase().startsWith(want)) || appsCache.find((x) => x.name.toLowerCase().includes(want));
    if (!hit) throw new Error(`No program called "${a}" in the Start menu`);
    return pcCall("/pc/launch", { id: hit.id });
  }
  throw new Error(`Unknown step "${k}"`);
}
async function run(t, el) {
  if (!t) return;
  el && (el.classList.remove("hit"), void el.offsetWidth, el.classList.add("hit"));
  try {
    if (MEDIA[t.kind]) { await pcCall("/pc/media", { key: t.kind }); if (t.kind === "mute" || t.kind.startsWith("vol")) setTimeout(pollLevels, 300); }
    else if (t.kind === "playing") { await pcCall("/pc/media", { key: "playpause" }); setTimeout(pollPlaying, 600); }
    else if (t.kind === "app") { await pcCall("/pc/launch", { id: t.arg }); toast("Opening " + (t.label || "the program") + " on your PC"); }
    else if (t.kind === "pcurl") { await pcCall("/pc/openurl", { url: t.arg }); toast("Opened on your PC"); }
    else if (t.kind === "lock") { await pcCall("/pc/lockpc"); toast("Your PC is locked"); }
    else if (t.kind === "sleep") { if (!el || el.dataset.armed !== "1") { if (el) { el.dataset.armed = "1"; el.querySelector(".ht-sub").textContent = "Tap again to sleep"; setTimeout(() => { el.dataset.armed = ""; el.querySelector(".ht-sub").textContent = ""; }, 4000); } return; } await pcCall("/pc/sleep"); toast("Your PC is going to sleep"); }
    else if (t.kind === "routine") {
      const steps = t.steps || [];
      for (const [i, s] of steps.entries()) { if (el) el.querySelector(".ht-sub").textContent = `Step ${i + 1} of ${steps.length}…`; await runStep(s); }
      if (el) el.querySelector(".ht-sub").textContent = `${steps.length} step${steps.length === 1 ? "" : "s"}`; toast((t.label || "Routine") + " done");
    }
    else if (t.kind === "jarvis") { const { status, j } = await jarvisCall("POST", "/ask", { text: t.arg }); if (status !== 200) throw new Error(j.error || "Jarvis didn't take that"); toast("Jarvis: " + t.arg); }
    else if (t.kind === "ask") { fullSet(false); newChat("chat", "", false); setView("chat"); $("#prompt").value = t.arg; send(); }
    else if (t.kind === "page") { fullSet(false); if (t.arg === "chat") { newChat("chat", "", false); setView("chat"); } else setView(t.arg); }
    else if (t.kind === "link") window.open(t.arg, "_blank", "noopener");
    if (el) el.classList.add("ok");
  } catch (e) { toast(e.message); if (el) { el.classList.add("bad"); if (t.kind === "routine") el.querySelector(".ht-sub").textContent = "Stopped: " + e.message.slice(0, 40); } }
  if (el) setTimeout(() => el.classList.remove("ok", "bad"), 900);
}

// ---------- live tiles: clock, PC load, knobs and bars, now playing ----------
function live() {
  clearInterval(clockT); clearInterval(statsT); clearInterval(playT); clearInterval(levelT);
  const on = document.body.classList.contains("hub-view") || $("#hubPage")?.classList.contains("hub-fs");
  if (!on) return;
  const has = (k) => !!document.querySelector("#hubGrid .k-" + k);
  const paintClock = () => document.querySelectorAll("#hubGrid .k-clock").forEach((el) => { const d = new Date(); el.querySelector(".ht-lb").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); el.querySelector(".ht-sub").textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }); });
  if (has("clock")) { paintClock(); clockT = setInterval(paintClock, 10000); }
  const paintStats = () => document.querySelectorAll("#hubGrid .k-stats").forEach((el) => { if (!stats) return; el.querySelector(".ht-lb").textContent = `CPU ${Math.round(stats.cpu || 0)}%`; el.querySelector(".ht-sub").textContent = [stats.gpu ? `GPU ${Math.round(stats.gpu.util || 0)}% · ${Math.round(stats.gpu.temp || 0)}°C` : "", `RAM ${(stats.memUsedGB || 0).toFixed(1)} GB`].filter(Boolean).join(" · "); });
  const getStats = async () => { try { stats = await pcCall("/pc/stats", null, "GET"); paintStats(); } catch {} };
  if (has("stats")) { paintStats(); getStats(); statsT = setInterval(getStats, 3000); }
  if (document.querySelector("#hubGrid .is-level")) { pollLevels(); levelT = setInterval(() => { if (!drag) pollLevels(); }, 4000); }
  if (has("playing")) { pollPlaying(); playT = setInterval(pollPlaying, 3000); }
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
window.hubClose = () => { if (!$("#hubPage")?.classList.contains("hub-fs")) { clearInterval(clockT); clearInterval(statsT); clearInterval(playT); clearInterval(levelT); } };
window.hubTest = { freeSpot, overlaps, hub };
})();
