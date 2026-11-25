// Remote desktop: see the PC's screen live on another device and use its mouse and keyboard, end-to-end encrypted like
// everything else with your code. Only for the PC's owner (guests never reach /pc/). The pictures are taken and the inputs
// pressed by the desktop helper in the signed-in session (desktop.js → remotedesk.ps1); this passes them along.
//   POST /pc/deskstream { screen, fps, max, q }   newline-delimited JSON: { img, w, h, screen, screens } for each new picture
//                                                  (an unchanged screen sends nothing), { ka: 1 } now and then, { error }
//   POST /pc/desk { t, ... }                       t: screens | move | down | up | click | wheel | key | combo | text
//        x, y are where in the picture, from 0 to 1 (so the device never needs to know the PC's resolution)
const pcDesk = require("./pcdesk");

const rd = (cmd, arg) => pcDesk.call("rd", { cmd, arg });
let screens = null, screensAt = 0;
async function getScreens(fresh) {
  if (!screens || fresh || Date.now() - screensAt > 15000) { screens = (await rd("screens")).screens || []; screensAt = Date.now(); }
  return screens;
}
const pick = (list, i) => list.find((s) => s.i === Number(i)) || list.find((s) => s.primary) || list[0];

const VK = { ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B, meta: 0x5B, enter: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B, space: 0x20, backspace: 0x08,
  delete: 0x2E, insert: 0x2D, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, capslock: 0x14, printscreen: 0x2C, menu: 0x5D };
for (let i = 1; i <= 12; i++) VK["f" + i] = 0x6F + i;
// a browser's KeyboardEvent.code (or a name) -> a Windows key code
function vkOf(k) {
  const s = String(k || "");
  let m;
  if ((m = /^Key([A-Z])$/.exec(s))) return m[1].charCodeAt(0);
  if ((m = /^Digit(\d)$/.exec(s))) return 0x30 + Number(m[1]);
  if ((m = /^Numpad(\d)$/.exec(s))) return 0x60 + Number(m[1]);
  const named = { ControlLeft: 0xA2, ControlRight: 0xA3, ShiftLeft: 0xA0, ShiftRight: 0xA1, AltLeft: 0xA4, AltRight: 0xA5, MetaLeft: 0x5B, MetaRight: 0x5C, ArrowUp: 0x26, ArrowDown: 0x28,
    ArrowLeft: 0x25, ArrowRight: 0x27, Minus: 0xBD, Equal: 0xBB, BracketLeft: 0xDB, BracketRight: 0xDD, Backslash: 0xDC, Semicolon: 0xBA, Quote: 0xDE, Comma: 0xBC, Period: 0xBE,
    Slash: 0xBF, Backquote: 0xC0, IntlBackslash: 0xE2, NumpadEnter: 0x0D, NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadMultiply: 0x6A, NumpadDivide: 0x6F, NumpadDecimal: 0x6E, ContextMenu: 0x5D };
  if (named[s]) return named[s];
  const low = s.toLowerCase();
  if (VK[low]) return VK[low];
  if (/^[a-z0-9]$/.test(low)) return low.toUpperCase().charCodeAt(0);
  return 0;
}

async function handle(method, body, note) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  const t = String(j.t || "");
  if (t === "screens") return [200, { screens: await getScreens(true) }];
  const list = await getScreens(), s = pick(list, j.screen);
  if (!s) return [500, { error: "No screen found on the PC." }];
  const fx = Math.max(0, Math.min(1, Number(j.x) || 0)), fy = Math.max(0, Math.min(1, Number(j.y) || 0));
  const x = Math.round(s.x + fx * (s.w - 1)), y = Math.round(s.y + fy * (s.h - 1));
  const button = ["left", "right", "middle"].includes(j.button) ? j.button : "left";
  if (t === "move" || t === "down" || t === "up") { await rd(t, { x, y, button }); return [200, { ok: true }]; }
  if (t === "click") { await rd("click", { x, y, button, count: Math.max(1, Math.min(3, Number(j.count) || 1)) }); return [200, { ok: true }]; }
  if (t === "wheel") { await rd("wheel", { x, y, dy: Math.max(-2400, Math.min(2400, Math.round(Number(j.dy) || 0))), horizontal: !!j.horizontal }); return [200, { ok: true }]; }
  if (t === "key") { const vk = vkOf(j.code || j.key); if (!vk) return [200, { ignored: true }]; await rd("key", { vk, down: !!j.down }); return [200, { ok: true }]; }
  if (t === "combo") {
    const vks = String(j.combo || "").split("+").map((p) => vkOf(p.trim())).filter(Boolean).slice(0, 4);
    if (!vks.length) return [400, { error: "Unknown keys" }];
    await rd("combo", { vks }); return [200, { ok: true }];
  }
  if (t === "text") { await rd("text", { text: String(j.text || "").slice(0, 2000) }); return [200, { ok: true }]; }
  return [400, { error: "Unknown remote desktop action" }];
}

let watchers = 0;
async function stream(j, write, signal, busy, note) {
  const fps = Math.max(1, Math.min(15, Number(j.fps) || 8)), gap = 1000 / fps;
  const max = Math.max(480, Math.min(2560, Math.round(Number(j.max) || 1280))), q = Math.max(25, Math.min(90, Math.round(Number(j.q) || 55)));
  watchers++;
  if (watchers === 1 && note) note("Remote desktop: someone with your code is viewing this PC's screen");
  let last = "", lastKa = Date.now(), fails = 0;
  try {
    const list = await getScreens(true);
    let s = pick(list, j.screen);
    write(JSON.stringify({ screens: list, screen: s ? s.i : 0 }) + "\n");
    while (!(signal && signal.aborted)) {
      const t0 = Date.now();
      if (!(busy && busy())) {
        try {
          const r = await rd("shot", { x: s.x, y: s.y, w: s.w, h: s.h, max, q });
          fails = 0;
          // an unchanged screen sends nothing: a still desktop costs no data
          if (r.img && r.img !== last) { last = r.img; write(JSON.stringify({ img: r.img, w: r.w, h: r.h, screen: s.i }) + "\n"); lastKa = Date.now(); }
        } catch (e) {
          if (++fails >= 3) { write(JSON.stringify({ error: e.message }) + "\n"); await new Promise((r) => setTimeout(r, 2000)); }
          screens = null; const fresh = await getScreens(true).catch(() => list); s = pick(fresh, s ? s.i : 0) || s;
        }
      }
      if (Date.now() - lastKa > 15000) { lastKa = Date.now(); write(JSON.stringify({ ka: 1 }) + "\n"); }
      await new Promise((r) => setTimeout(r, Math.max(15, gap - (Date.now() - t0))));
    }
  } finally { watchers--; if (watchers === 0 && note) note("Remote desktop: nobody is viewing the screen anymore"); }
}
module.exports = { handle, stream, vkOf };
