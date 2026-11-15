"use strict";
// Voice: dictate into the message box (mic button), have a hands-free conversation (wave button), and answers read aloud with the PC's
// own voice. Listening is Whisper and speaking is Piper, both on the PC (host/voice.py); nothing goes to a cloud service.
// Uses the helpers of the main page script: $, toast, pcCall, send, current, newChat, setView, stripAsk, autosize.
(() => {
const MIC = '<svg class="i" viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4"/></svg>';
const WAVE = '<svg class="i" viewBox="0 0 24 24"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>';
let rec = null, talking = false, audio = null, spokenId = 0, warned = false;

// ---------- recording: stops by itself after a pause in the talking ----------
// resolves { b64 }, or null when nobody spoke within waitMs or it was cancelled
async function record({ waitMs = 9000, pauseMs = 1300, onLevel } = {}) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("This browser can't record sound");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const AC = window.AudioContext || window.webkitAudioContext, ctx = new AC(), an = ctx.createAnalyser(); an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const mr = new MediaRecorder(stream), chunks = [], data = new Float32Array(an.fftSize);
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const t0 = performance.now(); let spoke = 0, quietSince = t0, cancelled = false, timer = 0;
  const done = new Promise((resolve) => {
    mr.onstop = () => {
      clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); try { ctx.close(); } catch {}
      rec = null;
      if (cancelled || !spoke) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ b64: String(r.result).split(",")[1] });
      r.readAsDataURL(new Blob(chunks, { type: mr.mimeType || "audio/webm" }));
    };
  });
  rec = { stop: () => { if (mr.state !== "inactive") mr.stop(); }, cancel: () => { cancelled = true; if (rec) rec.stop(); } };
  mr.start();
  timer = setInterval(() => {
    an.getFloatTimeDomainData(data); let s = 0; for (const x of data) s += x * x;
    const rms = Math.sqrt(s / data.length), now = performance.now(); if (onLevel) onLevel(rms);
    if (rms > 0.02) { spoke = spoke || now; quietSince = now; }
    if ((spoke && now - quietSince > pauseMs) || (!spoke && now - t0 > waitMs) || now - t0 > 120000) { if (rec) rec.stop(); }
  }, 80);
  return done;
}
async function listen(b) {
  if (!warned) {
    try { const st = await pcCall("/agent/voice/status", {}); if (!st.stt) toast("First time: the PC downloads its speech models (about 2 GB). This can take a few minutes."); warned = true; }
    catch (e) { throw new Error("Couldn't reach the voice helper on your PC: " + e.message); }
  }
  return pcCall("/agent/voice/stt", { audio: b.b64 });
}

// ---------- speaking ----------
const WORDS = {
  de: /\b(und|der|die|das|ist|nicht|ich|ein|eine|mit|für|auf|zu|den|dem|sie|es|wir|auch|wie|was)\b/gi,
  en: /\b(the|and|is|are|you|that|with|for|this|of|to|in|it|not|have|what|how)\b/gi,
  fr: /\b(le|la|les|et|est|une|des|pour|pas|que|vous|dans|avec)\b/gi,
  es: /\b(el|los|las|y|es|una|para|por|que|con|no|del)\b/gi,
  it: /\b(il|gli|e|è|una|per|che|non|con|del|sono)\b/gi,
};
function guessLang(t) {
  const score = Object.entries(WORDS).map(([l, re]) => [l, (t.match(re) || []).length + (l === "de" ? (t.match(/[äöüß]/gi) || []).length * 2 : 0)]).sort((a, b) => b[1] - a[1])[0];
  return score[1] ? score[0] : "en";
}
// what is worth saying: no code, links, tables or markup
const plain = (t) => stripAsk(String(t || "")).replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/^\s*\|.*\|\s*$/gm, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_>~]+/g, " ").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
function chunksOf(t) {
  const out = [];
  for (const s of t.match(/[^.!?:\n]+[.!?:]*\s*/g) || [t]) { const last = out[out.length - 1]; if (last !== undefined && last.length + s.length < 260) out[out.length - 1] += s; else out.push(s); }
  return out.filter((x) => x.trim());
}
function stopSpeaking() { spokenId++; if (audio) { audio.pause(); audio = null; } try { speechSynthesis.cancel(); } catch {} }
// reads the text with the PC's voice (the next sentence is made while the current one plays); the browser's own voice if the PC can't.
// onPart(text) is told which piece is being read now (the subtitle in the conversation).
// While it plays, the sound also goes through an analyser, so the circle can move with the voice.
let actx = null, outAn = null, speakingNow = false;
function chainAudio(el) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    if (actx.state !== "running") return;                      // routed through a stopped context it would be silent: play it plainly
    if (!outAn) { outAn = actx.createAnalyser(); outAn.fftSize = 512; outAn.connect(actx.destination); }
    actx.createMediaElementSource(el).connect(outAn);
  } catch { outAn = null; }
}
const outBuf = new Float32Array(512);
function outLevel() {
  if (!speakingNow) return 0;
  if (!outAn) return 0.3 + 0.25 * Math.sin(performance.now() / 110) + Math.random() * 0.12;     // no analyser: a made-up wobble while it speaks
  outAn.getFloatTimeDomainData(outBuf); let s = 0; for (const x of outBuf) s += x * x;
  return Math.min(1, Math.sqrt(s / outBuf.length) * 5);
}
async function say(text, lang, onPart) {
  const id = ++spokenId, t = plain(text); if (!t) return;
  lang = lang || guessLang(t);
  const parts = chunksOf(t), get = (s) => pcCall("/agent/voice/tts", { text: s, lang });
  try {
    let next = get(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const r = await next; if (id !== spokenId) return;
      if (r.none) throw new Error("no voice for " + lang);
      if (i + 1 < parts.length) next = get(parts[i + 1]);
      if (onPart) onPart(parts[i].trim());
      await new Promise((ok) => { audio = new Audio("data:audio/wav;base64," + r.wav); chainAudio(audio); speakingNow = true; audio.onended = audio.onerror = ok; audio.play().catch(ok); });
      speakingNow = false;
    }
  } catch (e) {
    speakingNow = false;
    if (id !== spokenId || !("speechSynthesis" in window)) return;
    if (onPart) onPart(t);
    const u = new SpeechSynthesisUtterance(t); u.lang = lang;
    speakingNow = true;
    await new Promise((ok) => { u.onend = u.onerror = ok; speechSynthesis.speak(u); });
    speakingNow = false;
  }
}
window.voiceSpeak = (t) => { stopSpeaking(); say(t); };

// ---------- the mic button: speak, and it is typed into the message box ----------
const mic = document.createElement("button"); mic.type = "button"; mic.className = "attach-btn mic-btn"; mic.title = "Speak your message (it is typed for you)"; mic.setAttribute("aria-label", "Dictate"); mic.innerHTML = MIC;
const wave = document.createElement("button"); wave.type = "button"; wave.className = "attach-btn mic-btn"; wave.title = "Talk with the AI hands-free: it listens, answers and speaks"; wave.setAttribute("aria-label", "Talk hands-free"); wave.innerHTML = WAVE;
$("#attachBtn").before(mic, wave);
mic.onclick = async () => {
  if (rec) return rec.stop();
  mic.classList.add("rec");
  try {
    const b = await record({ waitMs: 10000, onLevel: (v) => mic.style.setProperty("--lv", Math.min(1, v * 12)) });
    mic.classList.remove("rec"); if (!b) return toast("I didn't hear anything");
    mic.classList.add("busy"); const r = await listen(b);
    const p = $("#prompt");
    if (r.text) { p.value += (p.value && !/\s$/.test(p.value) ? " " : "") + r.text; autosize(); } else toast("I didn't catch that");
    p.focus();
  } catch (e) { toast("Voice: " + e.message); }
  finally { mic.classList.remove("rec", "busy"); }
};

// ---------- the circle ----------
// A living orb drawn on a canvas: it breathes, ripples and glows with the mic while you talk, swirls while the AI thinks, turns amber
// while it looks something up, and moves with the AI's own voice while it speaks. levelNow() gives what it should react to.
const PAL = {
  loading:   [[170, 178, 205], [96, 106, 150]],
  listening: [[120, 218, 255], [10, 132, 255]],
  thinking:  [[206, 140, 255], [94, 92, 230]],
  looking:   [[255, 214, 120], [255, 120, 40]],
  speaking:  [[130, 255, 205], [30, 180, 140]],
};
function makeOrb(host, levelNow) {
  const S = 280, dpr = Math.min(2, window.devicePixelRatio || 1), cv = document.createElement("canvas");
  cv.className = "vo-canvas"; cv.width = cv.height = S * dpr; cv.style.width = cv.style.height = S + "px"; cv.setAttribute("aria-hidden", "true");
  host.appendChild(cv);
  const g = cv.getContext("2d"), reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let st = "loading", t = 0, lv = 0, raf = 0, last = performance.now(), ripple = 0;
  const col = PAL.loading.map((c) => c.slice()), rings = [];
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  function draw(dt) {
    t += dt * (reduce ? 0.35 : 1);
    const want = PAL[st] || PAL.loading;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) col[i][j] += (want[i][j] - col[i][j]) * Math.min(1, dt * 4);
    const target = Math.min(1, levelNow ? levelNow() : 0);
    lv += (target - lv) * Math.min(1, dt * (target > lv ? 18 : 7));            // quick up, slow down
    const base = st === "thinking" ? 0.2 : st === "looking" ? 0.26 : st === "loading" ? 0.14 : 0.05, e = Math.max(lv, base);
    const cx = S / 2, cy = S / 2, R = 62 * (1 + Math.sin(t * 1.5) * 0.025 + lv * 0.1);
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, S, S);
    // glow
    let gr = g.createRadialGradient(cx, cy, R * 0.4, cx, cy, Math.min(S / 2 - 2, R * (1.8 + e * 0.5)));
    gr.addColorStop(0, rgba(col[0], 0.34 + e * 0.35)); gr.addColorStop(1, rgba(col[1], 0));
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    // ripples: a new ring goes out whenever the sound is strong
    ripple -= dt; if (lv > 0.2 && ripple <= 0 && !reduce) { rings.push(0); ripple = 0.5; }
    for (let i = rings.length - 1; i >= 0; i--) {
      rings[i] += dt * 0.9; const k = rings[i]; if (k >= 1) { rings.splice(i, 1); continue; }
      g.beginPath(); g.arc(cx, cy, R * (1.1 + k * 0.95), 0, 6.2832); g.strokeStyle = rgba(col[0], 0.5 * (1 - k)); g.lineWidth = 2; g.stroke();
    }
    // bars around the orb (listening and speaking), or comets going round it (thinking, looking, loading)
    if (st === "listening" || st === "speaking") {
      const N = 60;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * 6.2832 + t * 0.15, wob = 0.5 + 0.5 * Math.sin(i * 0.9 + t * 6) * Math.sin(i * 0.31 - t * 2.3), len = 3 + e * 34 * wob;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 1.2, cy + Math.sin(a) * R * 1.2); g.lineTo(cx + Math.cos(a) * (R * 1.2 + len), cy + Math.sin(a) * (R * 1.2 + len));
        g.strokeStyle = rgba(col[0], 0.28 + 0.5 * wob * Math.min(1, e * 2)); g.lineWidth = 2.6; g.lineCap = "round"; g.stroke();
      }
    } else {
      for (let k = 0; k < 3; k++) {
        const a = t * (st === "looking" ? 2.4 : 1.5) + k * 2.0944, rr = R * 1.5;
        g.beginPath(); g.arc(cx, cy, rr, a - 0.9, a); g.strokeStyle = rgba(col[0], 0.55); g.lineWidth = 3; g.lineCap = "round"; g.stroke();
        g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 4.5, 0, 6.2832); g.fillStyle = rgba(col[0], 0.95); g.fill();
      }
    }
    // the body: a soft blob that ripples with the sound
    const amp = 0.035 + e * 0.2, N = 80;
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * 6.2832, r = R * (1 + amp * (Math.sin(3 * a + t * 1.4) * 0.5 + Math.sin(5 * a - t * 1.1) * 0.3 + Math.sin(2 * a + t * 0.8) * 0.2 + Math.sin(7 * a + t * 3) * lv * 0.35));
      i ? g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath();
    gr = g.createRadialGradient(cx - R * 0.3, cy - R * 0.38, R * 0.1, cx, cy, R * 1.15);
    gr.addColorStop(0, rgba(col[0].map((v) => Math.min(255, v + 40)), 1)); gr.addColorStop(0.55, rgba(col[0], 0.95)); gr.addColorStop(1, rgba(col[1], 1));
    g.save(); g.fillStyle = gr; g.shadowColor = rgba(col[1], 0.6); g.shadowBlur = 24 + e * 40; g.fill(); g.restore();
    // glass swirls inside
    g.save(); g.clip(); g.globalCompositeOperation = "lighter";
    const sp = st === "thinking" || st === "looking" ? 1.9 : st === "speaking" ? 1.2 : 0.7;
    for (let k = 0; k < 3; k++) {
      const a = t * sp * (0.8 + k * 0.35) + k * 2.1, ox = Math.cos(a) * R * 0.42, oy = Math.sin(a * 1.2 + k) * R * 0.38;
      const sg = g.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, R * 0.75);
      sg.addColorStop(0, rgba(col[0], 0.34)); sg.addColorStop(1, rgba(col[0], 0)); g.fillStyle = sg; g.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
    }
    g.restore();
    // a highlight and a thin rim: the glass
    g.beginPath(); g.ellipse(cx - R * 0.28, cy - R * 0.42, R * 0.34, R * 0.17, -0.5, 0, 6.2832); g.fillStyle = "rgba(255,255,255,.28)"; g.fill();
    g.beginPath(); g.arc(cx, cy, R * 1.0, 0, 6.2832); g.strokeStyle = "rgba(255,255,255,.22)"; g.lineWidth = 1.5; g.stroke();
  }
  function loop(now) { const dt = Math.min(0.05, (now - last) / 1000); last = now; draw(dt); raf = requestAnimationFrame(loop); }
  raf = requestAnimationFrame(loop);
  return { setState: (s) => { st = s; }, draw, destroy: () => { cancelAnimationFrame(raf); cv.remove(); } };
}

// ---------- what it says while it works, and where it got things from ----------
// So the conversation is never silent: a short remark while it thinks, another when the thinking takes long, one when it goes to look
// something up and one naming the sites it found, and then the answer itself, read out sentence by sentence as it is written, starting
// with "According to ..." when it used the web.
const DOT = { en: " dot ", de: " Punkt ", fr: " point ", es: " punto ", it: " punto " };
const speakHost = (h, lang) => String(h || "").replace(/\./g, DOT[lang] || DOT.en);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const and = { en: " and ", de: " und ", fr: " et ", es: " y ", it: " e " };
const PH = {
  en: { first: ["Hmm, let me think about that.", "Good question, give me a second.", "Okay, let me work that out."], long: ["Okay, that needs me to think a bit longer.", "Still working on it, one more moment."], search: ["Let me look that up.", "I'll check the web for that."],
    found: (hs, l) => hs.length ? `Okay, I found something on ${hs.map((h) => speakHost(h, l)).join(and[l])}. Let me read it.` : "Okay, I found some results. Let me read them.", tool: "I'm using a tool for that, one moment.", according: (hs, l) => `According to ${hs.map((h) => speakHost(h, l)).join(and[l])}, ` },
  de: { first: ["Hmm, lass mich kurz überlegen.", "Gute Frage, einen Moment.", "Okay, ich rechne das kurz durch."], long: ["Okay, dafür muss ich etwas länger nachdenken.", "Ich bin noch dran, einen Moment."], search: ["Ich schaue kurz im Internet nach.", "Das suche ich schnell heraus."],
    found: (hs, l) => hs.length ? `Okay, ich habe etwas auf ${hs.map((h) => speakHost(h, l)).join(and[l])} gefunden. Ich lese es kurz.` : "Okay, ich habe Ergebnisse gefunden. Ich lese sie kurz.", tool: "Dafür benutze ich ein Werkzeug, einen Moment.", according: (hs, l) => `Laut ${hs.map((h) => speakHost(h, l)).join(and[l])}: ` },
  fr: { first: ["Hmm, laissez-moi réfléchir.", "Bonne question, un instant."], long: ["D'accord, il me faut un peu plus de temps pour réfléchir.", "J'y travaille encore, un instant."], search: ["Je vais chercher ça.", "Je regarde sur le web."],
    found: (hs, l) => hs.length ? `D'accord, j'ai trouvé quelque chose sur ${hs.map((h) => speakHost(h, l)).join(and[l])}. Je le lis.` : "D'accord, j'ai trouvé des résultats. Je les lis.", tool: "J'utilise un outil pour ça, un instant.", according: (hs, l) => `Selon ${hs.map((h) => speakHost(h, l)).join(and[l])}, ` },
  es: { first: ["Mmm, déjame pensarlo.", "Buena pregunta, un momento."], long: ["Vale, necesito pensarlo un poco más.", "Sigo con ello, un momento más."], search: ["Voy a buscarlo.", "Lo miro en internet."],
    found: (hs, l) => hs.length ? `Vale, encontré algo en ${hs.map((h) => speakHost(h, l)).join(and[l])}. Lo leo.` : "Vale, encontré resultados. Los leo.", tool: "Uso una herramienta para eso, un momento.", according: (hs, l) => `Según ${hs.map((h) => speakHost(h, l)).join(and[l])}, ` },
  it: { first: ["Mmm, fammi pensare.", "Bella domanda, un attimo."], long: ["Ok, devo pensarci un po' di più.", "Ci sto ancora lavorando, un attimo."], search: ["Lo cerco subito.", "Controllo sul web."],
    found: (hs, l) => hs.length ? `Ok, ho trovato qualcosa su ${hs.map((h) => speakHost(h, l)).join(and[l])}. Lo leggo.` : "Ok, ho trovato dei risultati. Li leggo.", tool: "Uso uno strumento per questo, un attimo.", according: (hs, l) => `Secondo ${hs.map((h) => speakHost(h, l)).join(and[l])}, ` },
};
// the sites it looked at (pages it read first, then the top search results), at most two
function sourcesOf(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === "fetch" && b.url && !b.error) out.push(hostOf(b.url));
    if (b.type === "search" && !b.error) for (const r of (b.results || []).slice(0, 3)) out.push(hostOf(r.url));
  }
  return [...new Set(out.filter(Boolean))].slice(0, 2);
}
// the next piece of the answer to read: whole sentences, once there are enough of them (or all that is left when it is final)
function nextPiece(p, spoken, final) {
  const rest = p.slice(spoken); if (!rest.trim()) return { piece: "", cut: rest.length };
  let cut = 0, m; const re = /[.!?:]["')\]]*\s+/g;
  while ((m = re.exec(rest))) cut = m.index + m[0].length;
  if (final) cut = rest.length;
  return cut && (cut >= 60 || final) ? { piece: rest.slice(0, cut).trim(), cut } : { piece: "", cut: 0 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

// Watches the answer being written (window.liveReply) while the AI works, and talks: fillers first, then the answer as it comes.
// finish(m) speaks whatever is left of the final answer and resolves when everything has been said.
function startTalk(lang) {
  const P = PH[lang] || PH.en, L = PH[lang] ? lang : "en", t0 = performance.now(), said = new Set();
  let chain = Promise.resolve(), live = true, answerStarted = false, spoken = 0, prefixed = false, fillers = 0;
  const speak = (text, onlyIfNoAnswer) => { chain = chain.then(() => (talking && (!onlyIfNoAnswer || !answerStarted) ? sayShow(text, lang) : null)).catch(() => {}); };
  const filler = (key, text) => { if (said.has(key) || answerStarted || fillers >= 4) return; said.add(key); fillers++; speak(text, true); };
  const reading = (blocks) => {            // what the AI is doing right now, for the screen
    const s = blocks.find((b) => b.type === "search" && b.active), f = blocks.find((b) => b.type === "fetch" && b.active);
    if (f) return state("looking", null, "Reading " + (hostOf(f.url) || "a page") + "…");
    if (s) return state("looking", null, "Searching the web…");
    if (ov && ov.dataset.s === "looking") state("thinking");             // done looking: back to thinking
  };
  function feed(r, final) {
    const blocks = r.blocks || [], p = plain(r.content || "");
    if (p && !answerStarted) { answerStarted = true; state("speaking"); }
    if (!answerStarted) {
      const search = blocks.find((b) => b.type === "search"), el = (performance.now() - t0) / 1000;
      const thinking = blocks.some((b) => b.type === "thinking" && !b.done) || r.phase === "thinking";
      if (search && search.active) { reading(blocks); filler("search", pickOne(P.search)); }
      else if (search && (search.results || []).length) { reading(blocks); filler("found", P.found(sourcesOf(blocks), L)); }
      else reading(blocks);
      if (blocks.some((b) => b.type === "agent" && b.active)) filler("tool", P.tool);
      if (thinking && el > 7) filler("long1", P.long[0]);
      if (el > 18) filler("long2", P.long[1]);
      if (el > 1.8 && !said.size && !search) filler("first", pickOne(P.first));
    }
    if (answerStarted && p.length >= spoken) {
      const { piece, cut } = nextPiece(p, spoken, final);
      if (piece) {
        spoken += cut;
        let text = piece;
        if (!prefixed) { prefixed = true; const hs = sourcesOf(blocks); if (hs.length) text = P.according(hs, L) + text; }
        speak(text, false);
      }
    }
  }
  const tick = setInterval(() => { const r = window.liveReply; if (r && talking && live) feed(r, false); }, 350);
  return {
    async finish(m) {
      live = false; clearInterval(tick);
      if (m && m.role === "assistant" && m.content && talking) { answerStarted = true; feed(m, true); }
      await chain;
    },
  };
}

// ---------- hands-free conversation: listen, answer, speak, listen again ----------
let ov = null, orb = null, micLv = 0;
function overlay() {
  ov = document.createElement("div"); ov.className = "voice-ov";
  ov.innerHTML = '<div class="vo-orb"></div><div class="vo-state"></div><div class="vo-say"></div><div class="vo-heard"></div><button class="btn" type="button">End conversation</button>';
  ov.querySelector("button").onclick = () => { talking = false; endTurn(); };
  document.body.appendChild(ov);
  orb = makeOrb(ov.querySelector(".vo-orb"), () => (ov && ov.dataset.s === "listening" ? micLv : outLevel()));
}
const STATES = { listening: "Listening…", thinking: "Thinking…", looking: "Looking it up…", speaking: "Speaking…", loading: "Getting the voice ready…" };
function state(s, heard, label) {
  if (!ov) return; ov.dataset.s = s; if (orb) orb.setState(s);
  ov.querySelector(".vo-state").textContent = label || STATES[s] || "";
  if (heard != null) ov.querySelector(".vo-heard").textContent = heard;
  if (s === "listening") { ov.querySelector(".vo-say").textContent = ""; }
}
// says something and shows it as the subtitle; the circle moves with the voice
async function sayShow(text, lang) {
  if (!talking) return;
  await say(text, lang, (part) => { if (ov) ov.querySelector(".vo-say").textContent = part; });
}
function endTurn() { if (rec) rec.cancel(); stopSpeaking(); if (typeof controller !== "undefined" && controller) controller.abort(); }
async function converse() {
  if (talking) { talking = false; return endTurn(); }
  if (document.body.classList.contains("home-view") || document.body.classList.contains("agent-view") || !current) { newChat("chat", "", false); setView("chat"); }
  talking = true; overlay(); state("loading");
  let quiet = 0;
  try {
    while (talking) {
      state("listening"); micLv = 0;
      const b = await record({ waitMs: 12000, onLevel: (v) => { micLv = Math.min(1, v * 12); } });
      micLv = 0;
      if (!talking) break;
      if (!b) { if (++quiet >= 3) { toast("Nobody spoke, so the conversation ended"); break; } continue; }
      quiet = 0; state("thinking");
      const r = await listen(b); if (!talking) break;
      if (!r.text) continue;
      state("thinking", "“" + r.text + "”");
      const lang = r.lang || guessLang(r.text), talk = startTalk(lang);
      $("#prompt").value = r.text; await send();
      const m = current.messages.at(-1); if (!talking) { await talk.finish(null); break; }
      state("speaking");
      await talk.finish(m);
    }
  } catch (e) { toast("Voice: " + e.message); }
  talking = false; endTurn(); if (orb) orb.destroy(); orb = null; if (ov) ov.remove(); ov = null;
}
wave.onclick = converse;
addEventListener("keydown", (e) => { if (e.key === "Escape" && talking) { talking = false; endTurn(); } });
window.voiceTest = { plain, chunksOf, guessLang, nextPiece, sourcesOf, PH, speakHost, makeOrb, startTalk, setTalking: (on) => { talking = on; } };
})();
