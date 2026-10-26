"use strict";
// The Browser view: Chrome runs on the PC (host/browser.js), its screen arrives here as pictures, and clicks, taps, scrolling and typing
// go back to it. Uses the main page's helpers: $, pcCall, pcStream, remotePC, connected, sleepMs, toast.
(() => {
const BV = { open: false, ctrl: null, st: null, frame: { w: 0, h: 0 }, vp: null, queue: Promise.resolve(), moveT: 0, wheel: { dx: 0, dy: 0, x: 0, y: 0, timer: 0 }, text: "", textT: 0, resizeT: 0 };
const call = (p, body) => pcCall(p, body || {});
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown", "F5"]);

// inputs go to the PC one after another, in order
const inTime = (pr, ms) => Promise.race([pr, new Promise((r) => setTimeout(r, ms))]);
function sendInput(o) {
  if (o.t !== "text" && BV.text) flushText();
  BV.queue = BV.queue.then(() => inTime(call("/browser/input", o).catch(() => {}), 6000));
  return BV.queue;
}
// typed letters are sent in small groups, not one request per letter
function typeText(t) { BV.text += t; clearTimeout(BV.textT); BV.textT = setTimeout(flushText, remotePC() ? 60 : 25); }
function flushText() { clearTimeout(BV.textT); const t = BV.text; BV.text = ""; if (t) BV.queue = BV.queue.then(() => call("/browser/input", { t: "text", text: t }).catch(() => {})); }
const mods = (e) => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });

function viewSize() {
  const r = $("#bvScreen").getBoundingClientRect();
  const touch = matchMedia("(pointer: coarse)").matches;
  return { w: Math.max(240, Math.floor(r.width)), h: Math.max(240, Math.floor(r.height)), dpr: remotePC() ? 1 : Math.min(devicePixelRatio || 1, 1.5), mobile: touch && r.width < 760, quality: remotePC() ? 42 : 60 };
}
async function open() {
  BV.open = true;
  const msg = $("#bvMsg");
  if (!connected) { msg.hidden = false; msg.textContent = "Connect to your PC first (Home → Connect)."; return; }
  msg.hidden = false; msg.textContent = "Starting Chrome on your PC…";
  await new Promise((r) => requestAnimationFrame(r));
  try { BV.vp = viewSize(); paint(await call("/browser/start", BV.vp)); }
  catch (e) { msg.textContent = "Couldn't start the browser: " + e.message + (/Unknown|404/.test(e.message) ? " (restart the Albatross host on your PC to update it)" : ""); return; }
  watch();
}
function close() { BV.open = false; if (BV.ctrl) BV.ctrl.abort(); BV.ctrl = null; }
async function watch() {
  if (BV.ctrl) BV.ctrl.abort();
  const ctrl = BV.ctrl = new AbortController(), dec = new TextDecoder();
  let fails = 0;
  while (BV.open && !ctrl.signal.aborted) {
    try {
      const res = await pcStream("/browser/stream", { fps: remotePC() ? 12 : 25 }, ctrl.signal);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rd = res.body.getReader(); let buf = ""; fails = 0;
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 1);
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.img) frame(o);
          if (o.st) paint(o.st);
          if (o.error) { $("#bvMsg").hidden = false; $("#bvMsg").textContent = o.error; }
          if (o.closed) { $("#bvMsg").hidden = false; $("#bvMsg").textContent = "The browser was closed. Tap here to start it again."; }
        }
      }
    } catch (e) { if (ctrl.signal.aborted) return; fails++; }
    if (!BV.open) return;
    await sleepMs(Math.min(3000, 400 * (fails + 1)));
  }
}
function frame(o) { BV.frame = { w: o.w, h: o.h }; $("#bvImg").src = "data:image/jpeg;base64," + o.img; $("#bvMsg").hidden = true; }
function paint(st) {
  if (!st || st.closed) return;
  BV.st = st;
  if (document.activeElement !== $("#bvUrl")) $("#bvUrl").value = st.url && st.url !== "about:blank" ? st.url : "";
  $("#bvBack").disabled = !st.back; $("#bvFwd").disabled = !st.fwd;
  $("#bvPriv").classList.toggle("on", !!st.private); $("#bvPriv").setAttribute("aria-pressed", String(!!st.private));
  $("#browserPage").classList.toggle("private", !!st.private);
  $("#bvUrl").placeholder = st.private ? "Private: nothing is saved" : "Search or type a web address";
  $("#bvLoad").classList.toggle("on", !!st.loading);
  $("#bvTabsBtn").textContent = String((st.tabs || []).length || 1);
  renderTabs();
  const d = st.dialog, box = $("#bvDialog");
  box.hidden = !d;
  if (d) { $("#bvDMsg").textContent = d.message || (d.type === "beforeunload" ? "Leave this page?" : ""); $("#bvDIn").hidden = d.type !== "prompt"; $("#bvDIn").value = d.prompt || ""; $("#bvDNo").hidden = d.type === "alert"; }
  $("#bvFoot").hidden = !st.download; $("#bvFoot").textContent = st.download || "";
}
function renderTabs() {
  const box = $("#bvTabs"), st = BV.st; if (!st || box.hidden) return;
  box.innerHTML = "";
  for (const t of st.tabs || []) {
    const b = document.createElement("button"); b.type = "button"; b.className = t.id === st.active ? "on" : "";
    b.innerHTML = "<span></span><i title=\"Close tab\">✕</i>"; b.firstChild.textContent = t.title || t.url || "New tab";
    b.onclick = (e) => { if (e.target.tagName === "I") call("/browser/tab", { action: "close", id: t.id }).then(paint).catch((x) => toast(x.message)); else call("/browser/tab", { action: "switch", id: t.id }).then(paint).catch((x) => toast(x.message)); };
    box.appendChild(b);
  }
  const n = document.createElement("button"); n.type = "button"; n.className = "bv-new"; n.textContent = "+"; n.title = "New tab";
  n.onclick = () => call("/browser/tab", { action: "new" }).then(paint).catch((x) => toast(x.message));
  box.appendChild(n);
  if (!st.private) {
    const c = document.createElement("button"); c.type = "button"; c.className = "bv-clear"; c.textContent = "Clear history";
    c.title = "Delete the browsing history on the PC (logins stay)";
    let armed = 0;
    c.onclick = async () => {
      if (Date.now() - armed > 4000) { armed = Date.now(); c.textContent = "Tap again to clear"; setTimeout(() => (c.textContent = "Clear history"), 4000); return; }
      c.textContent = "Clearing…";
      try { const r = await call("/browser/clearhistory", {}); toast("History cleared on your PC"); await sleepMs(600); BV.open = false; open(); } catch (e) { toast("Couldn't clear it: " + e.message); }
    };
    box.appendChild(c);
  }
}
// where on the page a pointer is (the picture is drawn at the top left, scaled to fit)
function pos(e) {
  const r = $("#bvImg").getBoundingClientRect(), fw = BV.frame.w || (BV.vp && BV.vp.w) || r.width, fh = BV.frame.h || (BV.vp && BV.vp.h) || r.height;
  const sc = Math.min(r.width / fw, r.height / fh) || 1;
  return { x: Math.round((e.clientX - r.left) / sc), y: Math.round((e.clientY - r.top) / sc), sc };
}
function queueWheel(p, dx, dy) {
  const w = BV.wheel; w.dx += dx; w.dy += dy; w.x = p.x; w.y = p.y;
  if (w.timer || w.busy) return;
  w.timer = setTimeout(flushWheel, remotePC() ? 50 : 25);
}
// one scroll request at a time: whatever the finger or wheel did meanwhile goes in the next one, so a slow connection never piles up a backlog
function flushWheel() {
  const w = BV.wheel; w.timer = 0;
  if (!w.dx && !w.dy) return;
  const o = { t: "wheel", x: w.x, y: w.y, dx: Math.round(w.dx), dy: Math.round(w.dy) }; w.dx = w.dy = 0; w.busy = true;
  sendInput(o).then(() => { w.busy = false; if (w.dx || w.dy) flushWheel(); });
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  const img = $("#bvImg"), scr = $("#bvScreen"), ta = $("#bvType");
  $("#bvBack").onclick = () => call("/browser/nav", { action: "back" }).then(paint).catch((e) => toast(e.message));
  $("#bvFwd").onclick = () => call("/browser/nav", { action: "forward" }).then(paint).catch((e) => toast(e.message));
  $("#bvReload").onclick = () => call("/browser/nav", { action: BV.st && BV.st.loading ? "stop" : "reload" }).then(paint).catch((e) => toast(e.message));
  $("#bvForm").onsubmit = (e) => { e.preventDefault(); const u = $("#bvUrl").value.trim(); if (!u) return; $("#bvUrl").blur(); call("/browser/nav", { url: u }).then(paint).catch((x) => toast(x.message)); };
  $("#bvUrl").onfocus = () => $("#bvUrl").select();
  $("#bvPriv").onclick = () => {
    const on = !(BV.st && BV.st.private);
    call("/browser/private", { on }).then((st) => { paint(st); toast(on ? "Private: nothing you open now is saved" : "Private session closed and deleted"); }).catch((e) => toast(e.message));
  };
  $("#bvTabsBtn").onclick = () => { $("#bvTabs").hidden = !$("#bvTabs").hidden; renderTabs(); };
  $("#bvMsg").onclick = () => { if (/closed/.test($("#bvMsg").textContent)) open(); };
  $("#bvDOk").onclick = () => call("/browser/dialog", { accept: true, text: $("#bvDIn").hidden ? undefined : $("#bvDIn").value }).then(paint).catch(() => {});
  $("#bvDNo").onclick = () => call("/browser/dialog", { accept: false }).then(paint).catch(() => {});

  // mouse: press, move, release like on the PC. Touch: tap = click, drag = scroll.
  let ptr = null;
  img.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (e.pointerType === "mouse") { scr.focus({ preventScroll: true }); ptr = { mouse: true }; sendInput({ t: "down", ...pos(e), button: ["left", "middle", "right"][e.button] || "left", count: e.detail || 1, ...mods(e) }); return; }
    if (!("ontouchstart" in window)) { ptr = { x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, p: pos(e) }; try { img.setPointerCapture(e.pointerId); } catch {} }   // a pen, or touch without touch events
  });
  let tch = null;
  img.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const t = e.touches[0]; if (!t || e.touches.length > 1) { tch = null; return; }
    tch = { x0: t.clientX, y0: t.clientY, lx: t.clientX, ly: t.clientY, moved: false, p: pos(t), t0: Date.now() };
  }, { passive: false });
  img.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const t = e.touches[0]; if (!tch || !t) return;
    const dx = t.clientX - tch.lx, dy = t.clientY - tch.ly;
    if (Math.hypot(t.clientX - tch.x0, t.clientY - tch.y0) > 8) tch.moved = true;
    tch.lx = t.clientX; tch.ly = t.clientY;
    if (tch.moved) queueWheel(tch.p, -dx / tch.p.sc, -dy / tch.p.sc);
  }, { passive: false });
  img.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (tch && !tch.moved) sendInput({ t: "click", x: tch.p.x, y: tch.p.y, count: 1 });
    tch = null;
  }, { passive: false });
  img.addEventListener("touchcancel", () => { tch = null; });
  img.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") {
      const now = Date.now(); if (now - BV.moveT < (remotePC() ? 70 : 30)) return; BV.moveT = now;
      sendInput({ t: "move", ...pos(e), drag: !!(e.buttons & 1) }); return;
    }
    if (!ptr || ptr.mouse) return;
    const dx = e.clientX - ptr.lx, dy = e.clientY - ptr.ly;
    if (Math.hypot(e.clientX - ptr.x0, e.clientY - ptr.y0) > 8) ptr.moved = true;
    ptr.lx = e.clientX; ptr.ly = e.clientY;
    if (ptr.moved) queueWheel(ptr.p, -dx / ptr.p.sc, -dy / ptr.p.sc);
  });
  img.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") { sendInput({ t: "up", ...pos(e), button: ["left", "middle", "right"][e.button] || "left", count: e.detail || 1, ...mods(e) }); ptr = null; return; }
    if (ptr && !ptr.moved) sendInput({ t: "click", x: ptr.p.x, y: ptr.p.y });
    ptr = null;
  });
  img.addEventListener("pointercancel", () => { ptr = null; });
  img.addEventListener("contextmenu", (e) => e.preventDefault());
  img.addEventListener("wheel", (e) => { e.preventDefault(); const p = pos(e); queueWheel(p, e.deltaX, e.deltaY); }, { passive: false });

  // keyboard on a computer: click the page, then type
  scr.addEventListener("keydown", (e) => {
    if (e.target === ta) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;       // the paste event brings the text
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeText(e.key); return; }
    if (KEYS.has(e.key) || ((e.ctrlKey || e.metaKey) && /^[a-z0-9]$/i.test(e.key))) { e.preventDefault(); sendInput({ t: "key", key: e.key, ...mods(e) }); }
  });
  scr.addEventListener("paste", (e) => { const t = e.clipboardData && e.clipboardData.getData("text"); if (t) { e.preventDefault(); typeText(t); } });

  // keyboard on a phone: an invisible text field takes the typing (it keeps one invisible character, so deleting is noticed too)
  const SENT = "​";
  const reset = () => { ta.value = SENT; try { ta.setSelectionRange(1, 1); } catch {} };
  const flushTa = () => {
    const v = ta.value;
    if (!v.startsWith(SENT)) sendInput({ t: "key", key: "Backspace" });
    else { const t = v.slice(1); const parts = t.split("\n"); parts.forEach((x, i) => { if (x) typeText(x); if (i < parts.length - 1) sendInput({ t: "key", key: "Enter" }); }); }
    reset();
  };
  ta.addEventListener("input", (e) => { if (!e.isComposing) flushTa(); });
  ta.addEventListener("compositionend", flushTa);
  ta.addEventListener("keydown", (e) => { if (["Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) { e.preventDefault(); sendInput({ t: "key", key: e.key }); } });
  $("#bvKbd").onclick = () => { reset(); ta.focus({ preventScroll: true }); };

  // the page follows the size of this window
  new ResizeObserver(() => {
    if (!BV.open || !BV.vp) return;
    clearTimeout(BV.resizeT);
    BV.resizeT = setTimeout(() => { const v = viewSize(); if (v.w !== BV.vp.w || v.h !== BV.vp.h || v.mobile !== BV.vp.mobile) { BV.vp = v; call("/browser/viewport", v).catch(() => {}); } }, 400);
  }).observe(scr);
}
window.browserOpen = () => { wire(); if (!BV.open) open(); };
window.browserClose = () => { if (BV.open) close(); };

// ---------- the side panel: the browser and the Agent's work next to the chat (a sheet from the bottom on phones) ----------
const home = { parent: null, next: null };
const inSide = () => $("#browserPage").parentNode === $("#spBrowser");
function putBack() { const bp = $("#browserPage"); if (inSide() && home.parent) home.parent.insertBefore(bp, home.next); }
function sideTab(tab) {
  const sp = $("#sidePanel"); sp.dataset.tab = tab;
  $$("#spTabs button").forEach((b) => b.classList.toggle("on", b.dataset.sp === tab));
  $("#spBrowser").hidden = tab !== "browser"; $("#spAgent").hidden = tab !== "agent"; $("#spCode").hidden = tab !== "code";
  if (tab === "browser") {
    const bp = $("#browserPage");
    if (!inSide()) { home.parent = bp.parentNode; home.next = bp.nextSibling; $("#spBrowser").appendChild(bp); }
    window.browserOpen();
  } else if (!document.body.classList.contains("browser-view")) window.browserClose();   // not visible: no pictures needed
}
window.sideOpen = (tab) => {
  if (tab === "browser" && document.body.classList.contains("browser-view")) return;      // it is already open full size
  const sp = $("#sidePanel"); $("#deckSide").hidden = true;
  sp.hidden = false; $("#sideBtn").classList.add("on");
  sideTab(tab || sp.dataset.tab || "browser");
};
window.sideClose = () => {
  const sp = $("#sidePanel"); if (sp.hidden) return;
  sp.hidden = true; $("#sideBtn").classList.remove("on");
  putBack();
  if (!document.body.classList.contains("browser-view")) window.browserClose();
};
window.sideAgentRender = (block) => {
  const box = $("#spAgent"); if (!box || !window.agentCard) return;
  box.innerHTML = ""; box.appendChild(window.agentCard(block));
};
$$("#spTabs button").forEach((b) => (b.onclick = () => sideTab(b.dataset.sp)));

// ---------- the Code tab: every code block from a chat can be opened here, edited, run, saved ----------
// HTML, CSS and JavaScript run in a sandboxed frame; Python runs in this browser with Pyodide (downloaded once, about 10 MB).
// An answer made of several files (a game: index.html, style.css, game.js ...) opens as one project with a tab per file,
// and Run puts them together (window.bundleFiles in agent.js), Python files can import each other.
const LANG = (l) => { l = String(l || "").toLowerCase().trim(); return /^(html?|xml|svg|vue)$/.test(l) ? "html" : /^css|scss$/.test(l) ? "css" : /^(js|javascript|mjs|cjs|node)$/.test(l) ? "js" : /^(py|python|python3)$/.test(l) ? "python" : "text"; };
const EXT = { html: "html", css: "css", js: "js", python: "py", text: "txt" };
const OTHER_EXT = { rust: "rs", typescript: "ts", ts: "ts", "c++": "cpp", cpp: "cpp", c: "c", csharp: "cs", "c#": "cs", java: "java", go: "go", golang: "go", bash: "sh", sh: "sh", shell: "sh", powershell: "ps1", ruby: "rb", kotlin: "kt", swift: "swift", php: "php", sql: "sql", json: "json", yaml: "yml", markdown: "md", md: "md" };
const extOf = (n) => (/\.(\w+)$/.exec(n || "") || [])[1] || "";
const safePath = (n) => String(n || "").replace(/\\/g, "/").split("/").map((s) => s.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").replace(/[. ]+$/, "")).filter(Boolean).join("/");
function cpMake(lang, code, name) {
  const fromName = LANG(extOf(name)), l = fromName !== "text" ? fromName : LANG(lang), orig = String(lang || "");
  name = name || "snippet-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + "." + (l === "text" ? (OTHER_EXT[orig.toLowerCase()] || (/^\w{1,5}$/.test(orig) ? orig.toLowerCase() : "txt")) : EXT[l]);
  return { name, lang: l, orig, code: String(code || "") };
}
let cpFiles = [cpMake("html", "", "")], cpAt = 0, cpFolder = "";
const cpCur = () => cpFiles[cpAt];
// what Run starts: the open file if it runs, or else the project's page, or else its Python program
function cpEntry() {
  const f = cpCur();
  if (f.lang !== "text") return f;
  return cpFiles.find((x) => x.lang === "html") || cpFiles.find((x) => x.name.split("/").pop() === "main.py") || cpFiles.find((x) => x.lang === "python") || f;
}
// lang, code: one code block. o.files: a whole project ({ files: [{ name, lang, code }], at }). o.name: the block's file name, if known
window.codeSide = (lang, code, open, o) => {
  o = o || {};
  if (o.files && o.files.length) { cpFiles = o.files.map((f) => cpMake(f.lang, f.code, f.name)); cpAt = Math.max(0, Math.min(cpFiles.length - 1, o.at | 0)); cpFolder = ""; }
  else {
    const f = cpMake(lang, code, o.name), i = o.name ? cpFiles.findIndex((x) => x.name === o.name) : -1;
    if (i >= 0) { cpFiles[i] = f; cpAt = i; }                                          // a newer version of a file of the project
    else if (o.name && cpFiles.length > 1) { cpFiles.push(f); cpAt = cpFiles.length - 1; }  // one more file for the project
    else { cpFiles = [f]; cpAt = 0; cpFolder = ""; }
  }
  cpShow();
  if (open) window.sideOpen("code");
};
function cpShow(keepOut) {
  const f = cpCur();
  $("#cpLang").value = f.lang; $("#cpName").value = f.name; $("#cpSrc").value = f.code;
  if (!keepOut) { $("#cpLog").textContent = ""; $("#cpFrame").hidden = true; }
  cpTabs(); cpNote();
}
function cpTabs() {
  const box = $("#cpFiles"); box.innerHTML = "";
  cpFiles.forEach((f, i) => {
    const b = document.createElement("button"); b.type = "button"; b.dataset.i = i; b.className = i === cpAt ? "on" : ""; b.title = f.name;
    b.innerHTML = '<span class="nm"></span><span class="x" role="button" title="Close this file" aria-label="Close this file">×</span>';
    b.querySelector(".nm").textContent = f.name.split("/").pop();
    box.appendChild(b);
  });
  box.insertAdjacentHTML("beforeend", '<button type="button" class="add" title="Add a file to this project" aria-label="Add a file">+</button>');
}
$("#cpFiles").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.classList.contains("add")) {
    let n = 1; while (cpFiles.some((f) => f.name === "new-" + n + ".js")) n++;
    cpFiles.push(cpMake("js", "", "new-" + n + ".js")); cpAt = cpFiles.length - 1; cpShow(true);
    $("#cpName").focus(); $("#cpName").select(); return;
  }
  const i = +b.dataset.i;
  if (e.target.closest(".x")) {
    cpFiles.splice(i, 1);
    if (!cpFiles.length) { cpFiles = [cpMake("html", "", "")]; cpFolder = ""; }
    cpAt = Math.min(i <= cpAt ? Math.max(0, cpAt - 1) : cpAt, cpFiles.length - 1); cpShow(true); return;
  }
  cpAt = i; cpShow(true);
};
function cpNote() {
  const f = cpCur(), run = cpEntry(), many = cpFiles.length > 1, page = run.lang === "html" ? run : cpFiles.find((x) => x.lang === "html");
  $("#cpRun").disabled = run.lang === "text";
  $("#cpNote").textContent = run.lang === "text" ? (f.orig ? `${f.orig} can't run inside the browser. Save it to your PC, or ask the Code tool to make a project of it.` : "Pick a language to run it.")
    : run.lang === "python" ? `Python runs here in your browser (not on the PC)${many ? `, starting with ${run.name}; the other files are next to it` : ""}. The first run downloads Python, about 10 MB.`
    : many ? `${cpFiles.length} files: Run starts ${page ? page.name : "a page"} with all of them together.` : "";
}
let pyodide = null;
async function loadPy() {
  if (pyodide) return pyodide;
  if (!window.loadPyodide) await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js"; sc.onload = res; sc.onerror = () => rej(new Error("couldn't download Python")); document.head.appendChild(sc); });
  pyodide = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" });
  return pyodide;
}
async function cpRun() {
  const f = cpEntry(), log = $("#cpLog");
  log.textContent = "";
  if (f.lang === "python") {
    $("#cpFrame").hidden = true; log.textContent = pyodide ? "Running…" : "Downloading Python (only the first time)…";
    try {
      const py = await loadPy(), out = [];
      py.setStdout({ batched: (x) => { out.push(x); log.textContent = out.join("\n"); } });
      py.setStderr({ batched: (x) => { out.push("error: " + x); log.textContent = out.join("\n"); } });
      log.textContent = "Running…";
      // every file of the project lies next to the program, so `import helpers` and open("level.txt") find them; edited modules load fresh
      const home = "/home/pyodide", mods = [];
      for (const x of cpFiles) {
        const p = safePath(x.name); if (!p) continue;
        if (p.includes("/")) py.FS.mkdirTree(home + "/" + p.slice(0, p.lastIndexOf("/")));
        py.FS.writeFile(home + "/" + p, x.code);
        if (x.lang === "python") mods.push(p.replace(/\.py$/, "").replace(/\//g, "."));
      }
      py.runPython(`import sys, os\nos.chdir(${JSON.stringify(home)})\nif ${JSON.stringify(home)} not in sys.path: sys.path.insert(0, ${JSON.stringify(home)})\nfor n in ${JSON.stringify(mods)}: sys.modules.pop(n, None)`);
      try { await py.loadPackagesFromImports(cpFiles.filter((x) => x.lang === "python").map((x) => x.code).join("\n")); } catch {}
      const r = await py.runPythonAsync(f.code);
      if (r !== undefined && r !== null) out.push(String(r));
      log.textContent = out.join("\n") || "(finished, nothing was printed)";
    } catch (e) { log.textContent += (log.textContent ? "\n" : "") + String(e.message || e).split("\n").slice(-6).join("\n"); }
    return log.textContent;
  }
  const frame = $("#cpFrame"); frame.hidden = false;
  const code = f.code;
  const out = cpFiles.length > 1
    ? await window.runInFrame(frame, "html", window.bundleFiles(cpFiles, cpFiles.indexOf(f)), (x) => { log.textContent = x; })
    : await window.runInFrame(frame, f.lang === "js" ? "js" : "html", f.lang === "css" ? `<style>${code}</style><h1>Heading</h1><p>A paragraph with a <a href="#">link</a> and <b>bold text</b>.</p><button>Button</button> <input placeholder="Input">` : code, (x) => { log.textContent = x; });
  if (out === "(nothing was printed)") log.textContent = "";
  return out;
}
// the Agent runs a project: all its files open here in the Code tab and run, so the user sees it (and plays it); it gets what was printed
window.codeRunProject = async (files, at) => { window.codeSide(null, null, true, { files, at }); return cpRun(); };
// a folder name for the project: the page's <title>, or the date
function cpFolderName() {
  if (cpFolder) return cpFolder;
  const html = cpFiles.find((x) => x.lang === "html"), t = html && (/<title[^>]*>([^<]{1,60})<\/title>/i.exec(html.code) || [])[1];
  const slug = String(t || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").slice(0, 40);
  return (cpFolder = slug || "project-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"));
}
// a .zip of the project (stored, not compressed: these are a few small text files)
function zipBlob(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const crcT = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.code), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30 + name.length)), c = new DataView(new ArrayBuffer(46 + name.length));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    new Uint8Array(h.buffer).set(name, 30);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    new Uint8Array(c.buffer).set(name, 46);
    parts.push(h, data); central.push(c); off += h.byteLength + data.length;
  }
  const size = central.reduce((s, c) => s + c.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
$("#cpRun").onclick = cpRun;
$("#cpBig").onclick = () => { const on = $("#spCode").classList.toggle("cp-big"); $("#cpBig").textContent = on ? "Show code" : "Bigger"; $("#cpBig").setAttribute("aria-pressed", String(on)); if (on && $("#cpFrame").hidden) cpRun(); };
$("#cpLang").onchange = () => { const f = cpCur(); f.lang = $("#cpLang").value; f.orig = ""; cpNote(); };
$("#cpName").oninput = () => {
  const f = cpCur(); f.name = $("#cpName").value;
  const l = LANG(extOf(f.name)); if (l !== "text" && l !== f.lang) { f.lang = l; f.orig = ""; $("#cpLang").value = l; }
  cpTabs(); cpNote();
};
$("#cpSrc").oninput = () => (cpCur().code = $("#cpSrc").value);
$("#cpCopy").onclick = () => copy($("#cpSrc").value);
$("#cpDl").onclick = () => {
  if (cpFiles.length === 1) return download(safePath(cpCur().name).replace(/\//g, "_") || "snippet.txt", new Blob([cpCur().code], { type: "text/plain" }));
  const dir = cpFolderName();
  download(dir + ".zip", zipBlob(cpFiles.map((f) => ({ name: dir + "/" + (safePath(f.name) || "file.txt"), code: f.code }))));
};
$("#cpSave").onclick = async () => {
  if (cpFiles.length === 1) {
    const name = safePath(cpCur().name).replace(/\//g, "_") || "snippet.txt";
    try { await pcCall("/agent/write", { spec: "code:snippets/" + name, content: cpCur().code, mode: "overwrite" }); toast("Saved on your PC: PC files → Code projects → snippets → " + name); }
    catch (e) { toast("Couldn't save: " + e.message); }
    return;
  }
  const dir = cpFolderName(), bad = [];
  for (const f of cpFiles) {
    try { await pcCall("/agent/write", { spec: "code:" + dir + "/" + (safePath(f.name) || "file.txt"), content: f.code, mode: "overwrite" }); }
    catch (e) { bad.push(f.name + ": " + e.message); }
  }
  toast(bad.length === cpFiles.length ? "Couldn't save: " + bad[0] : `Saved ${cpFiles.length - bad.length} file${cpFiles.length - bad.length === 1 ? "" : "s"} on your PC: PC files → Code projects → ${dir}` + (bad.length ? ` (not saved: ${bad.join("; ")})` : ""));
};
$("#cpSrc").addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); const ta = e.target, a = ta.selectionStart; ta.setRangeText("  ", a, ta.selectionEnd, "end"); cpCur().code = ta.value; }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cpRun(); }
});
cpTabs();
// full screen: the browser page covers everything; where the browser allows it, it also really goes full screen (no tabs, no bars)
function bvFullSet(on) {
  const page = $("#browserPage"), d = document;
  // while full screen the page sits directly in <body>: a parent with glass (backdrop-filter) would hold a fixed element inside itself
  if (on && page.parentNode !== d.body) { bvFullSet.home = [page.parentNode, page.nextSibling]; d.body.appendChild(page); }
  if (!on && bvFullSet.home) { const [p, n] = bvFullSet.home; bvFullSet.home = null; if (p && p.isConnected) p.insertBefore(page, n && n.parentNode === p ? n : null); }
  page.classList.toggle("bv-fs", on); $("#bvFull").classList.toggle("on", on); $("#bvFull").setAttribute("aria-pressed", String(on));
  $("#bvFull").title = on ? "Leave full screen (Esc)" : "Full screen";
  if (on) { const req = page.requestFullscreen || page.webkitRequestFullscreen; if (req) try { const p = req.call(page); if (p && p.catch) p.catch(() => {}); } catch {} }
  else if ((d.fullscreenElement || d.webkitFullscreenElement) === page) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
}
// in the side panel the glass around it would hold it in: the Browser page opens first
$("#bvFull").onclick = () => { const on = !$("#browserPage").classList.contains("bv-fs"); if (on && inSide()) setView("browser"); bvFullSet(on); };
const bvFsLeft = () => { const d = document; if (!(d.fullscreenElement || d.webkitFullscreenElement) && $("#browserPage").classList.contains("bv-fs") && bvFullSet.real) bvFullSet(false); bvFullSet.real = !!(d.fullscreenElement || d.webkitFullscreenElement); };
document.addEventListener("fullscreenchange", bvFsLeft); document.addEventListener("webkitfullscreenchange", bvFsLeft);
addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#browserPage").classList.contains("bv-fs") && document.activeElement !== $("#bvScreen")) bvFullSet(false); });
$("#spClose").onclick = () => window.sideClose();
$("#spFull").onclick = () => { const tab = $("#sidePanel").dataset.tab; setView(tab === "agent" ? "agent" : "browser"); };
$("#sideBtn").onclick = () => ($("#sidePanel").hidden ? window.sideOpen() : window.sideClose());
})();
