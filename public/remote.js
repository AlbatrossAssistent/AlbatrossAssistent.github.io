"use strict";
// Remote desktop: the PC's screen, live, on this device, with its mouse and keyboard.
// First choice, live video (like Chrome Remote Desktop): a WebRTC connection straight to the Albatross app on the PC (desktop/rtc.js),
// set up once through /pc/rtc; the screen comes as video (only what changes travels) and the mouse and keyboard go back over a data
// channel of the same connection, no server in between. If that can't connect (the app isn't open on the PC, or the two networks
// can't reach each other directly), the pictures: JPEGs from the desktop helper (host/remotedesk.js → remotedesk.ps1) through
// /pc/deskstream, with clicks, drags, scrolling and keys going to /pc/desk.
// Where you click is sent as a place in the picture (0 to 1), so this page never needs the PC's resolution.
// With live video and a new enough Windows app, a finger is a finger on the PC (Windows touch input: tap, drag to scroll, pinch,
// press and hold = right-click; the mouse pointer hides while you touch, as on a touchscreen laptop). Otherwise touch imitates the mouse:
//   Mouse: click, double-click, right-click, drag, wheel. Touch: tap = click, two-finger tap or long press = right-click,
//   drag with one finger = drag, two fingers = scroll. Keyboard: everything you press while the screen has the focus; on a phone
//   the keyboard button opens the on-screen keyboard. Special keys and shortcuts are in the bar.
// Uses the main page's helpers: $, esc, toast, pcCall, pcStream, connected, remotePC.
(() => {
const R = { open: false, ctrl: null, screen: null, screens: [], quality: "auto", frame: null, queue: Promise.resolve(), moveT: 0, lastMove: null, down: null, keysDown: new Set(), frames: 0, fpsT: 0,
  pc: null, dc: null, video: false, rtcBadUntil: 0, seq: 0, touch: false, tuned: false, showSum: 0, showN: 0, pcStat: null, canCover: false, coverWant: false, dcHello: null,
  hz: 0, hzP: null, fpsWant: 60, pcFps: 0, hiWin: null, hiBad: 0, hiOff: false };
const page = () => $("#remotePage");
const QUAL = { auto: null, sharp: { max: 1920, q: 70, fps: 8 }, normal: { max: 1280, q: 50, fps: 12 }, fast: { max: 960, q: 40, fps: 15 } };
const settings = () => QUAL[R.quality] || (remotePC() ? QUAL.normal : QUAL.sharp);
// live video: much more for the same data (only changes travel), so higher sizes and rates
// auto: 60 frames a second (a new picture every 16 ms instead of 33, and decoders that hold a frame or two hold them half as long),
// with up to 20 Mbit/s so a big change (a window opening) gets through at once; when the video goes over the internet rather than
// inside your network, it's turned down to 30 and 8 (liveStats)
const VQUAL = { auto: { maxW: 1920, fps: 60, bitrate: 20e6 }, sharp: { maxW: 2560, fps: 30, bitrate: 14e6 }, normal: { maxW: 1920, fps: 30, bitrate: 8e6 }, fast: { maxW: 1280, fps: 60, bitrate: 6e6 } };
// 120 frames a second (a new picture every 8 ms instead of 16) where it helps: Auto or Fast, this device's screen shows 100 or more
// pictures a second (screenHz), and it kept up with 120 the last time (if not, 60 here for 14 days). The PC sends no more than its
// own monitor shows (a 60 Hz monitor: 60), and only while the screen moves: a still screen sends nothing new.
const HI = { auto: { fps: 120, bitrate: 30e6 }, fast: { fps: 120, bitrate: 10e6 } };
const no120 = () => { try { return Date.now() - Number(localStorage.getItem("burrow.rd120off") || 0) < 14 * 864e5; } catch { return false; } };
const vq = () => { const q = VQUAL[R.quality] || VQUAL.auto, hi = HI[R.quality] || (VQUAL[R.quality] ? null : HI.auto); return hi && R.hz >= 100 && !no120() ? { ...q, ...hi } : q; };
// how many pictures a second this device's screen shows (60, 90, 120, 144…), from the gaps between animation frames; 0 when the
// page isn't on screen (no frames come)
function screenHz() {
  return new Promise((ok) => {
    const t = [];
    const step = (now) => {
      t.push(now);
      if (t.length < 25) return requestAnimationFrame(step);
      const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
      ok(Math.round(1000 / d[d.length >> 1]));
    };
    requestAnimationFrame(step);
    setTimeout(() => ok(0), 1500);
  });
}
const live = () => R.dc && R.dc.readyState === "open";
// inputs go out one after the other, in order; a slow one never lets the next overtake it
const send = (o) => { if (live()) { try { R.dc.send(JSON.stringify(o)); return Promise.resolve(); } catch {} } R.queue = R.queue.then(() => pcCall("/pc/desk", { screen: R.screen, ...o }).catch((e) => { if (/Unknown|404/.test(e.message)) toast("Update Albatross on the PC for remote desktop"); })); return R.queue; };
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
      <button class="icon-btn rd-cover" type="button" data-rd="cover" aria-pressed="false" hidden>${I('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M3 3l18 18"/>')}</button>
      <button class="icon-btn" type="button" data-rd="kbd" title="Keyboard (type on the PC)" aria-label="Keyboard">${I('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>')}</button>
      <button class="icon-btn" type="button" data-rd="full" title="Full screen" aria-label="Full screen">${I('<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>')}</button>
    </div>
    <div class="rd-keys" id="rdKeys">
      ${[["Esc", "esc"], ["Tab", "tab"], ["Win", "win"], ["Enter", "enter"], ["⌫", "backspace"], ["Del", "delete"], ["Alt+Tab", "alt+tab"], ["Ctrl+C", "ctrl+c"], ["Ctrl+V", "ctrl+v"], ["Ctrl+Z", "ctrl+z"], ["Ctrl+A", "ctrl+a"], ["Win+D", "win+d"], ["Alt+F4", "alt+f4"], ["Task Mgr", "ctrl+shift+esc"], ["←", "left"], ["↑", "up"], ["↓", "down"], ["→", "right"]]
        .map(([l, c]) => `<button type="button" data-combo="${c}">${esc(l)}</button>`).join("")}
    </div>
    <div class="rd-stage" id="rdStage" tabindex="0" aria-label="The PC's screen: click here, then use mouse and keyboard">
      <img id="rdImg" alt="" draggable="false">
      <video id="rdVid" autoplay playsinline muted hidden></video>
      <div class="rd-msg" id="rdMsg">Connecting to the PC's screen…</div>
      <textarea id="rdType" class="rd-type" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Type on the PC"></textarea>
    </div>`;
  page().querySelector('[data-rd="back"]').onclick = () => setView("home");
  page().querySelector('[data-rd="full"]').onclick = () => { const st = $("#rdStage"); (document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen && st.requestFullscreen()).catch?.(() => {}); };
  page().querySelector('[data-rd="cover"]').onclick = () => {
    R.coverWant = !R.coverWant;
    try { localStorage.setItem("burrow.rdCover", JSON.stringify(R.coverWant)); } catch {}
    const ch = R.dc || R.dcHello; try { if (ch && ch.readyState === "open") ch.send(JSON.stringify({ t: "cover", on: R.coverWant })); } catch {}
    coverBtn(); toast(R.coverWant ? "The PC's monitor shows a cover screen now. You still see everything." : "The PC's monitor shows the desktop again.");
    $("#rdStage").focus({ preventScroll: true });
  };
  page().querySelector('[data-rd="kbd"]').onclick = () => { const t = $("#rdType"); t.value = ""; t.focus(); };
  page().querySelectorAll("[data-combo]").forEach((b) => (b.onclick = () => { send({ t: "combo", combo: b.dataset.combo }); $("#rdStage").focus({ preventScroll: true }); }));
  $("#rdQual").value = R.quality;
  $("#rdQual").onchange = (e) => { R.quality = e.target.value; try { localStorage.setItem("burrow.rdQuality", JSON.stringify(R.quality)); } catch {} watch(); };
  $("#rdScreen").onchange = (e) => { R.screen = Number(e.target.value); watch(); };
  wireInput();
}

// ---------- live video (WebRTC) ----------
const ICE = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
const gathered = (p) => new Promise((ok) => { if (p.iceGatheringState === "complete") return ok(); const t = setTimeout(ok, 3000); p.addEventListener("icegatheringstatechange", () => { if (p.iceGatheringState === "complete") { clearTimeout(t); ok(); } }); });
// WebRTC starts slowly (about 0.3 Mbit/s) and works its way up; a desktop's big pictures then wait in a queue, which is the delay
// you feel. In the offer the PC gets (it sends with the codec settings from there): start at 6 Mbit/s, never below 1 (in your own
// Wi-Fi that's nothing; on a slow line WebRTC still comes down by itself).
function fastStart(sdp, maxKbps) {
  const add = "x-google-start-bitrate=6000;x-google-min-bitrate=1000;x-google-max-bitrate=" + Math.max(2000, Math.round(maxKbps));
  const lines = sdp.split(/\r\n/), out = [];
  const video = new Set();
  for (const l of lines) { const m = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\/90000/i.exec(l); if (m) video.add(m[1]); }
  const hasFmtp = new Set(lines.map((l) => (/^a=fmtp:(\d+) /.exec(l) || [])[1]).filter(Boolean));
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && video.has(f[1])) { out.push(l + ";" + add); continue; }
    out.push(l);
    const r = /^a=rtpmap:(\d+) /.exec(l);
    if (r && video.has(r[1]) && !hasFmtp.has(r[1])) out.push("a=fmtp:" + r[1] + " " + add);
  }
  return out.join("\r\n");
}
const within = (ms, why, pr) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error(why)), ms))]);
function rtcStop() {
  fingersLift();
  const { pc, dc } = R; R.pc = null; R.dc = null; R.video = false; R.lastBytes = null; R.touch = false; R.tuned = false; R.pcStat = null; R.canCover = false; R.dcHello = null; coverBtn();
  R.pcFps = 0; R.hiWin = null; R.hiBad = 0; R.hiOff = false;
  try { if (dc && dc.readyState === "open") dc.send(JSON.stringify({ t: "bye" })); } catch {}
  try { if (pc) pc.close(); } catch {}
  const v = $("#rdVid"); if (v) { v.srcObject = null; v.hidden = true; }
  const i = $("#rdImg"); if (i) i.hidden = false;
}
async function rtcStart(seq) {
  if (!window.RTCPeerConnection || Date.now() < R.rtcBadUntil) return false;
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const tr = pc.addTransceiver("video", { direction: "recvonly" });
  // H.264 first: the PC encodes it on the graphics card, and phones and laptops decode it in hardware (VP8 is decoded in software,
  // which on a phone can't keep up at this size: fewer frames and a growing delay)
  try { const c = RTCRtpReceiver.getCapabilities("video").codecs; tr.setCodecPreferences([...c.filter((x) => /h264/i.test(x.mimeType)), ...c.filter((x) => !/h264/i.test(x.mimeType))]); } catch {}
  const dc = pc.createDataChannel("input", { ordered: true });
  // the PC says what it can do: a new enough app takes fingers as touch input
  // and every 2 seconds how long a frame takes there (for the delay in the bar)
  // and whether it can cover its monitors (then it does again, if you had that on)
  dc.onmessage = (m) => {
    try {
      const o = JSON.parse(m.data); if (pc !== R.pc) return;
      if (o.t === "hello") {
        R.touch = !!o.touch; R.canCover = !!o.cover; R.dcHello = dc; coverBtn();
        R.pcFps = Number(o.fps) || 0;          // the most frames a second the PC captures (an older app doesn't say: 60 at most)
        if (R.canCover && R.coverWant) dc.send(JSON.stringify({ t: "cover", on: true }));
      }
      if (o.t === "pc") R.pcStat = o;
    } catch {}
  };
  const track = new Promise((ok) => (pc.ontrack = (e) => {
    // show each frame as soon as it's there: no waiting room for smoothness (it's a desktop, not a film)
    try { e.receiver.jitterBufferTarget = 0; } catch {}
    try { e.receiver.playoutDelayHint = 0; } catch {}
    ok(e.streams[0] || new MediaStream([e.track]));
  }));
  R.pc = pc;
  try {
    msg("Connecting to the PC's screen (live video)…");
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (R.hzP) await R.hzP;                  // measured while the connection was being prepared
    const q = vq(); R.fpsWant = q.fps;
    // no bigger than this device can show (a phone gets fewer pixels to decode)
    const maxW = R.quality === "auto" ? Math.max(1280, Math.min(q.maxW, Math.round(Math.max(screen.width, screen.height) * (devicePixelRatio || 1)))) : q.maxW;
    const r = await pcCall("/pc/rtc", { sdp: fastStart(pc.localDescription.sdp, q.bitrate / 1000), screen: R.screen, maxW, fps: q.fps, bitrate: q.bitrate });
    if (seq !== R.seq) throw new Error("replaced");
    if (r.screens && r.screens.length) screensList(r.screens, r.screen);
    await pc.setRemoteDescription({ type: "answer", sdp: r.sdp });
    // connected, the data channel open and a first picture within 12 seconds each, or it's the pictures
    const stream = await within(12000, "no direct connection", track);
    await within(12000, "no direct connection", new Promise((ok) => { if (dc.readyState === "open") ok(); else dc.onopen = ok; }));
    const v = $("#rdVid");
    v.srcObject = stream; v.hidden = false; $("#rdImg").hidden = true;
    await within(12000, "no picture", new Promise((ok) => { if (v.readyState >= 2) ok(); else v.onloadeddata = ok; }));
    if (seq !== R.seq) throw new Error("replaced");
    R.dc = dc; R.video = true; msg("");
    pc.onconnectionstatechange = () => {
      if (seq !== R.seq || !R.open) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") { R.rtcBadUntil = Date.now() + 60e3; watch(); }
    };
    countFrames(v, seq);
    return true;
  } catch (e) {
    if (pc === R.pc) rtcStop();
    if (seq === R.seq && e.message !== "replaced") { R.rtcBadUntil = Date.now() + 2 * 60e3; R.rtcWhy = e.message || "it didn't connect"; }     // not again for a while: the pictures
    return false;
  }
}
// "Hide the PC's monitor": only with live video from an app that can do it; on, the PC's monitors show a cover screen
function coverBtn() {
  const b = page() && page().querySelector('[data-rd="cover"]'); if (!b) return;
  b.hidden = !R.canCover; b.classList.toggle("on", R.coverWant); b.setAttribute("aria-pressed", String(R.coverWant));
  b.title = R.coverWant ? "The PC's monitor shows a cover screen; you still see everything. Click to show the desktop there again."
    : "Hide the PC's monitor: people at the PC see a cover screen, you still see everything";
  b.setAttribute("aria-label", b.title);
}
// frames per second of the video, for the bar
function countFrames(v, seq) {
  R.frames = 0; R.fpsT = Date.now();
  const next = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : setTimeout(tick, 33));
  const tick = (_now, md) => {
    if (seq !== R.seq || !R.video) return;
    R.frame = { w: v.videoWidth, h: v.videoHeight };
    R.frames++;
    // this device's part of the delay: from the picture arriving to it being on the screen (decoding, any buffer, drawing)
    if (md && md.receiveTime > 0 && md.expectedDisplayTime > 0) { const d = md.expectedDisplayTime - md.receiveTime; if (d >= 0 && d < 2000) { R.showSum += d; R.showN++; } }
    const now = Date.now();
    if (now - R.fpsT > 2000) { const fps = Math.round(R.frames * 1000 / (now - R.fpsT)); R.frames = 0; R.fpsT = now; liveStats(fps); }
    next();
  };
  next();
}

// the bar: frames per second, the codec, and how long a picture takes to arrive (the network's round trip, and the time it waits
// to be decoded), so a slow spot can be told apart
async function liveStats(fps) {
  const show = R.showN ? R.showSum / R.showN : null, pcs = R.pcStat; R.showSum = 0; R.showN = 0;
  let t = "Live · " + fps + " fps", delay = null, parts = "";
  try {
    const st = [...(await R.pc.getStats()).values()];
    const i = st.find((x) => x.type === "inbound-rtp" && x.kind === "video") || {};
    const c = st.find((x) => x.type === "codec" && x.id === i.codecId) || {};
    const pair = st.find((x) => x.type === "candidate-pair" && x.nominated && x.state === "succeeded") || {};
    const rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
    // the delay from the PC's screen to this one, added up: encoding and waiting to be sent on the PC (it reports them), half the
    // network's round trip, and arriving to shown here (the screen capture itself, a few ms, isn't in it)
    if (pcs && show != null && rtt != null) {
      delay = Math.round(pcs.enc + pcs.wait + rtt / 2 + show);
      parts = "Delay about " + delay + " ms: PC encoding " + Math.round(pcs.enc) + " + waiting to send " + Math.round(pcs.wait) + " + network " + Math.round(rtt / 2) + " + this device decoding and showing " + Math.round(show) + " · ";
      t += " · " + delay + " ms delay";
    }
    const buf = i.jitterBufferEmittedCount ? Math.round(i.jitterBufferDelay / i.jitterBufferEmittedCount * 1000) : null;
    const loc = st.find((x) => x.id === pair.localCandidateId) || {}, rem = st.find((x) => x.id === pair.remoteCandidateId) || {};
    const via = loc.candidateType === "relay" || rem.candidateType === "relay" ? "relayed" : (loc.candidateType === "srflx" || rem.candidateType === "srflx") ? "via the internet" : "in your network";
    if (rtt != null && delay == null) t += " · ping " + rtt + " ms";
    if (c.mimeType) t += " · " + c.mimeType.replace("video/", "");
    t += " · " + via;
    // auto starts for your own network (120 or 60 frames a second, up to 30 or 20 Mbit/s); over the internet it's 30 and 8 Mbit/s,
    // what a line out of the house can carry without the pictures queueing up (Fast at 120 goes back to its 60)
    if (!R.tuned && pair.id && live()) {
      R.tuned = true;
      if (via !== "in your network" && R.quality === "auto") { R.fpsWant = 30; R.dc.send(JSON.stringify({ t: "tune", fps: 30, bitrate: 8e6 })); }
      else if (via !== "in your network" && R.fpsWant >= 100) { R.fpsWant = 60; R.dc.send(JSON.stringify({ t: "tune", fps: 60, bitrate: (VQUAL[R.quality] || VQUAL.auto).bitrate })); }
    }
    // 120 frames a second, checked while the PC really sends 90 or more (the screen moves): this device falls behind when it decodes
    // fewer than 80% of them, drops more than 5%, or its screen shows fewer than 75% of the decoded ones. Twice in a row: back to 60
    // (and 60 here for the next 14 days)
    const now = performance.now(), hw = R.hiWin;
    R.hiWin = { t: now, dec: i.framesDecoded || 0, drop: i.framesDropped || 0 };
    const hiOn = R.fpsWant >= 100 && R.pcFps >= 100;
    if (hiOn && !R.hiOff && live() && hw && pcs && pcs.fps >= 90 && now - hw.t > 500) {
      const dec = R.hiWin.dec - hw.dec, drop = R.hiWin.drop - hw.drop, decFps = dec * 1000 / (now - hw.t);
      R.hiBad = decFps < pcs.fps * 0.8 || drop > dec * 0.05 || fps < decFps * 0.75 ? R.hiBad + 1 : 0;
      if (R.hiBad >= 2) {
        R.hiOff = true; R.fpsWant = 60;
        R.dc.send(JSON.stringify({ t: "tune", fps: 60, bitrate: (VQUAL[R.quality] || VQUAL.auto).bitrate }));
        try { localStorage.setItem("burrow.rd120off", String(Date.now())); } catch {}
      }
    }
    const kbps = R.lastBytes != null ? Math.round((i.bytesReceived - R.lastBytes) * 8 / 2000) : null; R.lastBytes = i.bytesReceived;
    $("#rdStat").title = parts + (hiOn ? "up to 120 frames a second · " : R.hiOff ? "back to 60 frames a second: this device didn't keep up with 120 · " : "") + (pcs && pcs.limit && pcs.limit !== "none" ? "PC held back by " + pcs.limit + " · " : "") + (kbps != null ? kbps + " kbit/s · " : "") + (i.frameWidth ? i.frameWidth + "×" + i.frameHeight + " · " : "") + "network round trip " + (rtt ?? "?") + " ms · waiting before showing " + (buf ?? "?") + " ms · decoder " + (i.decoderImplementation || "?") + " · frames dropped " + (i.framesDropped ?? 0);
  } catch {}
  if (R.video) $("#rdStat").textContent = t;
}

// ---------- the pictures ----------
async function watch() {
  if (R.ctrl) R.ctrl.abort();
  R.ctrl = null;
  rtcStop();
  const seq = ++R.seq;
  if (await rtcStart(seq)) return;
  if (seq !== R.seq || !R.open) return;
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
  if (now - R.fpsT > 2000) {
    // the slow way: say so, and why there's no live video (so it's never mistaken for it)
    $("#rdStat").textContent = "Pictures (slow) · " + Math.round(R.frames * 1000 / (now - R.fpsT || 1)) + " fps";
    $("#rdStat").title = "No live video" + (R.rtcWhy ? ": " + R.rtcWhy : "") + ". It tries live video again when you reopen remote desktop or change the quality.";
    R.frames = 0; R.fpsT = now;
  }
}
function screensList(list, cur) {
  R.screens = list || []; if (R.screen == null) R.screen = cur;
  const sel = $("#rdScreen");
  sel.hidden = R.screens.length < 2;
  sel.innerHTML = R.screens.map((s) => `<option value="${s.i}">Screen ${s.i + 1}${s.primary ? " (main)" : ""} · ${s.w}×${s.h}</option>`).join("");
  sel.value = String(R.screen);
}

// ---------- mouse, touch and keyboard ----------
// where in the picture (0..1) a pointer is; null outside the picture (the black bars of a different shape), or with clamp the
// nearest edge
function at(e, clamp) {
  const img = R.video ? $("#rdVid") : $("#rdImg"), r = img.getBoundingClientRect();
  if (!R.frame || !r.width) return null;
  // the picture keeps its shape inside the stage (object-fit: contain): work out where it really is
  const k = Math.min(r.width / R.frame.w, r.height / R.frame.h), w = R.frame.w * k, h = R.frame.h * k, x0 = r.left + (r.width - w) / 2, y0 = r.top + (r.height - h) / 2;
  const x = (e.clientX - x0) / w, y = (e.clientY - y0) / h;
  return !clamp && (x < -0.01 || y < -0.01 || x > 1.01 || y > 1.01) ? null : { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
function moveSoon(p) {
  R.lastMove = p;
  // live video: every move goes at once (the PC keeps only the newest while it's busy); the pictures' way, at most 25 a second
  if (live()) { sendMove(p); return; }
  if (R.moveT) return;
  R.moveT = setTimeout(() => { R.moveT = 0; if (R.lastMove) sendMove(R.lastMove); }, 40);    // at most 25 moves a second
}
// Each move takes a round trip to the PC (through the Albatross server when you're away). Queued one by one they piled up and the
// pointer trailed further and further behind; now only the newest position waits while one is on its way.
let moveWaiting = false;
function sendMove(p) {
  if (live()) { try { R.dc.send(JSON.stringify({ t: "move", ...p })); return; } catch {} }
  R.nextMove = p;
  if (moveWaiting) return;
  moveWaiting = true;
  R.queue = R.queue.then(() => { moveWaiting = false; const m = R.nextMove; R.nextMove = null; return m ? pcCall("/pc/desk", { screen: R.screen, t: "move", ...m }).catch(() => {}) : null; });
}
// ---------- fingers as fingers ----------
// With live video and a new enough Windows app, a finger here is a finger on the PC's screen: Windows touch input, as on a touchscreen
// laptop (tap, drag to scroll, pinch to zoom, press and hold for the right-click; Chrome Remote Desktop does the same). Windows hides
// the mouse pointer while you touch, so it isn't in the picture. Without that, touch imitates the mouse (in wireInput).
const fingers = new Map();        // pointerId -> { id (0..9 on the PC), x, y }
let fingerSent = 0, fingerBeat = 0;
const fingerMode = () => live() && R.touch;
// one frame: every finger that's down, where it is now; the one that just went down or up says so
function fingerFrame(changed) {
  const pts = [...fingers.values()].map((f) => ({ id: f.id, x: f.x, y: f.y, s: "move" }));
  if (changed) { const i = pts.findIndex((f) => f.id === changed.id); if (i >= 0) pts[i] = changed; else pts.push(changed); }
  if (!pts.length) return;
  try { R.dc.send(JSON.stringify({ t: "touch", pts })); fingerSent = Date.now(); } catch {}
}
// a finger held still is sent again every 100 ms, so it stays down on the PC (press and hold for the right-click needs that)
function fingerBeatOn() {
  if (fingerBeat) return;
  fingerBeat = setInterval(() => { if (!fingers.size || !live()) { clearInterval(fingerBeat); fingerBeat = 0; return; } if (Date.now() - fingerSent > 90) fingerFrame(null); }, 100);
}
function fingerDown(e, p) {
  if (fingers.size >= 10) return;
  const used = new Set([...fingers.values()].map((f) => f.id)); let id = 0; while (used.has(id)) id++;
  const f = { id, x: p.x, y: p.y }; fingers.set(e.pointerId, f);
  fingerFrame({ ...f, s: "down" }); fingerBeatOn();
}
function fingerMove(e) { const f = fingers.get(e.pointerId), p = at(e, true); if (!f || !p) return; f.x = p.x; f.y = p.y; fingerFrame(null); }
function fingerUp(e) {
  const f = fingers.get(e.pointerId); if (!f) return false;
  const p = at(e, true); if (p) { f.x = p.x; f.y = p.y; }
  fingers.delete(e.pointerId); fingerFrame({ ...f, s: "up" });
  return true;
}
function fingersLift() { for (const [k, f] of [...fingers]) { fingers.delete(k); fingerFrame({ ...f, s: "up" }); } }

function wireInput() {
  const st = $("#rdStage");
  const BTN = ["left", "middle", "right"];
  let touch = null;
  st.addEventListener("contextmenu", (e) => e.preventDefault());
  st.addEventListener("pointerdown", (e) => {
    const p = at(e); if (!p) return;
    st.focus({ preventScroll: true });
    if (e.pointerType === "touch" && fingerMode()) { e.preventDefault(); fingerDown(e, p); return; }
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
    if (e.pointerType === "touch" && fingers.has(e.pointerId)) { fingerMove(e); return; }
    const p = at(e); if (!p) return;
    if (e.pointerType === "touch" && touch && touch.id === e.pointerId) {
      if (!touch.moved && Math.hypot(p.x - touch.start.x, p.y - touch.start.y) > 0.01) { touch.moved = true; clearTimeout(touch.long); if (!touch.longDone) { touch.dragging = true; send({ t: "down", button: "left", ...touch.start }); } }
      if (touch.dragging) moveSoon(p);
      return;
    }
    if (e.pointerType !== "touch") moveSoon(p);
  });
  const up = (e) => {
    if (e.pointerType === "touch" && fingerUp(e)) return;
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
  st.addEventListener("touchstart", (e) => { if (fingerMode()) return; if (e.touches.length === 2) { if (touch) { clearTimeout(touch.long); touch = null; } const y = (e.touches[0].clientY + e.touches[1].clientY) / 2; two = { y, y0: y, t: Date.now(), p: at(e.touches[0]) }; } }, { passive: true });
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
function releaseKeys() { fingersLift(); for (const code of R.keysDown) send({ t: "key", code, down: false }); R.keysDown.clear(); if (R.down) { send({ t: "up", button: R.down, ...(R.lastMove || { x: 0.5, y: 0.5 }) }); R.down = null; } }

window.remoteOpen = function () {
  if (R.open) return;
  R.open = true;
  try { R.quality = JSON.parse(localStorage.getItem("burrow.rdQuality")) || "auto"; } catch { R.quality = "auto"; }
  try { R.coverWant = JSON.parse(localStorage.getItem("burrow.rdCover")) === true; } catch { R.coverWant = false; }
  shell();
  if (!connected) { msg("Connect to your PC first (Home → Connect)."); R.open = false; return; }
  R.fpsT = Date.now(); R.frames = 0;
  R.hzP = screenHz().then((h) => { R.hz = h; });
  watch();
  setTimeout(() => $("#rdStage") && $("#rdStage").focus({ preventScroll: true }), 80);
};
window.remoteClose = function () {
  if (!R.open) return;
  releaseKeys();
  R.open = false; R.seq++;
  if (R.ctrl) R.ctrl.abort(); R.ctrl = null;
  rtcStop();
  if (document.fullscreenElement && document.fullscreenElement.id === "rdStage") document.exitFullscreen().catch(() => {});
};
})();
