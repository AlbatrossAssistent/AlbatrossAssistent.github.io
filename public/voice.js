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
// reads the text with the PC's voice (the next sentence is made while the current one plays); the browser's own voice if the PC can't
async function say(text, lang) {
  const id = ++spokenId, t = plain(text); if (!t) return;
  lang = lang || guessLang(t);
  const parts = chunksOf(t), get = (s) => pcCall("/agent/voice/tts", { text: s, lang });
  try {
    let next = get(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const r = await next; if (id !== spokenId) return;
      if (r.none) throw new Error("no voice for " + lang);
      if (i + 1 < parts.length) next = get(parts[i + 1]);
      await new Promise((ok) => { audio = new Audio("data:audio/wav;base64," + r.wav); audio.onended = audio.onerror = ok; audio.play().catch(ok); });
    }
  } catch (e) {
    if (id !== spokenId || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = lang;
    await new Promise((ok) => { u.onend = u.onerror = ok; speechSynthesis.speak(u); });
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

// ---------- hands-free conversation: listen, answer, speak, listen again ----------
let ov = null;
function overlay() {
  ov = document.createElement("div"); ov.className = "voice-ov";
  ov.innerHTML = '<div class="vo-orb"></div><div class="vo-state"></div><div class="vo-heard"></div><button class="btn" type="button">End conversation</button>';
  ov.querySelector("button").onclick = () => { talking = false; endTurn(); };
  document.body.appendChild(ov);
}
const STATES = { listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…", loading: "Getting the voice ready…" };
function state(s, heard) { if (!ov) return; ov.dataset.s = s; ov.querySelector(".vo-state").textContent = STATES[s] || ""; if (heard != null) ov.querySelector(".vo-heard").textContent = heard; }
function endTurn() { if (rec) rec.cancel(); stopSpeaking(); if (typeof controller !== "undefined" && controller) controller.abort(); }
async function converse() {
  if (talking) { talking = false; return endTurn(); }
  if (document.body.classList.contains("home-view") || document.body.classList.contains("agent-view") || !current) { newChat("chat", "", false); setView("chat"); }
  talking = true; overlay(); state("loading");
  let quiet = 0;
  try {
    while (talking) {
      state("listening");
      const b = await record({ waitMs: 12000, onLevel: (v) => { if (ov) ov.style.setProperty("--lv", Math.min(1, v * 12)); } });
      if (!talking) break;
      if (!b) { if (++quiet >= 3) { toast("Nobody spoke, so the conversation ended"); break; } continue; }
      quiet = 0; state("thinking");
      const r = await listen(b); if (!talking) break;
      if (!r.text) continue;
      state("thinking", "“" + r.text + "”");
      $("#prompt").value = r.text; await send();
      const m = current.messages.at(-1); if (!talking) break;
      if (m && m.role === "assistant" && m.content) { state("speaking"); await say(m.content, r.lang); }
    }
  } catch (e) { toast("Voice: " + e.message); }
  talking = false; endTurn(); if (ov) ov.remove(); ov = null;
}
wave.onclick = converse;
addEventListener("keydown", (e) => { if (e.key === "Escape" && talking) { talking = false; endTurn(); } });
window.voiceTest = { plain, chunksOf, guessLang };
})();
