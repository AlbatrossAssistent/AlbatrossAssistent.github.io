"use strict";
// The Monitor: shows a picture or a video full screen on the PC's own screen (host/monitor.js and host/monitor.html do it there).
// Pick what to show (a file on the PC, the newest generated picture, a YouTube video, a web address, or a file from this
// device), how (fit, fill, background, turn, zoom), with which options (sound, loop, speed, clock, caption), and on which
// display; the PC's displays are listed with their resolution and refresh rate. Videos can be played, paused and moved.
// Uses the main page's helpers: $, $$, esc, toast, pcCall, connected, bytesToB64.
(() => {
let st = null, tab = "files", fileKind = "", files = [], filesAt = 0, q = "", pollT = 0, setT = 0, pendingSet = null, lastLocal = 0, upload = null;
const page = () => $("#monitorPage");
const call = (body) => pcCall("/pc/monitor", body);
const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
const size = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
const I = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  image: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  video: I('<rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="M16 10l5-3v10l-5-3z"/>'),
  youtube: I('<rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="M10 9v6l5-3z" fill="currentColor"/>'),
  none: I('<rect x="3" y="4" width="18" height="12" rx="2.2"/><path d="M8 20h8M12 16v4"/>'),
  play: I('<path d="M7 5v14l11-7z" fill="currentColor"/>'), pause: I('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  back: I('<path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/>'), fwd: I('<path d="M13 7l5 5-5 5M6 7l5 5-5 5"/>'), restart: I('<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/>'),
};

// ---------- the page ----------
function render() {
  const p = page(); if (!p) return;
  p.innerHTML = `<div class="mon-wrap">
    <div class="hub-bar"><h1>Monitor</h1><span class="hub-sub">A picture or video full screen on your PC's screen</span><span style="flex:1"></span>
      <span class="mon-state" id="monState"><span class="dot"></span><span>Checking…</span></span>
      <button class="btn small" id="monClose" type="button">Close window</button>
      <button class="btn small primary" id="monOpen" type="button">Open on screen</button></div>
    <div class="mon-grid">
      <div class="home-card mon-now"><h3>Now showing</h3><div id="monNow"></div></div>
      <div class="home-card mon-src"><h3>What to show</h3>
        <div class="seg mon-tabs" id="monTabs" role="tablist">
          <button data-t="files">PC files</button><button data-t="latest">Newest picture</button><button data-t="youtube">YouTube</button><button data-t="url">Link</button><button data-t="device">From this device</button></div>
        <div id="monSrc"></div></div>
      <div class="home-card mon-layout"><h3>Layout</h3><div id="monLayout"></div></div>
      <div class="home-card mon-opts"><h3>Options</h3><div id="monOpts"></div></div>
      <div class="home-card mon-data"><h3>Monitor data <button class="btn small" id="monRescan" type="button" style="margin-left:auto">Check again</button></h3><div id="monData"></div></div>
    </div></div>`;
  $("#monOpen").onclick = () => act({ action: "open", screen: st ? st.screen : -1 }, "Opening on the PC's screen…");
  $("#monClose").onclick = () => act({ action: "close" });
  $("#monRescan").onclick = () => act({ action: "screens" });
  for (const b of $$("#monTabs button")) b.onclick = () => { tab = b.dataset.t; drawSrc(); };
  drawSrc(); drawLayout(); drawOpts();
  refresh();
}
async function act(body, msg) {
  if (!connected) return toast("Connect to your PC first");
  try { if (msg) toast(msg); show(await call(body)); }
  catch (e) { toast("Monitor: " + e.message); }
}
async function refresh() {
  clearTimeout(pollT);
  if (!page() || !document.body.classList.contains("monitor-view")) return;
  if (connected && !document.hidden) { try { show(await pcCall("/pc/monitor", null, "GET")); } catch (e) { setState("bad", e.message.slice(0, 80)); } }
  else if (!connected) setState("bad", "Not connected to your PC");
  const live = st && st.open && st.playback && st.playback.duration;
  pollT = setTimeout(refresh, live ? 1500 : 4000);
}
function setState(cls, text) { const el = $("#monState"); if (!el) return; el.className = "mon-state " + cls; el.lastElementChild.textContent = text; }
function show(s) {
  if (!s || !page()) return;
  const first = !st; st = s;
  setState(s.open ? "ok" : s.opening ? "warn" : "", s.open ? "On screen" : s.opening ? "Opening…" : s.error ? "Couldn't open: " + s.error : "Window closed");
  $("#monClose").hidden = !s.open && !s.opening;
  $("#monOpen").textContent = s.open ? "Open again" : "Open on screen";
  drawNow(); drawData();
  // the controls follow the PC, except right after a change made here (it's still on its way)
  if (first || Date.now() - lastLocal > 2500) { fillLayout(); fillOpts(); }
  if (tab === "latest") drawSrc();
}

// ---------- now showing, with play / pause / seek ----------
function drawNow() {
  const el = $("#monNow"); if (!el || !st) return;
  const s = st.source, pb = st.playback, k = s.kind || "none";
  const video = k === "video" || k === "youtube";
  const where = s.type === "file" ? s.label : s.type === "latest" ? "Newest generated picture · follows new ones" : s.type === "youtube" ? "YouTube" : s.type === "url" ? "From the web" : "";
  const thumb = k === "youtube" && s.id ? `<img class="mon-thumb" alt="" src="https://i.ytimg.com/vi/${encodeURIComponent(s.id)}/hqdefault.jpg">` : `<span class="mon-ic">${IC[k] || IC.none}</span>`;
  const dims = pb && pb.w ? ` · ${pb.w}×${pb.h}` : "";
  const key = [s.type, s.name, s.url, video].join("|");
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = `<div class="mon-head">${thumb}<div class="mon-tx"><b></b><small></small></div>${s.type !== "none" ? `<button class="btn small" id="monBlank" type="button">Show nothing</button>` : ""}</div>
      ${video ? `<div class="mon-ctl">
        <button class="icon-btn" data-c="restart" aria-label="From the start" title="From the start">${IC.restart}</button>
        <button class="icon-btn" data-c="skip" data-a="-10" aria-label="Back 10 seconds" title="Back 10 s">${IC.back}</button>
        <button class="icon-btn mon-pp" data-c="toggle" aria-label="Play or pause" title="Play / pause">${IC.pause}</button>
        <button class="icon-btn" data-c="skip" data-a="10" aria-label="Forward 10 seconds" title="Forward 10 s">${IC.fwd}</button>
        <span class="mon-time" id="monTime">–</span></div>
        <input type="range" class="mon-seek" id="monSeek" min="0" max="1000" value="0" aria-label="Position">` : ""}
      <div class="mon-err" id="monErr" hidden></div>`;
    el.querySelector("b").textContent = s.type === "none" ? "Nothing yet" : s.name || s.url || "";
    for (const b of el.querySelectorAll("[data-c]")) b.onclick = () => act({ action: "control", cmd: b.dataset.c, arg: Number(b.dataset.a || 0) });
    const seek = $("#monSeek");
    if (seek) {
      seek.oninput = () => { seek.dataset.drag = "1"; const d = st.playback?.duration || 0; $("#monTime").textContent = `${mmss(seek.value / 1000 * d)} / ${mmss(d)}`; };
      seek.onchange = () => { const d = st.playback?.duration || 0; delete seek.dataset.drag; if (d) act({ action: "control", cmd: "seek", arg: seek.value / 1000 * d }); };
    }
    const blank = $("#monBlank"); if (blank) blank.onclick = () => act({ action: "show", source: { type: "none" }, open: false });
  }
  el.querySelector("small").textContent = s.type === "none" ? "Pick a picture or video below." : where + dims;
  if (video) {
    const pp = el.querySelector(".mon-pp"); if (pp) { pp.innerHTML = pb && pb.playing ? IC.pause : IC.play; }
    const seek = $("#monSeek");
    if (pb && pb.duration) { if (!seek.dataset.drag) { seek.value = Math.round(pb.time / pb.duration * 1000); $("#monTime").textContent = `${mmss(pb.time)} / ${mmss(pb.duration)}`; } seek.disabled = false; }
    else { seek.disabled = true; $("#monTime").textContent = st.open ? "Loading…" : "Not on screen"; }
  }
  const err = $("#monErr"); err.hidden = !(pb && pb.error); if (pb && pb.error) err.textContent = pb.error;
}

// ---------- what to show ----------
function drawSrc() {
  for (const b of $$("#monTabs button")) b.classList.toggle("on", b.dataset.t === tab);
  const el = $("#monSrc"); if (!el) return;
  if (tab === "files") {
    if (el.dataset.tab !== "files") {
      el.dataset.tab = "files";
      el.innerHTML = `<div class="mon-filter"><div class="seg" id="monKind"><button data-k="">All</button><button data-k="image">Pictures</button><button data-k="video">Videos</button></div>
        <input type="search" id="monQ" placeholder="Search" autocomplete="off" aria-label="Search files"></div><div class="mon-files" id="monFiles"><div class="empty-note">Loading…</div></div>`;
      for (const b of $$("#monKind button")) b.onclick = () => { fileKind = b.dataset.k; loadFiles(true); };
      $("#monQ").value = q; $("#monQ").oninput = (e) => { q = e.target.value; drawFiles(); };
    }
    loadFiles(Date.now() - filesAt > 20000);
  } else if (tab === "latest") {
    el.dataset.tab = "latest";
    const on = st && st.source.type === "latest";
    el.innerHTML = `<p class="mon-p">The newest picture made with Albatross on the PC. While it shows, every new picture (from a chat or a list) replaces it by itself.</p>
      <button class="btn primary" id="monLatest" type="button">${on ? "Showing the newest picture" : "Show the newest picture"}</button>`;
    $("#monLatest").onclick = () => act({ action: "show", source: { type: "latest" } });
  } else if (tab === "youtube") {
    el.dataset.tab = "youtube";
    el.innerHTML = `<p class="mon-p">Paste a YouTube link (videos, Shorts, live streams; a time like &t=90 starts there).</p>
      <form class="mon-row" id="monYtF"><input id="monYt" type="url" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" required><button class="btn primary" type="submit">Show</button></form>`;
    $("#monYtF").onsubmit = (e) => { e.preventDefault(); act({ action: "show", source: { type: "youtube", url: $("#monYt").value.trim() } }); };
  } else if (tab === "url") {
    el.dataset.tab = "url";
    el.innerHTML = `<p class="mon-p">The address of a picture or a video file on the web (a YouTube link works too).</p>
      <form class="mon-row" id="monUrlF"><input id="monUrl" type="url" placeholder="https://…/picture.jpg or …/video.mp4" autocomplete="off" required>
      <select id="monUrlKind" aria-label="Kind"><option value="">Auto</option><option value="image">Picture</option><option value="video">Video</option></select><button class="btn primary" type="submit">Show</button></form>`;
    $("#monUrlF").onsubmit = (e) => { e.preventDefault(); act({ action: "show", source: { type: "url", url: $("#monUrl").value.trim(), kind: $("#monUrlKind").value } }); };
  } else if (tab === "device") {
    el.dataset.tab = "device";
    el.innerHTML = `<p class="mon-p">Send a picture or video from this device. It's saved on the PC in Downloads\\Albatross\\Monitor and shown right away.</p>
      <label class="btn primary mon-pick"><input type="file" id="monFile" accept="image/*,video/*" hidden>Choose a picture or video…</label>
      <div class="mon-up" id="monUp" hidden><small></small><div class="progress"><div></div></div><button class="btn small" id="monUpX" type="button">Cancel</button></div>`;
    $("#monFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) send(f); };
    $("#monUpX").onclick = () => { if (upload) upload.cancel = true; };
    if (upload) showUpload();
  }
}
async function loadFiles(force) {
  for (const b of $$("#monKind button")) b.classList.toggle("on", b.dataset.k === fileKind);
  if (!force && files.length) return drawFiles();
  if (!connected) { const l = $("#monFiles"); if (l) l.innerHTML = '<div class="empty-note">Connect to your PC to see its pictures and videos.</div>'; return; }
  try { const r = await call({ action: "files", kind: fileKind }); files = r.files || []; filesAt = Date.now(); drawFiles(); }
  catch (e) { const l = $("#monFiles"); if (l) l.innerHTML = `<div class="empty-note">Couldn't list the PC's files: ${esc(e.message)}</div>`; }
}
function drawFiles() {
  const l = $("#monFiles"); if (!l) return;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = files.filter((f) => words.every((w) => (f.name + " " + f.label).toLowerCase().includes(w))).slice(0, 200);
  l.innerHTML = list.length ? "" : `<div class="empty-note">${files.length ? "Nothing matches." : "No pictures or videos found in Albatross pictures, received files, Pictures, Videos or Downloads."}</div>`;
  const cur = st && st.source;
  for (const f of list) {
    const b = document.createElement("button"); b.type = "button"; b.className = "mon-file" + (cur && cur.rel === f.rel && cur.root === f.root ? " on" : "");
    b.innerHTML = `<span class="mon-ic">${IC[f.kind]}</span><span class="mon-tx"><b></b><small></small></span>`;
    b.querySelector("b").textContent = f.name;
    b.querySelector("small").textContent = `${f.label} · ${size(f.size)} · ${new Date(f.time).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    b.onclick = () => act({ action: "show", source: { type: "file", root: f.root, rel: f.rel } }).then(drawFiles);
    l.appendChild(b);
  }
}
// a file from this device, in pieces of 3 MB (end-to-end encrypted like everything else when connected with the code)
async function send(f) {
  if (!connected) return toast("Connect to your PC first");
  if (upload) return toast("Wait for the file that's on its way");
  upload = { name: f.name, size: f.size, got: 0, cancel: false };
  showUpload();
  try {
    const { id } = await call({ action: "upload-start", name: f.name, size: f.size });
    const CH = 3 * 1024 * 1024;
    for (let off = 0; off < f.size; off += CH) {
      if (upload.cancel) throw new Error("Cancelled");
      const buf = new Uint8Array(await f.slice(off, off + CH).arrayBuffer());
      await call({ action: "upload-chunk", id, offset: off, data: bytesToB64(buf) });
      upload.got = Math.min(f.size, off + CH); showUpload();
    }
    show(await call({ action: "upload-end", id }));
    toast("On the PC's screen: " + f.name);
    filesAt = 0;
  } catch (e) { toast(e.message === "Cancelled" ? "Not sent" : "Couldn't send it: " + e.message); }
  finally { upload = null; showUpload(); }
}
function showUpload() {
  const box = $("#monUp"); if (!box) return;
  box.hidden = !upload; if (!upload) return;
  box.querySelector("small").textContent = `Sending ${upload.name} · ${size(upload.got)} of ${size(upload.size)}`;
  box.querySelector(".progress div").style.width = (upload.got / upload.size * 100) + "%";
}

// ---------- layout and options (sent a moment after the last change) ----------
const seg = (id, items) => `<div class="seg mon-seg" id="${id}">${items.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join("")}</div>`;
function drawLayout() {
  $("#monLayout").innerHTML = `
    <div class="mon-f"><label>Size</label>${seg("mlFit", [["contain", "Fit"], ["cover", "Fill"], ["fill", "Stretch"], ["none", "Original"]])}</div>
    <div class="mon-f"><label>Background</label>${seg("mlBg", [["black", "Black"], ["blur", "Blurred"], ["gray", "Gray"], ["white", "White"]])}</div>
    <div class="mon-f"><label>Turn</label>${seg("mlRot", [["0", "0°"], ["90", "90°"], ["180", "180°"], ["270", "270°"]])}</div>
    <div class="mon-f"><label for="mlZoom">Zoom <span id="mlZoomV"></span></label><input type="range" id="mlZoom" min="25" max="400" step="5"></div>
    <label class="check"><span>Mirror<small>Flip left and right</small></span><input type="checkbox" class="switch" id="mlMirror"></label>
    <div class="row"><button class="btn small" id="mlReset" type="button">Reset layout and options</button></div>`;
  segWire("mlFit", (v) => setLayout({ fit: v })); segWire("mlBg", (v) => setLayout({ bg: v })); segWire("mlRot", (v) => setLayout({ rotate: Number(v) }));
  $("#mlZoom").oninput = (e) => { $("#mlZoomV").textContent = e.target.value + "%"; setLayout({ zoom: Number(e.target.value) }); };
  $("#mlZoom").ondblclick = () => { $("#mlZoom").value = 100; $("#mlZoom").oninput({ target: $("#mlZoom") }); };
  $("#mlMirror").onchange = (e) => setLayout({ mirror: e.target.checked });
  $("#mlReset").onclick = () => act({ action: "set", reset: true }).then(() => { fillLayout(); fillOpts(); });
}
function drawOpts() {
  $("#monOpts").innerHTML = `
    <label class="check"><span>Sound<small>For videos</small></span><input type="checkbox" class="switch" id="moSound"></label>
    <div class="mon-f"><label for="moVol">Volume <span id="moVolV"></span></label><input type="range" id="moVol" min="0" max="100"></div>
    <label class="check"><span>Loop<small>Start the video again at the end</small></span><input type="checkbox" class="switch" id="moLoop"></label>
    <div class="mon-f"><label>Speed</label>${seg("moSpeed", [["0.5", "0.5×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2×"]])}</div>
    <div class="mon-f"><label>Clock</label>${seg("moClock", [["off", "Off"], ["tl", "↖"], ["tr", "↗"], ["bl", "↙"], ["br", "↘"]])}</div>
    <div class="mon-f"><label for="moCap">Caption</label><div class="mon-row"><input id="moCap" maxlength="200" placeholder="Text on the screen (empty: none)">${seg("moCapPos", [["top", "Top"], ["bottom", "Bottom"]])}</div></div>
    <label class="check"><span>Info corner<small>Name, size, display and time of what's showing</small></span><input type="checkbox" class="switch" id="moInfo"></label>`;
  $("#moSound").onchange = (e) => setOpts({ mute: !e.target.checked });
  $("#moVol").oninput = (e) => { $("#moVolV").textContent = e.target.value + "%"; setOpts({ volume: Number(e.target.value) }); };
  $("#moLoop").onchange = (e) => setOpts({ loop: e.target.checked });
  segWire("moSpeed", (v) => setOpts({ speed: Number(v) })); segWire("moClock", (v) => setOpts({ clock: v })); segWire("moCapPos", (v) => setOpts({ captionPos: v }));
  $("#moCap").oninput = (e) => setOpts({ caption: e.target.value });
  $("#moInfo").onchange = (e) => setOpts({ info: e.target.checked });
}
function segWire(id, fn) { for (const b of $$(`#${id} button`)) b.onclick = () => { segOn(id, b.dataset.v); fn(b.dataset.v); }; }
function segOn(id, v) { for (const b of $$(`#${id} button`)) b.classList.toggle("on", b.dataset.v === String(v)); }
function fillLayout() {
  if (!st || !$("#mlFit")) return;
  const L = st.layout;
  segOn("mlFit", L.fit); segOn("mlBg", L.bg); segOn("mlRot", L.rotate);
  $("#mlZoom").value = L.zoom; $("#mlZoomV").textContent = L.zoom + "%"; $("#mlMirror").checked = L.mirror;
}
function fillOpts() {
  if (!st || !$("#moSound")) return;
  const o = st.opts;
  $("#moSound").checked = !o.mute; $("#moVol").value = o.volume; $("#moVolV").textContent = o.volume + "%"; $("#moLoop").checked = o.loop;
  segOn("moSpeed", o.speed); segOn("moClock", o.clock); segOn("moCapPos", o.captionPos); $("#moInfo").checked = o.info;
  if (document.activeElement !== $("#moCap")) $("#moCap").value = o.caption;
}
function queueSet(part) {
  lastLocal = Date.now();
  pendingSet = pendingSet || { action: "set", layout: {}, opts: {} };
  Object.assign(pendingSet.layout, part.layout || {}); Object.assign(pendingSet.opts, part.opts || {});
  clearTimeout(setT);
  setT = setTimeout(async () => {
    const body = pendingSet; pendingSet = null;
    if (!connected) return toast("Connect to your PC first");
    try { const s = await call(body); lastLocal = Date.now(); show(s); } catch (e) { toast("Monitor: " + e.message); }
  }, 250);
}
const setLayout = (l) => queueSet({ layout: l }), setOpts = (o) => queueSet({ opts: o });

// ---------- the PC's displays ----------
function drawData() {
  const el = $("#monData"); if (!el || !st) return;
  const list = st.screens || [];
  const pb = st.playback;
  const sig = JSON.stringify([list, st.screen, st.open, pb && [pb.w, pb.h]]);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const active = list.find((s) => s.i === st.screen) || list.find((s) => s.primary) || list[0];
  el.innerHTML = list.length ? "" : `<div class="empty-note">${st.open || st.opening ? "Looking for the PC's displays…" : "Press Open on screen (or Check again) to see the PC's displays. Someone has to be signed in on the PC."}</div>`;
  for (const s of list) {
    const b = document.createElement("button"); b.type = "button"; b.className = "mon-disp" + (s === active ? " on" : "");
    const scale = s.pw && s.w ? Math.round(s.pw / s.w * 100) : 0;
    const turned = { 1: " · turned 90°", 2: " · upside down", 3: " · turned 270°" }[s.rot] || "";
    b.innerHTML = `<span class="mon-scr" style="aspect-ratio:${s.pw || s.w}/${s.ph || s.h}"><b>${s.i + 1}</b></span><span class="mon-tx"><b></b><small></small><small></small></span>`;
    b.querySelector(".mon-tx b").textContent = `Display ${s.i + 1}${s.primary ? " · main" : ""}${s === active ? (st.open ? " · showing here" : " · will show here") : ""}`;
    const sm = b.querySelectorAll(".mon-tx small");
    sm[0].textContent = `${s.pw || s.w} × ${s.ph || s.h}${s.hz ? ` · ${s.hz} Hz` : ""}${s.bits ? ` · ${s.bits}-bit colour` : ""}${scale && scale !== 100 ? ` · scaled ${scale}%` : ""}${turned}`;
    sm[1].textContent = [s.name, s.gpu].filter(Boolean).join(" · ") + ` · at ${s.x}, ${s.y}`;
    b.onclick = () => { if (s !== active) act({ action: "screen", screen: s.i }, st.open ? `Moving to display ${s.i + 1}…` : ""); };
    el.appendChild(b);
  }
  if (pb && pb.w) el.insertAdjacentHTML("beforeend", `<div class="mon-p" style="margin-top:8px">What's showing is ${pb.w} × ${pb.h} pixels.</div>`);
}

window.monitorOpen = render;
window.monitorClose = () => { clearTimeout(pollT); };
document.addEventListener("visibilitychange", () => { if (!document.hidden && document.body.classList.contains("monitor-view")) refresh(); });
})();
