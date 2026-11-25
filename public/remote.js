"use strict";
// Remote desktop: the PC's screen, live, on this device, with its mouse and keyboard. The pictures come from the desktop helper
// on the PC (host/remotedesk.js → remotedesk.ps1) through /pc/deskstream; clicks, drags, scrolling and keys go to /pc/desk.
// Where you click is sent as a place in the picture (0 to 1), so this page never needs the PC's resolution.
//   Mouse: click, double-click, right-click, drag, wheel. Touch: tap = click, two-finger tap or long press = right-click,
//   drag with one finger = drag, two fingers = scroll. Keyboard: everything you press while the screen has the focus; on a phone
//   the keyboard button opens the on-screen keyboard. Special keys and shortcuts are in the bar.
// Uses the main page's helpers: $, esc, toast, pcCall, pcStream, connected, remotePC.
(() => {
const R = { open: false, ctrl: null, screen: null, screens: [], quality: "auto", frame: null, queue: Promise.resolve(), moveT: 0, lastMove: null, down: null, keysDown: new Set(), frames: 0, fpsT: 0 };
const page = () => $("#remotePage");
const QUAL = { auto: null, sharp: { max: 1920, q: 70, fps: 6 }, normal: { max: 1280, q: 55, fps: 8 }, fast: { max: 960, q: 40, fps: 12 } };
const settings = () => QUAL[R.quality] || (remotePC() ? QUAL.normal : QUAL.sharp);
// inputs go out one after the other, in order; a slow one never lets the next overtake it
const send = (o) => { R.queue = R.queue.then(() => pcCall("/pc/desk", { screen: R.screen, ...o }).catch((e) => { if (/Unknown|404/.test(e.message)) toast("Update Albatross on the PC for remote desktop"); })); return R.queue; };
const I = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;

function shell() {
  page().innerHTML = `
    <div class="rd-bar">
      <button class="icon-btn" type="button" data-rd="back" title="Back" aria-label="Back">${I('<path d="M15 18l-6-6 6-6"/>')}</button>
      <b class="rd-title">Remote desktop</b>
      <span class="rd-stat" id="rdStat">Connecting…</span>
      <span class="rd-sp"></span>
      <select id="rdScreen" class="rd-sel" title="Which screen" hidden></select>
      <select id="rdQual" class="rd-sel" title="Picture quality"><option value="auto">Auto</option><option value="sharp">Sharp</option><option value="normal">Normal</option><option value="fast">Fast</option></select>
      <button class="icon-btn" type="button" data-rd="kbd" title="Keyboard (type on the PC)" aria-label="Keyboard">${I('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>')}</button>
      <button class="icon-btn" type="button" data-rd="full" title="Full screen" aria-label="Full screen">${I('<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>')}</button>
    </div>
    <div class="rd-keys" id="rdKeys">
      ${[["Esc", "esc"], ["Tab", "tab"], ["Win", "win"], ["Enter", "enter"], ["⌫", "backspace"], ["Del", "delete"], ["Alt+Tab", "alt+tab"], ["Ctrl+C", "ctrl+c"], ["Ctrl+V", "ctrl+v"], ["Ctrl+Z", "ctrl+z"], ["Ctrl+A", "ctrl+a"], ["Win+D", "win+d"], ["Alt+F4", "alt+f4"], ["Task Mgr", "ctrl+shift+esc"], ["←", "left"], ["↑", "up"], ["↓", "down"], ["→", "right"]]
        .map(([l, c]) => `<button type="button" data-combo="${c}">${esc(l)}</button>`).join("")}
    </div>
    <div class="rd-stage" id="rdStage" tabindex="0" aria-label="The PC's screen: click here, then use mouse and keyboard">
      <img id="rdImg" alt="" draggable="false">
      <div class="rd-msg" id="rdMsg">Connecting to the PC's screen…</div>
      <textarea id="rdType" class="rd-type" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Type on the PC"></textarea>
    </div>`;
  page().querySelector('[data-rd="back"]').onclick = () => setView("home");
  page().querySelector('[data-rd="full"]').onclick = () => { const st = $("#rdStage"); (document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen && st.requestFullscreen()).catch?.(() => {}); };
  page().querySelector('[data-rd="kbd"]').onclick = () => { const t = $("#rdType"); t.value = ""; t.focus(); };
  page().querySelectorAll("[data-combo]").forEach((b) => (b.onclick = () => { send({ t: "combo", combo: b.dataset.combo }); $("#rdStage").focus({ preventScroll: true }); }));
  $("#rdQual").value = R.quality;
  $("#rdQual").onchange = (e) => { R.quality = e.target.value; try { localStorage.setItem("burrow.rdQuality", JSON.stringify(R.quality)); } catch {} watch(); };
  $("#rdScreen").onchange = (e) => { R.screen = Number(e.target.value); watch(); };
  wireInput();
}

// ---------- the pictures ----------
async function watch() {
  if (R.ctrl) R.ctrl.abort();
  const ctrl = R.ctrl = new AbortController(), dec = new TextDecoder();
  let fails = 0;
  while (R.open && !ctrl.signal.aborted) {
    try {
      const res = await pcStream("/pc/deskstream", { screen: R.screen, ...settings() }, ctrl.signal);
      if (!res.ok) throw new Error(res.status === 404 ? "This PC's Albatross is too old for remote desktop: update it." : "HTTP " + res.status);
      const rd = res.body.getReader(); let buf = ""; fails = 0;
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 1);
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.screens) screensList(o.screens, o.screen);
          if (o.img) frame(o);
          if (o.error) msg(o.error);
        }
      }
    } catch (e) { if (ctrl.signal.aborted) return; fails++; msg(fails > 2 ? "Can't reach the PC's screen: " + e.message : "Connecting to the PC's screen…"); }
    if (!R.open) return;
    await new Promise((r) => setTimeout(r, Math.min(4000, 500 * (fails + 1))));
  }
}
function msg(t) { const m = $("#rdMsg"); if (!m) return; m.hidden = !t; m.textContent = t || ""; if (t) $("#rdStat").textContent = "Not connected"; }
function frame(o) {
  R.frame = { w: o.w, h: o.h };
  $("#rdImg").src = "data:image/jpeg;base64," + o.img;
  msg("");
  R.frames++;
  const now = Date.now();
  if (now - R.fpsT > 2000) { $("#rdStat").textContent = (remotePC() ? "Online" : "This PC") + " · " + Math.round(R.frames * 1000 / (now - R.fpsT || 1)) + " fps"; R.frames = 0; R.fpsT = now; }
}
function screensList(list, cur) {
  R.screens = list || []; if (R.screen == null) R.screen = cur;
  const sel = $("#rdScreen");
  sel.hidden = R.screens.length < 2;
  sel.innerHTML = R.screens.map((s) => `<option value="${s.i}">Screen ${s.i + 1}${s.primary ? " (main)" : ""} · ${s.w}×${s.h}</option>`).join("");
  sel.value = String(R.screen);
}

// ---------- mouse, touch and keyboard ----------
// where in the picture (0..1) a pointer is; null outside the picture (the black bars of a different shape)
function at(e) {
  const img = $("#rdImg"), r = img.getBoundingClientRect();
  if (!R.frame || !r.width) return null;
  // the picture keeps its shape inside the stage (object-fit: contain): work out where it really is
  const k = Math.min(r.width / R.frame.w, r.height / R.frame.h), w = R.frame.w * k, h = R.frame.h * k, x0 = r.left + (r.width - w) / 2, y0 = r.top + (r.height - h) / 2;
  const x = (e.clientX - x0) / w, y = (e.clientY - y0) / h;
  return x < -0.01 || y < -0.01 || x > 1.01 || y > 1.01 ? null : { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
function moveSoon(p) {
  R.lastMove = p;
  if (R.moveT) return;
  R.moveT = setTimeout(() => { R.moveT = 0; if (R.lastMove) send({ t: "move", ...R.lastMove }); }, 50);    // at most 20 moves a second
}
function wireInput() {
  const st = $("#rdStage");
  const BTN = ["left", "middle", "right"];
  let touch = null;
  st.addEventListener("contextmenu", (e) => e.preventDefault());
  st.addEventListener("pointerdown", (e) => {
    const p = at(e); if (!p) return;
    st.focus({ preventScroll: true });
    if (e.pointerType === "touch") {
      // touch: decided when the finger lifts (tap, long press) or moves (drag)
      touch = { id: e.pointerId, start: p, t: Date.now(), moved: false, dragging: false, long: setTimeout(() => { if (touch && !touch.moved) { touch.longDone = true; send({ t: "click", button: "right", ...p }); if (navigator.vibrate) navigator.vibrate(15); } }, 550) };
      return;
    }
    e.preventDefault(); st.setPointerCapture(e.pointerId);
    R.down = BTN[e.button] || "left";
    send({ t: "down", button: R.down, ...p });
  });
  st.addEventListener("pointermove", (e) => {
    const p = at(e); if (!p) return;
    if (e.pointerType === "touch" && touch && touch.id === e.pointerId) {
      if (!touch.moved && Math.hypot(p.x - touch.start.x, p.y - touch.start.y) > 0.01) { touch.moved = true; clearTimeout(touch.long); if (!touch.longDone) { touch.dragging = true; send({ t: "down", button: "left", ...touch.start }); } }
      if (touch.dragging) moveSoon(p);
      return;
    }
    if (e.pointerType !== "touch") moveSoon(p);
  });
  const up = (e) => {
    const p = at(e) || R.lastMove || { x: 0.5, y: 0.5 };
    if (e.pointerType === "touch" && touch && touch.id === e.pointerId) {
      clearTimeout(touch.long);
      if (touch.dragging) { clearTimeout(R.moveT); R.moveT = 0; send({ t: "up", button: "left", ...p }); }
      else if (!touch.longDone) send({ t: "click", button: "left", ...touch.start });
      touch = null; return;
    }
    if (!R.down) return;
    clearTimeout(R.moveT); R.moveT = 0;
    send({ t: "up", button: R.down, ...p }); R.down = null;
  };
  st.addEventListener("pointerup", up);
  st.addEventListener("pointercancel", up);
  // two-finger tap: right-click; two-finger drag: scroll
  let two = null;
  st.addEventListener("touchstart", (e) => { if (e.touches.length === 2) { if (touch) { clearTimeout(touch.long); touch = null; } const y = (e.touches[0].clientY + e.touches[1].clientY) / 2; two = { y, y0: y, t: Date.now(), p: at(e.touches[0]) }; } }, { passive: true });
  st.addEventListener("touchmove", (e) => {
    if (!two || e.touches.length !== 2) return;
    e.preventDefault();
    const y = (e.touches[0].clientY + e.touches[1].clientY) / 2, d = y - two.y;
    if (Math.abs(d) > 12) { two.y = y; send({ t: "wheel", dy: Math.round(d * 4), ...(two.p || { x: 0.5, y: 0.5 }) }); }
  }, { passive: false });
  st.addEventListener("touchend", (e) => { if (two && e.touches.length === 0) { if (Date.now() - two.t < 300 && Math.abs(two.y - two.y0) < 10 && two.p) send({ t: "click", button: "right", ...two.p }); two = null; } }, { passive: true });
  st.addEventListener("wheel", (e) => { e.preventDefault(); const p = at(e); if (!p) return; const dy = -Math.round(e.deltaY * (e.deltaMode === 1 ? 40 : 1.2)); const dx = Math.round(e.deltaX * (e.deltaMode === 1 ? 40 : 1.2)); if (dy) send({ t: "wheel", dy, ...p }); if (dx) send({ t: "wheel", dy: dx, horizontal: true, ...p }); }, { passive: false });
  // a physical keyboard: every key goes down and up on the PC, so shortcuts and holding keys work as they would there
  st.addEventListener("keydown", (e) => {
    if (e.target && e.target.id === "rdType") return;
    if (e.ctrlKey && e.altKey && e.code === "KeyX") return;          // never swallow the panel's stop shortcut
    e.preventDefault();
    if (!R.keysDown.has(e.code)) R.keysDown.add(e.code);
    send({ t: "key", code: e.code, down: true });
  });
  st.addEventListener("keyup", (e) => { if (e.target && e.target.id === "rdType") return; e.preventDefault(); R.keysDown.delete(e.code); send({ t: "key", code: e.code, down: false }); });
  // leaving the page with a key still held would leave it held on the PC: let go of all of them
  st.addEventListener("blur", releaseKeys);
  // the phone's on-screen keyboard: the text that appears is typed on the PC (Enter and Backspace as keys)
  const ta = $("#rdType");
  ta.addEventListener("input", () => { const v = ta.value; ta.value = ""; if (v) send({ t: "text", text: v }); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send({ t: "combo", combo: "enter" }); }
    else if (e.key === "Backspace" && !ta.value) { e.preventDefault(); send({ t: "combo", combo: "backspace" }); }
    else if (e.key === "Tab") { e.preventDefault(); send({ t: "combo", combo: "tab" }); }
    else if (e.key === "Escape") { e.preventDefault(); ta.blur(); }
  });
}
function releaseKeys() { for (const code of R.keysDown) send({ t: "key", code, down: false }); R.keysDown.clear(); if (R.down) { send({ t: "up", button: R.down, ...(R.lastMove || { x: 0.5, y: 0.5 }) }); R.down = null; } }

window.remoteOpen = function () {
  if (R.open) return;
  R.open = true;
  try { R.quality = JSON.parse(localStorage.getItem("burrow.rdQuality")) || "auto"; } catch { R.quality = "auto"; }
  shell();
  if (!connected) { msg("Connect to your PC first (Home → Connect)."); R.open = false; return; }
  R.fpsT = Date.now(); R.frames = 0;
  watch();
  setTimeout(() => $("#rdStage") && $("#rdStage").focus({ preventScroll: true }), 80);
};
window.remoteClose = function () {
  if (!R.open) return;
  releaseKeys();
  R.open = false;
  if (R.ctrl) R.ctrl.abort(); R.ctrl = null;
  if (document.fullscreenElement && document.fullscreenElement.id === "rdStage") document.exitFullscreen().catch(() => {});
};
})();
