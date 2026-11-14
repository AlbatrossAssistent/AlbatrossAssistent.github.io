"use strict";
// Input & Output (Settings → Input & Output): which microphone and which speakers Albatross uses on this device, and which ones Jarvis
// uses on the PC. The choice here is per device (kept in this browser); Jarvis's choice is kept by Jarvis (its config).
// Everything that records or plays goes through the choice without knowing about it: getUserMedia gets the microphone added, and every
// new Audio element and AudioContext is pointed at the speakers (setSinkId), so voice, read-aloud, music and songs all follow it.
// Uses the helpers of the main page script: $, esc, toast, jarvisCall (in app.js, loaded before).
(() => {
const KEY = "burrow.sound";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const save = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {} };
let cfg = load();

// ---------- the hooks ----------
const md = navigator.mediaDevices;
if (md && md.getUserMedia) {
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = (c = {}) => {
    const id = cfg.in && cfg.in.id;
    if (id && c.audio && !(typeof c.audio === "object" && c.audio.deviceId)) c = { ...c, audio: { ...(typeof c.audio === "object" ? c.audio : {}), deviceId: { ideal: id } } };
    return orig(c);
  };
}
const outId = () => (cfg.out && cfg.out.id) || "";
function sink(el) { const id = outId(); if (id && el && el.setSinkId) el.setSinkId(id).catch(() => {}); return el; }
if (window.Audio) {
  const A = window.Audio;
  const Hooked = function (src) { return sink(src === undefined ? new A() : new A(src)); };
  Hooked.prototype = A.prototype;
  window.Audio = Hooked;
}
for (const name of ["AudioContext", "webkitAudioContext"]) {
  const C = window[name];
  if (!C) continue;
  window[name] = class extends C { constructor(...a) { super(...a); const id = outId(); if (id && this.setSinkId) this.setSinkId(id).catch(() => {}); } };
}
// <audio> elements in the page (the song player)
new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.tagName === "AUDIO") sink(n); else n.querySelectorAll?.("audio").forEach(sink); } })
  .observe(document.documentElement, { childList: true, subtree: true });

// ---------- the page ----------
const canPickOutput = "setSinkId" in HTMLMediaElement.prototype;
const clean = (label) => String(label || "").replace(/^(Default|Communications|Standard|Kommunikation)\s*-\s*/i, "").replace(/\s*\((Bluetooth|[0-9a-f]{4}:[0-9a-f]{4})\)\s*$/i, "").trim();
const BT = /airpods|buds|bluetooth|headset|hands-?free|kopfhörer|soundcore|jabra|bose|sony wh|wf-/i;
let meter = null;   // the live level of the chosen microphone while the page is open

function stopMeter() { if (meter) { cancelAnimationFrame(meter.raf); meter.stream.getTracks().forEach((t) => t.stop()); try { meter.ctx.close(); } catch {} meter = null; } }
async function startMeter(bar, note) {
  stopMeter();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)(), an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const data = new Float32Array(an.fftSize); let peak = 0, heard = 0;
    meter = { stream, ctx, raf: 0 };
    const t0 = performance.now(), track = stream.getAudioTracks()[0];
    const tick = () => {
      if (!meter || !bar.isConnected) return stopMeter();
      an.getFloatTimeDomainData(data); let s = 0; for (const x of data) s += x * x;
      const rms = Math.sqrt(s / data.length); peak = Math.max(rms, peak * 0.92); if (rms > 0.01) heard = performance.now();
      bar.style.setProperty("--lv", Math.min(1, peak * 9).toFixed(3));
      const quiet = performance.now() - t0 > 4000 && !heard;
      note.textContent = quiet ? `“${clean(track.label)}” hears nothing. Say something, or pick another microphone.` : `Listening on “${clean(track.label)}”: speak and the bar moves.`;
      note.classList.toggle("warn", quiet);
      meter.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { note.textContent = e.name === "NotAllowedError" ? "The browser isn't allowed to use the microphone: allow it (the icon in the address bar) and try again." : "Couldn't open the microphone: " + e.message; note.classList.add("warn"); }
}
function testTone() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)(), now = ctx.currentTime;
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0, now + i * 0.18); g.gain.linearRampToValueAtTime(0.18, now + i * 0.18 + 0.02); g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.18 + 0.5);
    o.connect(g).connect(ctx.destination); o.start(now + i * 0.18); o.stop(now + i * 0.18 + 0.55);
  });
  setTimeout(() => ctx.close().catch(() => {}), 1400);
}
const opts = (list, chosen, auto) => `<option value="">${esc(auto)}</option>` + list.map((d) => `<option value="${esc(d.value)}"${d.value === chosen ? " selected" : ""}>${esc(d.label)}</option>`).join("");

async function paint() {
  const box = $("#soundBox"); if (!box) return;
  stopMeter();
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const named = devs.some((d) => d.label);
  const ins = devs.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications").map((d) => ({ value: d.deviceId, label: clean(d.label) || "Microphone" }));
  const outs = devs.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications").map((d) => ({ value: d.deviceId, label: clean(d.label) || "Speakers" }));
  // a choice whose device is gone (unplugged) falls back to the system default, and says so
  const gone = (c, list) => c && c.id && named && !list.some((d) => d.value === c.id);
  box.innerHTML = `
    <div class="snd-sec"><small>Here, in Albatross (this ${/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone or tablet" : "computer"})</small>
      ${named ? "" : '<div class="note" style="margin:0">The browser only shows device names after you allow the microphone once. <button class="btn small" type="button" id="sndAllow">Allow</button></div>'}
      <label class="snd-row"><span>Microphone<small>For dictating and talking hands-free.</small></span><select id="sndIn">${opts(ins, cfg.in && cfg.in.id, "Automatic (the system's microphone)")}</select></label>
      <div class="snd-meter"><div class="snd-bar" id="sndBar"></div><button class="btn small" type="button" id="sndTest">Test</button></div>
      <small class="snd-note" id="sndNote">${gone(cfg.in, ins) ? `“${esc(cfg.in.label)}” isn't connected: the system's microphone is used until it is back.` : "Press Test and speak: the bar shows what the microphone hears."}</small>
      <label class="snd-row"><span>Speakers<small>For answers read aloud, music and songs.</small></span><select id="sndOut"${canPickOutput ? "" : " disabled"}>${opts(outs, cfg.out && cfg.out.id, canPickOutput ? "Automatic (the system's speakers)" : "This browser always uses the system's speakers")}</select></label>
      <div class="row"><button class="btn small" type="button" id="sndTone">Play a test sound</button>${gone(cfg.out, outs) ? `<small class="snd-note warn">“${esc(cfg.out.label)}” isn't connected: the system's speakers are used.</small>` : ""}</div>
    </div>
    <div class="snd-sec" id="sndJarvis"><small>Jarvis on your PC</small><div class="note" style="margin:0">Asking Jarvis…</div></div>`;
  const inSel = $("#sndIn"), outSel = $("#sndOut");
  inSel.onchange = () => { const o = inSel.selectedOptions[0]; cfg.in = inSel.value ? { id: inSel.value, label: o.textContent } : null; save(cfg); if (meter) startMeter($("#sndBar"), $("#sndNote")); toast(inSel.value ? "Microphone: " + o.textContent : "Microphone: automatic"); };
  outSel.onchange = () => { const o = outSel.selectedOptions[0]; cfg.out = outSel.value ? { id: outSel.value, label: o.textContent } : null; save(cfg); testTone(); };
  $("#sndTest").onclick = (e) => { if (meter) { stopMeter(); e.target.textContent = "Test"; $("#sndBar").style.setProperty("--lv", 0); $("#sndNote").textContent = "Press Test and speak: the bar shows what the microphone hears."; } else { e.target.textContent = "Stop"; startMeter($("#sndBar"), $("#sndNote")); } };
  $("#sndTone").onclick = testTone;
  if ($("#sndAllow")) $("#sndAllow").onclick = async () => { try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch (e) { toast("The microphone wasn't allowed"); } paint(); };
  paintJarvis(ins, outs);
}

async function paintJarvis(ins, outs) {
  const sec = $("#sndJarvis"); if (!sec || typeof jarvisCall !== "function") return;
  let r;
  try { r = await jarvisCall("GET", "/audio"); } catch { r = { status: 0, j: {} }; }
  if (!sec.isConnected) return;
  if (r.status !== 200 || !Array.isArray(r.j.inputs)) {
    const off = r.j && r.j.offline, old = r.status === 404;
    sec.innerHTML = '<small>Jarvis on your PC</small><div class="note" style="margin:0"></div>';
    sec.querySelector(".note").textContent = old ? "Jarvis on your PC is an older version: update it to choose its microphone and speakers here." : off ? "Jarvis isn't running. Start it, then come back here to pick its microphone and speakers." : "Connect to your PC to pick Jarvis's microphone and speakers.";
    if (off && r.j.canStart) { const b = document.createElement("button"); b.className = "btn small"; b.type = "button"; b.textContent = "Start Jarvis"; b.onclick = async () => { b.disabled = true; await jarvisCall("POST", "/start").catch(() => {}); setTimeout(() => paintJarvis(ins, outs), 6000); }; sec.querySelector(".note").append(" ", b); }
    return;
  }
  const j = r.j, list = (names) => names.map((n) => ({ value: n, label: n }));
  sec.innerHTML = `<small>Jarvis on your PC</small>
    <label class="snd-row"><span>Microphone<small>For “Jarvis” and the mic button.</small></span><select id="jvIn">${opts(list(j.inputs), j.input, "Automatic (skips silent virtual ones)")}</select></label>
    <small class="snd-note" id="jvInNote"></small>
    <label class="snd-row"><span>Speakers<small>For Jarvis's voice.</small></span><select id="jvOut">${opts(list(j.outputs), j.output, "Automatic (the Windows default)")}</select></label>
    <div class="row"><button class="btn small" type="button" id="jvSame" hidden>Use the same as Albatross</button></div>`;
  const inSel = $("#jvIn"), outSel = $("#jvOut"), note = $("#jvInNote");
  const explain = () => {
    note.textContent = BT.test(inSel.value)
      ? "This looks like a Bluetooth headset: while Jarvis listens on it, it switches to hands-free mode and everything it plays sounds like a phone call. Automatic keeps the wake word off it and borrows it only while you hold the mic button."
      : inSel.value ? "" : "Automatic: the Windows default microphone, unless it hears nothing (like a game's virtual one).";
    note.classList.toggle("warn", BT.test(inSel.value));
  };
  explain();
  const send = async (body, msg) => {
    try { const x = await jarvisCall("POST", "/audio", body); if (x.status !== 200) throw new Error(x.j.error || "HTTP " + x.status); toast(msg); } catch (e) { toast("Jarvis didn't take it: " + e.message); }
  };
  inSel.onchange = () => { explain(); send({ input: inSel.value }, inSel.value ? "Jarvis listens on " + inSel.value : "Jarvis picks its microphone by itself"); };
  outSel.onchange = () => send({ output: outSel.value }, outSel.value ? "Jarvis talks through " + outSel.value : "Jarvis talks through the Windows default");
  // on the PC itself the names match Windows' own: offer to copy the choice from above
  const match = (label, names) => { const l = clean(label).toLowerCase(); return l ? names.find((n) => l.includes(n.toLowerCase()) || n.toLowerCase().includes(l)) || "" : ""; };
  const mi = cfg.in && match(cfg.in.label, j.inputs), mo = cfg.out && match(cfg.out.label, j.outputs);
  const same = $("#jvSame");
  if ((mi && mi !== j.input) || (mo && mo !== j.output)) {
    same.hidden = false;
    same.onclick = async () => { const body = {}; if (mi) body.input = inSel.value = mi; if (mo) body.output = outSel.value = mo; explain(); await send(body, "Jarvis uses the same microphone and speakers"); same.hidden = true; };
  }
}

document.querySelector('#settings .tabs [data-tab="sound"]')?.addEventListener("click", paint);
document.getElementById("settings")?.addEventListener("close", stopMeter);
navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (document.querySelector('#settings .pane[data-pane="sound"].on')) paint(); });
window.AlbatrossSound = { paint, stopMeter, settings: () => ({ ...cfg }), _set: (c) => { cfg = c || {}; save(cfg); }, clean };
})();
