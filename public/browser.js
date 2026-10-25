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
const LANG = (l) => { l = String(l || "").toLowerCase().trim(); return /^(html?|xml|svg|vue)$/.test(l) ? "html" : /^css|scss$/.test(l) ? "css" : /^(js|javascript|mjs|cjs|node)$/.test(l) ? "js" : /^(py|python|python3)$/.test(l) ? "python" : "text"; };
const EXT = { html: "html", css: "css", js: "js", python: "py", text: "txt" };
let cpOrig = "";
window.codeSide = (lang, code, open) => {
  const l = LANG(lang); cpOrig = String(lang || "");
  $("#cpLang").value = l; $("#cpSrc").value = code; $("#cpLog").textContent = ""; $("#cpFrame").hidden = true;
  if (!$("#cpName").dataset.touched) $("#cpName").value = "snippet-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + "." + (l === "text" ? ({ rust: "rs", typescript: "ts", ts: "ts", "c++": "cpp", cpp: "cpp", c: "c", csharp: "cs", "c#": "cs", java: "java", go: "go", golang: "go", bash: "sh", sh: "sh", shell: "sh", powershell: "ps1", ruby: "rb", kotlin: "kt", swift: "swift", php: "php", sql: "sql", json: "json", yaml: "yml", markdown: "md", md: "md" }[cpOrig.toLowerCase()] || (/^\w{1,5}$/.test(cpOrig) ? cpOrig.toLowerCase() : "txt")) : EXT[l]);
  cpNote();
  if (open) window.sideOpen("code");
};
function cpNote() {
  const l = $("#cpLang").value;
  $("#cpRun").disabled = l === "text";
  $("#cpNote").textContent = l === "text" ? (cpOrig ? `${cpOrig} can't run inside the browser. Save it to your PC, or ask the Code tool to make a project of it.` : "Pick a language to run it.") : l === "python" ? "Python runs here in your browser (not on the PC). The first run downloads Python, about 10 MB." : "";
}
let pyodide = null;
async function loadPy() {
  if (pyodide) return pyodide;
  if (!window.loadPyodide) await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js"; sc.onload = res; sc.onerror = () => rej(new Error("couldn't download Python")); document.head.appendChild(sc); });
  pyodide = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" });
  return pyodide;
}
async function cpRun() {
  const l = $("#cpLang").value, code = $("#cpSrc").value, log = $("#cpLog");
  log.textContent = "";
  if (l === "python") {
    $("#cpFrame").hidden = true; log.textContent = pyodide ? "Running…" : "Downloading Python (only the first time)…";
    try {
      const py = await loadPy(), out = [];
      py.setStdout({ batched: (x) => { out.push(x); log.textContent = out.join("\n"); } });
      py.setStderr({ batched: (x) => { out.push("error: " + x); log.textContent = out.join("\n"); } });
      log.textContent = "Running…";
      try { await py.loadPackagesFromImports(code); } catch {}
      const r = await py.runPythonAsync(code);
      if (r !== undefined && r !== null) out.push(String(r));
      log.textContent = out.join("\n") || "(finished, nothing was printed)";
    } catch (e) { log.textContent += (log.textContent ? "\n" : "") + String(e.message || e).split("\n").slice(-6).join("\n"); }
    return;
  }
  const frame = $("#cpFrame"); frame.hidden = false;
  const html = l === "css" ? `<style>${code}</style><h1>Heading</h1><p>A paragraph with a <a href="#">link</a> and <b>bold text</b>.</p><button>Button</button> <input placeholder="Input">` : code;
  const out = await window.runInFrame(frame, l === "js" ? "js" : "html", html, (x) => { log.textContent = x; });
  if (out === "(nothing was printed)") log.textContent = "";
}
$("#cpRun").onclick = cpRun;
$("#cpLang").onchange = () => { cpOrig = ""; cpNote(); };
$("#cpName").oninput = () => ($("#cpName").dataset.touched = "1");
$("#cpCopy").onclick = () => copy($("#cpSrc").value);
$("#cpDl").onclick = () => download(($("#cpName").value || "snippet.txt").replace(/[\\/:*?"<>|]/g, "_"), new Blob([$("#cpSrc").value], { type: "text/plain" }));
$("#cpSave").onclick = async () => {
  const name = ($("#cpName").value || "snippet.txt").replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "");
  try { const j = await pcCall("/agent/write", { spec: "code:snippets/" + name, content: $("#cpSrc").value, mode: "overwrite" }); toast("Saved on your PC: PC files → Code projects → snippets → " + name); }
  catch (e) { toast("Couldn't save: " + e.message); }
};
$("#cpSrc").addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); const ta = e.target, a = ta.selectionStart; ta.setRangeText("  ", a, ta.selectionEnd, "end"); }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cpRun(); }
});
$("#spClose").onclick = () => window.sideClose();
$("#spFull").onclick = () => { const tab = $("#sidePanel").dataset.tab; setView(tab === "agent" ? "agent" : "browser"); };
$("#sideBtn").onclick = () => ($("#sidePanel").hidden ? window.sideOpen() : window.sideClose());
})();
