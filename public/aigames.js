"use strict";
// AI games: what an AI can see.
//   Detect: finds people and about 80 kinds of things (COCO-SSD with TensorFlow.js, run in this browser on the graphics card) in the
//     camera, a shared screen or window, a picture or a video, and draws a box around each. The picture never leaves this device,
//     and it never moves the mouse.
//   Target range: a small shooting-range game made for it. Cardboard people walk across three lanes and pop up behind crates; the AI
//     sees only the game's picture (the same detector, nothing from inside the game) and aims the game's own crosshair at what it
//     finds. You can play yourself, or both of you at once (Duel). The AI's crosshair lives inside the game: it never touches the
//     real mouse.
// Uses the main page's helpers: $, esc, toast.
(() => {
const TFJS = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const COCO = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";
const A = { open: false, tab: "detect", models: {}, acc: "lite_mobilenet_v2" };
const page = () => $("#aigamesPage");
const scripts = {};
const loadOnce = (u) => scripts[u] || (scripts[u] = new Promise((ok, no) => { const s = document.createElement("script"); s.src = u; s.onload = ok; s.onerror = () => { delete scripts[u]; no(new Error("Couldn't load the AI (no internet?)")); }; document.head.appendChild(s); }));
// the detector: "lite_mobilenet_v2" (fast) or "mobilenet_v2" (more precise, slower); loaded once each
function model(kind) {
  if (!A.models[kind]) A.models[kind] = (async () => { await loadOnce(TFJS); await loadOnce(COCO); return window.cocoSsd.load({ base: kind }); })().catch((e) => { delete A.models[kind]; throw e; });
  return A.models[kind];
}

function render() {
  const p = page(); if (!p) return;
  p.innerHTML = `<div class="ag-wrap">
    <div class="ag-head"><h1>AI games</h1><span class="sc-sp"></span>
      <div class="seg" role="tablist"><button type="button" data-tab="detect" class="${A.tab === "detect" ? "on" : ""}">Detect</button><button type="button" data-tab="teach" class="${A.tab === "teach" ? "on" : ""}">Teach it</button><button type="button" data-tab="range" class="${A.tab === "range" ? "on" : ""}">Target range</button></div>
      <select class="hub-in ag-acc" id="agAcc" aria-label="How the AI looks"><option value="lite_mobilenet_v2">Fast AI</option><option value="mobilenet_v2">Precise AI</option></select></div>
    <div id="agBody"></div></div>`;
  $("#agAcc").value = A.acc;
  $("#agAcc").onchange = (e) => { A.acc = e.target.value; if (A.tab === "detect") detectRestart(); };
  p.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { if (A.tab === b.dataset.tab) return; stopAll(); A.tab = b.dataset.tab; render(); }));
  if (A.tab === "detect") detectPage(); else if (A.tab === "teach") teachPage(); else rangePage();
}

// ======================================================================
// Detect
// ======================================================================
const D = { token: 0, kind: "", stream: null, preds: [], ms: 0, n: 0, t: 0, rate: 0, raf: 0 };
function detectPage() {
  $("#agBody").innerHTML = `
    <p class="sc-tip">Finds people and about 80 kinds of things (cars, dogs, cups, phones…) and draws a box around each. It runs in this browser: the picture never leaves this device.</p>
    <div class="ag-bar">
      <button class="btn small" type="button" data-src="camera">Camera</button>
      <button class="btn small" type="button" data-src="screen">Screen or window</button>
      <button class="btn small" type="button" data-src="file">Picture or video</button><input type="file" id="agFile" accept="image/*,video/*" hidden>
      <select class="hub-in" id="agWhat" aria-label="What to mark"><option value="person">Only people</option><option value="all">Everything it knows</option></select>
      <label class="ag-min">Sure at least <input type="range" id="agMin" min="20" max="90" step="5" value="50"> <span id="agMinV">50%</span></label>
      <button class="btn small ghost" type="button" data-src="stop">Stop</button>
    </div>
    <div class="ag-stage ag-det"><video id="agVid" playsinline muted autoplay hidden></video><img id="agImg" alt="" hidden><canvas id="agCv" width="960" height="540"></canvas><div class="ag-msg" id="agMsg">Pick the camera, a screen or window, or a picture or video.</div></div>
    <div class="ag-stat" id="agStat"></div>
`;
  const body = $("#agBody");
  body.querySelectorAll("[data-src]").forEach((b) => (b.onclick = () => (b.dataset.src === "file" ? $("#agFile").click() : b.dataset.src === "stop" ? detectStop("Stopped.") : detectStart(b.dataset.src))));
  $("#agFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) detectStart("file", f); };
  $("#agMin").oninput = (e) => { $("#agMinV").textContent = e.target.value + "%"; };
}
function msg(t) { const m = $("#agMsg"); if (m) { m.hidden = !t; m.textContent = t || ""; } }
function detectStop(text) {
  D.token++; cancelAnimationFrame(D.raf); D.preds = [];
  if (D.stream) D.stream.getTracks().forEach((t) => t.stop()); D.stream = null;
  const v = $("#agVid"); if (v) { v.pause(); v.srcObject = null; v.removeAttribute("src"); v.load(); v.hidden = true; }
  const im = $("#agImg"); if (im) im.hidden = true;
  if (text != null) msg(text);
  const st = $("#agStat"); if (st) st.textContent = "";
}
function detectRestart() { if (D.kind && D.media) { const k = D.kind; D.kind = ""; runDetect(k, D.media); } }
async function detectStart(kind, file) {
  detectStop(null);
  const v = $("#agVid"), img = $("#agImg");
  try {
    if (kind === "camera" || kind === "screen") {
      if (!navigator.mediaDevices) throw new Error("This browser can't share the camera or screen here (it needs https).");
      if (kind === "screen" && !navigator.mediaDevices.getDisplayMedia) throw new Error("This device can't share its screen (phones and tablets usually can't).");
      msg(kind === "camera" ? "Asking for the camera…" : "Pick a screen or window to share…");
      D.stream = kind === "camera" ? await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }) : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      D.stream.getVideoTracks()[0].onended = () => detectStop("The sharing ended.");
      v.srcObject = D.stream; await v.play(); runDetect("video", v);
    } else if (/^video\//.test(file.type)) {
      v.src = URL.createObjectURL(file); v.loop = true; await v.play(); runDetect("video", v);
    } else {
      img.src = URL.createObjectURL(file); await img.decode(); runDetect("image", img);
    }
  } catch (e) { detectStop(e.name === "NotAllowedError" ? "Not allowed: the browser (or you) said no." : e.message); }
}
async function runDetect(kind, media) {
  const token = ++D.token; D.kind = kind; D.media = media; D.preds = []; D.n = 0; D.rate = 0; D.t = performance.now();
  msg("Loading the AI (the first time takes a few seconds)…");
  let m; try { m = await model(A.acc); } catch (e) { msg(e.message); return; }
  if (token !== D.token) return;
  msg("");
  const cv = $("#agCv"), ctx = cv.getContext("2d");
  // the camera, video or picture itself is on the page (Chrome stops decoding a video nobody can see, and the AI then only saw an
  // empty picture); the canvas lies over it with only the boxes
  media.hidden = false;
  const size = () => { const w = media.videoWidth || media.naturalWidth, h = media.videoHeight || media.naturalHeight; if (w && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; } };
  // drawing every frame, with the newest boxes
  const draw = () => {
    if (token !== D.token) return;
    size(); ctx.clearRect(0, 0, cv.width, cv.height);
    const want = $("#agWhat").value, min = Number($("#agMin").value) / 100;
    const shown = D.preds.filter((p) => p.score >= min && (want === "all" || p.class === "person"));
    boxes(ctx, shown, cv.width);
    const people = shown.filter((p) => p.class === "person").length;
    const st = $("#agStat");
    if (st) st.textContent = `${people} ${people === 1 ? "person" : "people"}${want === "all" ? ` · ${shown.length} things in all` : ""}` + (D.rate ? ` · looks ${D.rate.toFixed(0)} times a second, ${D.ms.toFixed(0)} ms each` : "");
    if (kind === "video") D.raf = requestAnimationFrame(draw);
  };
  if (kind === "video") draw();
  // looking: as often as the graphics card allows (a picture: once, and again when the settings change)
  do {
    if (kind === "video" && media.readyState < 2) { await new Promise((r) => setTimeout(r, 50)); continue; }
    const t0 = performance.now();
    const preds = await m.detect(media, 40, 0.2).catch(() => []);
    if (token !== D.token) return;
    D.preds = preds; D.ms = performance.now() - t0; D.n++;
    const el = (performance.now() - D.t) / 1000; if (el > 1) { D.rate = D.n / el; D.n = 0; D.t = performance.now(); }
    if (kind === "image") { D.rate = 0; draw(); for (const id of ["agWhat", "agMin"]) $("#" + id).oninput = draw; $("#agMin").addEventListener("input", (e) => { $("#agMinV").textContent = e.target.value + "%"; }); return; }
    await new Promise((r) => setTimeout(r, 0));
  } while (token === D.token);
}
const COLORS = { person: "#30D158" };
function boxes(ctx, preds, w) {
  const lw = Math.max(2, w / 400), fs = Math.max(13, w / 60);
  ctx.font = `600 ${fs}px system-ui, sans-serif`; ctx.textBaseline = "top";
  for (const p of preds) {
    const [x, y, bw, bh] = p.bbox, c = COLORS[p.class] || "#FFD60A", label = `${p.class} ${Math.round(p.score * 100)}%`;
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.strokeRect(x, y, bw, bh);
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = c; ctx.fillRect(x - lw / 2, Math.max(0, y - fs - 6), tw, fs + 6);
    ctx.fillStyle = "#000"; ctx.fillText(label, x + 5 - lw / 2, Math.max(0, y - fs - 6) + 3);
  }
}

// ======================================================================
// Target range
// ======================================================================
const W = 960, H = 540;
const LANES = [{ y: 330, s: 0.82 }, { y: 425, s: 1.02 }, { y: 528, s: 1.25 }];       // far, middle, near: where the feet are, and the size
const SHIRTS = ["#C0392B", "#2471A3", "#1E8449", "#7D3C98", "#D68910", "#212F3D", "#5D6D7E", "#A04000"], PANTS = ["#1B2631", "#34495E", "#4D5656", "#283747", "#6E2C00"];
const SKIN = ["#F1C27D", "#E0AC69", "#C68642", "#8D5524", "#FFDBAC"], HAIR = ["#2C1B10", "#4A2F1B", "#000000", "#8B5A2B", "#D4B483"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
let R = null;
function rangePage() {
  $("#agBody").innerHTML = `
    <p class="sc-tip">A shooting range made for the AI: cardboard people walk by and pop up behind crates. The AI looks only at the game's picture, finds the people with the same detector as in Detect, and aims its own crosshair at them. It never touches your mouse.</p>
    <div class="ag-bar">
      <select class="hub-in" id="rgMode" aria-label="Who plays"><option value="ai">The AI plays</option><option value="you">You play</option><option value="duel">Duel: you against the AI</option></select>
      <select class="hub-in" id="rgSkill" aria-label="How quick the AI is"><option value="human">AI: human speed</option><option value="fast" selected>AI: fast</option><option value="max">AI: as fast as it can</option></select>
      <select class="hub-in" id="rgLen" aria-label="Round length"><option value="30">30 s</option><option value="60" selected>60 s</option><option value="120">2 min</option></select>
      <label class="sc-check"><input type="checkbox" id="rgSee" checked> Show what the AI sees</label>
      <span class="sc-sp"></span><button class="btn small primary" type="button" id="rgGo">Start</button>
    </div>
    <div class="ag-stage ag-range"><canvas id="rgScene" width="${W}" height="${H}"></canvas><canvas id="rgTop" width="${W}" height="${H}"></canvas><div class="ag-msg" id="agMsg">Press Start.</div></div>
    <div class="ag-stat" id="agStat"></div>`;
  $("#rgGo").onclick = () => (R && R.on ? rangeEnd("Stopped.") : rangeStart());
  $("#rgTop").addEventListener("pointerdown", (e) => {
    if (!R || !R.on || R.mode === "ai") return;
    const r = e.target.getBoundingClientRect(); shoot("you", (e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height);
  });
  scene($("#rgScene").getContext("2d"), [], 0); top([]);
}
function rangeStart() {
  stopAll();
  R = { on: true, mode: $("#rgMode").value, skill: $("#rgSkill").value, len: Number($("#rgLen").value) * 1000, t0: performance.now(), last: performance.now(),
    figs: [], nextSpawn: 0, crates: [[180, 1], [470, 2], [760, 1], [330, 0], [640, 0]],
    ai: { x: W / 2, y: H / 2, aim: null, seen: [], hits: 0, shots: 0, wrong: 0, times: [], cool: 0, looks: 0, lookMs: 0, since: 0 },
    you: { hits: 0, shots: 0, times: [] }, flashes: [], token: Math.random() };
  $("#rgGo").textContent = "Stop"; msg("Loading the AI (the first time takes a few seconds)…");
  model(A.acc).then((m) => { if (!R || !R.on) return; msg(""); R.t0 = performance.now(); R.last = R.t0; R.model = m; loop(); if (R.mode !== "you") aiLook(R.token); }, (e) => rangeEnd(e.message));
}
function rangeEnd(text) {
  if (!R) return; const was = R.on; R.on = false; cancelAnimationFrame(R.raf);
  const b = $("#rgGo"); if (b) b.textContent = "Start again";
  if (!was) return;
  const pct = (h, s) => (s ? Math.round(h / s * 100) + "%" : "–"), avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length / 1000).toFixed(2) + " s" : "–");
  const ai = R.ai, you = R.you, parts = [];
  if (R.mode !== "you") parts.push(`AI: ${ai.hits} hits, ${ai.shots} shots (${pct(ai.hits, ai.shots)} accurate), about ${avg(ai.times)} from seeing someone to hitting them, looked ${ai.looks ? (ai.looks / (R.len / 1000)).toFixed(0) : 0} times a second`);
  if (R.mode !== "ai") parts.push(`You: ${you.hits} hits, ${you.shots} shots (${pct(you.hits, you.shots)} accurate), about ${avg(you.times)} to hit`);
  if (R.mode === "duel") parts.push(you.hits > ai.hits ? "You win!" : you.hits < ai.hits ? "The AI wins." : "A draw.");
  msg(text && text !== "time" ? text : "Round over"); const st = $("#agStat"); if (st) st.textContent = parts.join(" · ");
}
// people: walking across a lane, or popping up behind a crate for a moment; one that's hit falls over
function spawn(now) {
  const pop = Math.random() < 0.4, lane = Math.floor(Math.random() * 3), L = LANES[lane];
  const f = { lane, s: L.s, y: L.y, born: now, shirt: pick(SHIRTS), pants: pick(PANTS), skin: pick(SKIN), hair: pick(HAIR), phase: Math.random() * 6, hit: 0, rise: 1, wide: 0.9 + Math.random() * 0.2 };
  const free = R.crates.filter((c) => c[1] === lane && !R.figs.some((g) => g.pop != null && !g.hit && g.x === c[0]));     // one person per crate
  if (pop && free.length) { const c = pick(free); f.x = c[0]; f.vx = 0; f.pop = now; f.rise = 0; f.stay = 1300 + Math.random() * 1200; }
  else { const left = Math.random() < 0.5; f.x = left ? -60 : W + 60; f.vx = (left ? 1 : -1) * (60 + Math.random() * 90) * L.s; }
  R.figs.push(f);
}
function loop() {
  if (!R || !R.on) return;
  const now = performance.now(), dt = Math.min(0.05, (now - R.last) / 1000); R.last = now;
  if (now - R.t0 > R.len) return rangeEnd("time");
  if (now > R.nextSpawn && R.figs.filter((f) => !f.hit).length < 4) { spawn(now); R.nextSpawn = now + 700 + Math.random() * 1100; }
  for (const f of R.figs) {
    f.phase += dt * 7 * (f.vx ? 1 : 0); f.x += f.vx * dt;
    if (f.pop != null && !f.hit) { const age = now - f.pop; f.rise = age < 250 ? age / 250 : age < 250 + f.stay ? 1 : Math.max(0, 1 - (age - 250 - f.stay) / 250); if (age > f.stay + 520) f.gone = true; }
    if (f.hit && now - f.hit > 700) f.gone = true;
    if (f.vx && (f.x < -80 || f.x > W + 80)) f.gone = true;
  }
  R.figs = R.figs.filter((f) => !f.gone);
  // the AI's crosshair moves toward what it aims at, at its speed
  if (R.mode !== "you") {
    const ai = R.ai, sp = { human: 900, fast: 2600, max: 20000 }[R.skill];
    if (ai.aim) {
      const dx = ai.aim.x - ai.x, dy = ai.aim.y - ai.y, d = Math.hypot(dx, dy), step = sp * dt;
      if (d <= step) { ai.x = ai.aim.x; ai.y = ai.aim.y; } else { ai.x += dx / d * step; ai.y += dy / d * step; }
      const wait = { human: 260, fast: 90, max: 0 }[R.skill];
      if (d < 6 && now > ai.cool && now - ai.since > wait) { ai.cool = now + { human: 450, fast: 220, max: 120 }[R.skill]; shoot("ai", ai.x, ai.y); ai.aim = null; }
    }
  }
  scene($("#rgScene").getContext("2d"), R.figs, now);
  top(R.figs);
  const st = $("#agStat");
  if (st) st.textContent = `${Math.ceil((R.len - (now - R.t0)) / 1000)} s left` + (R.mode !== "you" ? ` · AI ${R.ai.hits} hits / ${R.ai.shots} shots` : "") + (R.mode !== "ai" ? ` · You ${R.you.hits} hits / ${R.you.shots} shots` : "");
  R.raf = requestAnimationFrame(loop);
}
// the AI looks at the picture (only the scene canvas: no crosshairs, no boxes), again and again
async function aiLook(token) {
  while (R && R.on && R.token === token) {
    const t0 = performance.now();
    const preds = await R.model.detect($("#rgScene"), 20, 0.3).catch(() => []);
    if (!R || R.token !== token || !R.on) return;
    const ai = R.ai; ai.looks++; ai.lookMs = performance.now() - t0;
    ai.seen = preds.filter((p) => p.class === "person" && p.score >= 0.3);
    if (!ai.aim && ai.seen.length) {
      // the nearest one to the crosshair; aim at the chest
      const c = ai.seen.map((p) => ({ p, x: p.bbox[0] + p.bbox[2] / 2, y: p.bbox[1] + p.bbox[3] * 0.32 })).sort((a, b) => Math.hypot(a.x - ai.x, a.y - ai.y) - Math.hypot(b.x - ai.x, b.y - ai.y))[0];
      ai.aim = { x: c.x, y: c.y }; ai.since = performance.now();
    } else if (ai.aim && ai.seen.length) {
      // keep following the same one: its newest place
      const c = ai.seen.map((p) => ({ x: p.bbox[0] + p.bbox[2] / 2, y: p.bbox[1] + p.bbox[3] * 0.32 })).sort((a, b) => Math.hypot(a.x - ai.aim.x, a.y - ai.aim.y) - Math.hypot(b.x - ai.aim.x, b.y - ai.aim.y))[0];
      if (Math.hypot(c.x - ai.aim.x, c.y - ai.aim.y) < 120) { ai.aim.x = c.x; ai.aim.y = c.y; }
    } else if (!ai.seen.length) ai.aim = null;
    await new Promise((r) => setTimeout(r, 0));
  }
}
// a shot: does it land on someone (head or body)?
function shoot(who, x, y) {
  const now = performance.now(), me = R[who]; me.shots++;
  const f = [...R.figs].reverse().find((f) => !f.hit && inside(f, x, y));
  R.flashes.push({ x, y, t: now, who, hit: !!f });
  if (f) { f.hit = now; f.by = who; me.hits++; me.times.push(now - (f.pop != null ? f.pop + 120 : f.born)); }
}
function inside(f, x, y) {
  const h = 170 * f.s, top = f.y - h * f.rise, w = h * 0.24 * f.wide;
  if (f.pop != null && y > crateTop(f)) return false;                    // behind the crate
  return x > f.x - w && x < f.x + w && y > top && y < top + h;
}
const crateTop = (f) => f.y - 62 * f.s;

// ---------- drawing ----------
function scene(ctx, figs, now) {
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.45); sky.addColorStop(0, "#8EC5E8"); sky.addColorStop(1, "#D8ECF5");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#9BB58A"; ctx.beginPath(); ctx.moveTo(0, 230); for (let x = 0; x <= W; x += 40) ctx.lineTo(x, 215 + Math.sin(x / 90) * 18); ctx.lineTo(W, 260); ctx.lineTo(0, 260); ctx.fill();
  ctx.fillStyle = "#B9A27A"; ctx.fillRect(0, 248, W, 26);                       // the back wall
  for (let x = 0; x < W; x += 48) { ctx.fillStyle = x % 96 ? "#A8916A" : "#B09A72"; ctx.fillRect(x, 248, 46, 26); }
  const g = ctx.createLinearGradient(0, 274, 0, H); g.addColorStop(0, "#C8B48C"); g.addColorStop(1, "#A88E62"); ctx.fillStyle = g; ctx.fillRect(0, 274, W, H - 274);
  for (const L of LANES) { ctx.strokeStyle = "rgba(90,70,40,.25)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, L.y + 2); ctx.lineTo(W, L.y + 2); ctx.stroke(); }
  // far to near: people, then the crates of that lane in front of them
  for (let lane = 0; lane < 3; lane++) {
    for (const f of figs) if (f.lane === lane) person(ctx, f, now);
    for (const c of R ? R.crates : [[180, 1], [470, 2], [760, 1], [330, 0], [640, 0]]) if (c[1] === lane) crate(ctx, c[0], LANES[lane]);
  }
}
function crate(ctx, x, L) {
  const s = L.s, w = 100 * s, h = 62 * s, y = L.y - h;
  ctx.fillStyle = "#8B5E34"; ctx.fillRect(x - w / 2, y, w, h);
  ctx.strokeStyle = "#5C3A1E"; ctx.lineWidth = 4 * s; ctx.strokeRect(x - w / 2, y, w, h);
  ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.lineTo(x + w / 2, y + h); ctx.moveTo(x + w / 2, y); ctx.lineTo(x - w / 2, y + h); ctx.stroke();
}
// a person seen from the front-ish, walking: legs and arms swing, shaded clothes, a head with hair
function person(ctx, f, now) {
  const h = 170 * f.s, rise = f.rise;
  ctx.save();
  if (f.pop != null) { ctx.beginPath(); ctx.rect(0, 0, W, crateTop(f) + 1); ctx.clip(); }      // behind the crate: only what's above it
  const base = f.y + h * (1 - rise);
  ctx.translate(f.x, base);
  if (f.hit) { const k = Math.min(1, (now - f.hit) / 350); ctx.rotate((f.by === "ai" ? 1 : -1) * k * 1.4); ctx.globalAlpha = 1 - Math.max(0, (now - f.hit - 350) / 350); }
  const sw = Math.sin(f.phase) * 0.4, sh = h * 0.15 * f.wide, U = (v) => v * h;
  const limb = (x, y, len, ang, wid, col) => { ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(-wid / 2, 0, wid, len, wid / 2); ctx.fill(); ctx.restore(); };
  // legs and shoes
  for (const k of [-1, 1]) { limb(k * U(0.055), -U(0.49), U(0.47), k * sw * 0.6, U(0.095), f.pants); }
  for (const k of [-1, 1]) { ctx.save(); ctx.translate(k * U(0.05), -U(0.48)); ctx.rotate(k * sw * 0.6); ctx.fillStyle = "#1a1a1a"; ctx.beginPath(); ctx.ellipse(U(0.015) * k, U(0.465), U(0.05), U(0.022), 0, 0, 7); ctx.fill(); ctx.restore(); }
  // arms behind
  limb(-sh + U(0.02), -U(0.8), U(0.37), 0.14 - sw * 0.5, U(0.07), shade(f.shirt, -25));
  // torso
  const tg = ctx.createLinearGradient(-sh, 0, sh, 0); tg.addColorStop(0, shade(f.shirt, -30)); tg.addColorStop(0.5, f.shirt); tg.addColorStop(1, shade(f.shirt, -40));
  ctx.fillStyle = tg; ctx.beginPath(); ctx.roundRect(-sh, -U(0.82), sh * 2, U(0.36), U(0.05)); ctx.fill();
  ctx.fillStyle = f.pants; ctx.fillRect(-sh * 0.9, -U(0.5), sh * 1.8, U(0.05));
  // arm in front, hands
  limb(sh - U(0.02), -U(0.8), U(0.37), -0.14 + sw * 0.5, U(0.07), shade(f.shirt, -10));
  ctx.fillStyle = f.skin;
  for (const [x, a] of [[-sh + U(0.02), 0.14 - sw * 0.5], [sh - U(0.02), -0.14 + sw * 0.5]]) { ctx.save(); ctx.translate(x, -U(0.8)); ctx.rotate(a); ctx.beginPath(); ctx.arc(0, U(0.37), U(0.032), 0, 7); ctx.fill(); ctx.restore(); }
  // neck, head, hair, face
  ctx.fillRect(-U(0.025), -U(0.86), U(0.05), U(0.05));
  const hg = ctx.createRadialGradient(-U(0.02), -U(0.93), U(0.01), 0, -U(0.92), U(0.08)); hg.addColorStop(0, shade(f.skin, 15)); hg.addColorStop(1, shade(f.skin, -25));
  ctx.fillStyle = hg; ctx.beginPath(); ctx.ellipse(0, -U(0.92), U(0.058), U(0.072), 0, 0, 7); ctx.fill();
  ctx.fillStyle = f.hair; ctx.beginPath(); ctx.ellipse(0, -U(0.955), U(0.062), U(0.045), 0, Math.PI, 0); ctx.fill();
  ctx.fillStyle = "#222"; for (const k of [-1, 1]) { ctx.beginPath(); ctx.arc(k * U(0.022), -U(0.925), U(0.007), 0, 7); ctx.fill(); }
  ctx.strokeStyle = shade(f.skin, -50); ctx.lineWidth = U(0.006); ctx.beginPath(); ctx.arc(0, -U(0.9), U(0.018), 0.2, Math.PI - 0.2); ctx.stroke();
  ctx.restore();
}
function shade(hex, d) { const n = parseInt(hex.slice(1), 16), c = (v) => Math.max(0, Math.min(255, v + d)); return "#" + ((c(n >> 16) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, "0"); }
// what goes on top (never seen by the AI): its boxes, both crosshairs, the shots
function top(figs) {
  const cv = $("#rgTop"); if (!cv) return; const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, W, H);
  if (!R) return;
  const now = performance.now();
  if (R.mode !== "you") {
    if ($("#rgSee") && $("#rgSee").checked) boxes(ctx, R.ai.seen, W);
    const { x, y } = R.ai; ctx.strokeStyle = "#FF375F"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.moveTo(x - 22, y); ctx.lineTo(x - 6, y); ctx.moveTo(x + 6, y); ctx.lineTo(x + 22, y); ctx.moveTo(x, y - 22); ctx.lineTo(x, y - 6); ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 22); ctx.stroke();
    ctx.fillStyle = "#FF375F"; ctx.font = "600 12px system-ui"; ctx.fillText("AI", x + 16, y - 16);
  }
  R.flashes = R.flashes.filter((s) => now - s.t < 400);
  for (const s of R.flashes) { const k = (now - s.t) / 400; ctx.strokeStyle = s.hit ? `rgba(255,214,10,${1 - k})` : `rgba(255,255,255,${0.8 - k * 0.8})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(s.x, s.y, 6 + k * 18, 0, 7); ctx.stroke(); }
}

// ======================================================================
// Teach it: you show it a few pictures of each thing, then it recognises those things in new pictures, the camera or the screen.
// MobileNet turns each picture into a list of numbers that describes what's in it; a nearest-neighbour classifier compares a new
// picture's numbers with your examples' (the way Google's Teachable Machine works). All in this browser; the examples are kept on
// this device (small copies in its storage), never sent anywhere.
// ======================================================================
const MOBILENET = "https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js";
const KNN = "https://cdn.jsdelivr.net/npm/@tensorflow-models/knn-classifier@1.2.6/dist/knn-classifier.min.js";
const K = { things: null, net: null, knn: null, token: 0, stream: null, media: null, dirty: true };
const KEY = "burrow.teach";
function things() {
  if (!K.things) { try { K.things = JSON.parse(localStorage.getItem(KEY)) || null; } catch {} }
  if (!Array.isArray(K.things)) K.things = [{ name: "", pics: [] }, { name: "", pics: [] }];
  return K.things;
}
function keep() { try { localStorage.setItem(KEY, JSON.stringify(K.things)); } catch { toast("This device's storage is full: the newest examples are only kept until you reload"); } }
async function brain() {
  if (!K.net) { await loadOnce(TFJS); await loadOnce(MOBILENET); await loadOnce(KNN); K.net = await window.mobilenet.load({ version: 2, alpha: 1.0 }); }
  if (!K.knn) K.knn = window.knnClassifier.create();
  if (K.dirty) {                                   // the examples, learned again (after a reload, or when they changed)
    K.knn.clearAllClasses();
    for (const [i, t] of things().entries()) for (const src of t.pics) { const im = await pic(src); const e = K.net.infer(im, true); K.knn.addExample(e, i); e.dispose(); }
    K.dirty = false;
  }
}
const pic = (src) => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = src; });
// a square middle part of a picture or video, small (what MobileNet looks at, and what's kept)
function square(media, size = 160) {
  const w = media.videoWidth || media.naturalWidth || media.width, h = media.videoHeight || media.naturalHeight || media.height, m = Math.min(w, h);
  const c = document.createElement("canvas"); c.width = c.height = size;
  c.getContext("2d").drawImage(media, (w - m) / 2, (h - m) / 2, m, m, 0, 0, size, size);
  return c;
}
function teachPage() {
  const list = things();
  $("#agBody").innerHTML = `
    <p class="sc-tip">Teach it your own things: give each one a name and a few example pictures (at least 3; more and different ones work better, like the same thing from other sides or in other light). Then it says which one it sees in a new picture, the camera or the screen. It all stays on this device.</p>
    <div class="tk-things">${list.map((t, i) => `<div class="tk-thing" data-i="${i}">
      <div class="tk-top"><input class="hub-in" data-k="name" value="${esc(t.name)}" placeholder="Name, e.g. ${["My cat", "My dog", "Empty sofa", "Cup"][i % 4]}" maxlength="40"><span class="sc-sp"></span>
        <button class="btn small" type="button" data-a="add">Add pictures</button><button class="btn small" type="button" data-a="snap" title="Take the current picture from the camera or screen below">Take from below</button><button class="sc-x" type="button" data-a="del" aria-label="Remove">×</button></div>
      <div class="tk-pics">${t.pics.map((p, j) => `<img src="${p}" alt="" data-j="${j}" title="Click to remove">`).join("") || '<span class="sc-tip">No pictures yet</span>'}</div>
      <div class="tk-bar"><i style="width:0%"></i><b></b></div></div>`).join("")}</div>
    <div class="ag-bar"><button class="btn small" type="button" data-a="thing">+ Another thing</button><input type="file" id="tkFile" accept="image/*" multiple hidden></div>
    <h3 class="tk-h">Try it</h3>
    <div class="ag-bar">
      <button class="btn small" type="button" data-src="camera">Camera</button><button class="btn small" type="button" data-src="screen">Screen or window</button><button class="btn small" type="button" data-src="file">A picture</button><input type="file" id="tkTest" accept="image/*" hidden>
      <button class="btn small ghost" type="button" data-src="stop">Stop</button>
    </div>
    <div class="ag-stage ag-det"><video id="agVid" playsinline muted autoplay hidden></video><img id="agImg" alt="" hidden><div class="ag-msg" id="agMsg">Teach it at least two things, then try it with the camera, the screen or a picture.</div></div>
    <div class="ag-stat tk-guess" id="agStat"></div>`;
  const body = $("#agBody"); let target = 0;
  body.oninput = (e) => { const r = e.target.closest(".tk-thing"); if (r && e.target.dataset.k === "name") { list[r.dataset.i].name = e.target.value; keep(); } };
  body.onclick = async (e) => {
    const b = e.target.closest("button, .tk-pics img"); if (!b) return;
    const r = b.closest(".tk-thing"), i = r ? Number(r.dataset.i) : -1;
    if (b.tagName === "IMG") { list[i].pics.splice(Number(b.dataset.j), 1); K.dirty = true; keep(); return teachPage(); }
    if (b.dataset.src) return b.dataset.src === "file" ? $("#tkTest").click() : b.dataset.src === "stop" ? teachStop("Stopped.") : teachStart(b.dataset.src);
    const a = b.dataset.a;
    if (a === "thing") { list.push({ name: "", pics: [] }); keep(); return teachPage(); }
    if (a === "del") { if (list.length <= 2) { list[i] = { name: "", pics: [] }; } else list.splice(i, 1); K.dirty = true; keep(); return teachPage(); }
    if (a === "add") { target = i; return $("#tkFile").click(); }
    if (a === "snap") {
      const m = K.media; if (!m || (m.tagName === "VIDEO" && m.readyState < 2)) return toast("Start the camera or the screen below first");
      list[i].pics.push(square(m).toDataURL("image/jpeg", 0.8)); K.dirty = true; keep(); return teachPage();
    }
  };
  $("#tkFile").onchange = async (e) => {
    const files = [...e.target.files].slice(0, 30); e.target.value = "";
    for (const f of files) { const url = URL.createObjectURL(f); try { const im = await pic(url); list[target].pics.push(square(im).toDataURL("image/jpeg", 0.8)); } catch {} URL.revokeObjectURL(url); }
    K.dirty = true; keep(); teachPage();
  };
  $("#tkTest").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) teachStart("file", f); };
  if (K.media && K.token) teachStart(K.kind, K.file);         // a camera that was running goes on after the page is redrawn
}
function teachStop(text) {
  K.token = 0; if (K.stream) K.stream.getTracks().forEach((t) => t.stop()); K.stream = null; K.media = null;
  const v = $("#agVid"); if (v) { v.pause(); v.srcObject = null; v.removeAttribute("src"); v.hidden = true; }
  const im = $("#agImg"); if (im) im.hidden = true;
  if (text != null) msg(text);
}
async function teachStart(kind, file) {
  const list = things(), ready = list.filter((t) => t.pics.length >= 3);
  if (ready.length < 2) { msg("First give at least two things 3 or more pictures each."); return; }
  if (K.media && K.kind === kind && kind !== "file" && K.token) { loopGuess(K.token); return; }
  teachStop(null);
  const v = $("#agVid"), img = $("#agImg"), token = K.token = Math.random(); K.kind = kind; K.file = file;
  try {
    if (kind === "file") { img.src = URL.createObjectURL(file); await img.decode(); img.hidden = false; K.media = img; }
    else {
      if (!navigator.mediaDevices) throw new Error("This browser can't share the camera or screen here (it needs https).");
      if (kind === "screen" && !navigator.mediaDevices.getDisplayMedia) throw new Error("This device can't share its screen (phones and tablets usually can't).");
      K.stream = kind === "camera" ? await navigator.mediaDevices.getUserMedia({ video: true, audio: false }) : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      v.srcObject = K.stream; v.hidden = false; await v.play(); K.media = v;
    }
    msg("Loading the AI and learning your examples…");
    await brain(); if (K.token !== token) return; msg("");
    loopGuess(token);
  } catch (e) { teachStop(e.name === "NotAllowedError" ? "Not allowed: the browser (or you) said no." : e.message); }
}
async function loopGuess(token) {
  const list = things();
  do {
    const m = K.media; if (!m) return;
    if (m.tagName === "VIDEO" && m.readyState < 2) { await new Promise((r) => setTimeout(r, 60)); continue; }
    if (K.dirty) await brain();
    const e = K.net.infer(square(m, 224), true), r = await K.knn.predictClass(e, 5); e.dispose();
    if (K.token !== token) return;
    // every thing's bar, and the best guess in words
    document.querySelectorAll(".tk-thing").forEach((row) => { const i = Number(row.dataset.i), c = (r.confidences && r.confidences[i]) || 0; row.querySelector(".tk-bar i").style.width = Math.round(c * 100) + "%"; row.querySelector(".tk-bar b").textContent = list[i].pics.length >= 3 ? Math.round(c * 100) + "%" : ""; row.classList.toggle("best", String(r.label) === String(i)); });
    const best = list[Number(r.label)], conf = (r.confidences && r.confidences[r.label]) || 0;
    const st = $("#agStat"); if (st) st.textContent = best ? `Looks like: ${best.name || "thing " + (Number(r.label) + 1)} (${Math.round(conf * 100)}% sure)` : "";
    if (m.tagName !== "VIDEO") return;
    await new Promise((res) => setTimeout(res, 120));
  } while (K.token === token);
}

function stopAll() { detectStop(null); teachStop(null); if (R) { R.on = false; cancelAnimationFrame(R.raf); } }
window.aigamesOpen = (tab) => { A.open = true; if (tab) A.tab = tab; render(); };
window.aigamesClose = () => { if (!A.open) return; A.open = false; stopAll(); };
window.aigamesTest = { person: (ctx, f) => person(ctx, f, 0), scene: (ctx, figs) => scene(ctx, figs, 0), LANES, SHIRTS, PANTS, SKIN, HAIR, model };
})();
