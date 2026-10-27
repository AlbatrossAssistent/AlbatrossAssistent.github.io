"use strict";
// The Music tool: the AI composes a short piece (instruments, chords, melody, a drum pattern) in a compact note notation; it plays
// in the chat on a small synthesizer made of Web Audio, and downloads as a MIDI file (GarageBand, Logic, any music program open
// it, one track per instrument) or as a WAV recording. Uses the main page's helpers: $, esc, toast, download, toolAnswer.
(() => {
// ---------- instruments: a General MIDI program for the file, and a little synth voice for playing it here ----------
const INSTR = {
  piano: { gm: 0, name: "Piano" }, epiano: { gm: 4, name: "Electric piano" }, organ: { gm: 16, name: "Organ" }, guitar: { gm: 25, name: "Guitar" },
  bass: { gm: 33, name: "Bass" }, synthbass: { gm: 38, name: "Synth bass" }, strings: { gm: 48, name: "Strings" }, choir: { gm: 52, name: "Choir" },
  brass: { gm: 61, name: "Brass" }, flute: { gm: 73, name: "Flute" }, lead: { gm: 80, name: "Synth lead" }, pad: { gm: 88, name: "Synth pad" },
  pluck: { gm: 46, name: "Harp pluck" }, bells: { gm: 9, name: "Bells" },
};
// real recordings (FluidR3 General MIDI sound font, one file per instrument, fetched once and cached by the browser); the synth below is the fallback
const SF = "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/";
const SF_NAME = { piano: "acoustic_grand_piano", epiano: "electric_piano_1", organ: "drawbar_organ", guitar: "acoustic_guitar_steel", bass: "electric_bass_finger", synthbass: "synth_bass_1", strings: "string_ensemble_1", choir: "choir_aahs", brass: "brass_section", flute: "flute", lead: "lead_1_square", pad: "pad_2_warm", pluck: "orchestral_harp", bells: "glockenspiel" };
const NN = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"], noteName = (m) => NN[m % 12] + (Math.floor(m / 12) - 1);
const sfText = {}, sfBuf = {};
async function sample(ctx, inst, midi) {
  try {
    sfText[inst] = sfText[inst] || fetch(SF + SF_NAME[inst] + "-mp3.js").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
    const key = inst + noteName(midi);
    sfBuf[key] = sfBuf[key] || (async () => {
      const m = new RegExp('"' + noteName(midi) + '"\\s*:\\s*"data:audio/mp3;base64,([^"]+)"').exec(await sfText[inst]); if (!m) return null;
      const bin = atob(m[1]), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return ctx.decodeAudioData(u.buffer);
    })();
    return await sfBuf[key];
  } catch { delete sfText[inst]; return null; }
}
// every note the song uses, decoded before it plays: { instrument: midi => AudioBuffer }
async function preload(ctx, song) {
  const out = {};
  await Promise.all(song.tracks.filter((t) => !t.hits && SF_NAME[t.inst]).map(async (t) => {
    const used = [...new Set(t.notes.map((n) => n.p))], got = new Map();
    await Promise.all(used.map(async (p) => { const b = await sample(ctx, t.inst, p); if (b) got.set(p, b); }));
    if (got.size === used.length) out[t.inst] = (p) => got.get(p);
  }));
  return out;
}
const DRUMS = { kick: 36, snare: 38, clap: 39, hat: 42, openhat: 46 };
const COLORS = ["#0A84FF", "#FF9F0A", "#30D158", "#BF5AF2", "#FF375F", "#64D2FF", "#FFD60A", "#AC8E68"];

// "C4/1 E4/0.5 R/0.5 [C4 E4 G4]/2" -> notes in beats (a quarter note is 1 beat); R is a rest, [ ] a chord
// repeats: "(C4/0.25 E4/0.25)x4" plays the group four times (also nested), so fast parts stay short to write
function expandRepeats(s) {
  s = String(s || "");
  const GROUP = /\(([^()]*)\)\s*[x×*]\s*(\d+)/gi;
  for (let i = 0; i < 6 && /\([^()]*\)\s*[x×*]\s*\d+/i.test(s); i++) s = s.replace(GROUP, (m, g, n) => Array(Math.min(64, Number(n) || 1)).fill(g.trim()).join(" "));
  return s.replace(/[()]/g, " ");
}
function parseNotes(s) {
  const out = []; let t = 0;
  for (const tok of expandRepeats(s).match(/\[[^\]]*\]\s*\/\s*[\d.]+|\S+/g) || []) {
    const m = /^(\[[^\]]*\]|[^/]+)\s*\/\s*([\d.]+)$/.exec(tok.trim()); if (!m) continue;
    const d = Math.max(.0625, Math.min(16, Number(m[2]) || 1));
    const pitches = m[1].replace(/[[\]]/g, "").split(/\s+/).filter(Boolean);
    for (const p of pitches) { const midi = toMidi(p); if (midi != null) out.push({ t, d, p: midi }); }
    t += d;
  }
  return { notes: out, beats: t };
}
function toMidi(p) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(p); if (!m) return null;
  const n = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  const v = 12 * (Number(m[3]) + 1) + n; return v >= 0 && v <= 127 ? v : null;
}
// the piece, ready to play: every note with its start and length in beats, per track; drums as hits
function buildSong(r) {
  const bpm = Math.max(50, Math.min(240, Math.round(Number(r.bpm) || 100)));
  const bars = Math.max(2, Math.min(64, Math.round(Number(r.bars) || 16))), beats = bars * 4;
  const tracks = [];
  for (const [i, tr] of (Array.isArray(r.tracks) ? r.tracks : []).slice(0, 7).entries()) {
    const inst = INSTR[tr.instrument] ? tr.instrument : "piano", { notes, beats: len } = parseNotes(tr.notes);
    if (!notes.length) continue;
    let all = notes;
    if (tr.loop && len > 0 && len < beats) { all = []; for (let o = 0; o < beats; o += len) for (const n of notes) if (o + n.t < beats) all.push({ ...n, t: o + n.t, d: Math.min(n.d, beats - o - n.t) }); }
    tracks.push({ name: String(tr.name || INSTR[inst].name).slice(0, 40), inst, notes: all.filter((n) => n.t < beats), color: COLORS[i % COLORS.length], mute: false });
  }
  const hits = [];
  if (r.drums && typeof r.drums === "object") for (const [k, pat] of Object.entries(r.drums)) {
    if (!DRUMS[k]) continue; const steps = String(pat || "").replace(/[^xX.\-o]/g, "");
    if (!steps.replace(/[.\-]/g, "")) continue;
    for (let s = 0; s * .25 < beats; s++) { const c = steps[s % steps.length]; if (c === "x" || c === "X" || c === "o") hits.push({ t: s * .25, k, v: c === "X" ? 1 : .75 }); }
  }
  if (hits.length) tracks.push({ name: "Drums", inst: "drums", hits, color: "#8E8E93", mute: false });
  if (!tracks.length) throw new Error("the model didn't write any notes. Try asking again, maybe with a style or mood.");
  return { title: String(r.title || "Untitled").slice(0, 80), about: String(r.description || "").slice(0, 400), key: String(r.key || "").slice(0, 20), bpm, beats, tracks };
}

// ---------- the synthesizer ----------
function voice(ctx, out, inst, time, midi, dur, vel, smp) {
  const buf = smp && smp[inst] && smp[inst](midi);
  if (buf) {
    const src = ctx.createBufferSource(), g = ctx.createGain(), end = time + dur, rel = inst === "piano" || inst === "pluck" || inst === "bells" || inst === "epiano" ? .5 : .25;
    src.buffer = buf; src.connect(g); g.connect(out);
    g.gain.setValueAtTime(.85 * vel, time); g.gain.setValueAtTime(.85 * vel, Math.max(time, end)); g.gain.linearRampToValueAtTime(0, end + rel);
    src.start(time); src.stop(end + rel + .02); return;
  }
  const f = 440 * Math.pow(2, (midi - 69) / 12), g = ctx.createGain(), end = time + dur;
  g.connect(out);
  const osc = (type, freq, det) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; if (det) o.detune.value = det; return o; };
  const env = (a, peak, decayTo, release) => { g.gain.setValueAtTime(0, time); g.gain.linearRampToValueAtTime(peak * vel, time + a); g.gain.exponentialRampToValueAtTime(Math.max(.0001, decayTo * vel), Math.max(time + a + .01, end)); g.gain.exponentialRampToValueAtTime(.0001, end + release); };
  const start = (nodes, release) => { for (const n of nodes) { n.start(time); n.stop(end + release + .05); } };
  const lp = (freq, q) => { const b = ctx.createBiquadFilter(); b.type = "lowpass"; b.frequency.value = freq; b.Q.value = q || .7; b.connect(g); return b; };
  switch (inst) {
    case "bass": case "synthbass": { const o = osc(inst === "bass" ? "triangle" : "sawtooth", f), b = lp(inst === "bass" ? 900 : 600, 4); o.connect(b); env(.01, .5, .3, .08); start([o], .08); break; }
    case "strings": case "pad": case "choir": { const a = osc("sawtooth", f, -7), b2 = osc("sawtooth", f, 7), b = lp(inst === "choir" ? 1600 : 2200); a.connect(b); b2.connect(b); env(inst === "pad" ? .35 : .18, .16, .13, .5); start([a, b2], .5); break; }
    case "lead": { const o = osc("square", f), b = lp(3200, 2); o.connect(b); env(.01, .17, .12, .1); start([o], .1); break; }
    case "organ": { const a = osc("sine", f), b2 = osc("sine", f * 2), c = osc("sine", f * 3); [a, b2, c].forEach((o) => o.connect(g)); env(.01, .14, .13, .05); start([a, b2, c], .05); break; }
    case "flute": { const o = osc("sine", f), v = osc("sine", 5.5), vg = ctx.createGain(); vg.gain.value = 3; v.connect(vg); vg.connect(o.frequency); o.connect(g); env(.06, .28, .22, .12); start([o, v], .12); break; }
    case "brass": { const o = osc("sawtooth", f), b = lp(1400, 1.5); o.connect(b); env(.05, .2, .15, .1); start([o], .1); break; }
    case "bells": { const c = osc("sine", f), m = osc("sine", f * 3.5), mg = ctx.createGain(); mg.gain.value = f * 2; m.connect(mg); mg.connect(c.frequency); c.connect(g); g.gain.setValueAtTime(.3 * vel, time); g.gain.exponentialRampToValueAtTime(.0001, time + Math.max(1.2, dur)); c.start(time); m.start(time); c.stop(time + Math.max(1.2, dur) + .05); m.stop(time + Math.max(1.2, dur) + .05); break; }
    case "pluck": case "guitar": { const o = osc(inst === "guitar" ? "sawtooth" : "triangle", f), b = lp(inst === "guitar" ? 2400 : 3000, 1); o.connect(b); g.gain.setValueAtTime(.32 * vel, time); g.gain.exponentialRampToValueAtTime(.0001, time + Math.min(1.6, dur + .6)); o.start(time); o.stop(time + Math.min(1.6, dur + .6) + .05); break; }
    case "epiano": { const c = osc("sine", f), m = osc("sine", f), mg = ctx.createGain(); mg.gain.setValueAtTime(f * 1.2, time); mg.gain.exponentialRampToValueAtTime(1, time + .6); m.connect(mg); mg.connect(c.frequency); c.connect(g); env(.005, .3, .1, .25); start([c, m], .25); break; }
    default: { const a = osc("triangle", f), b2 = osc("sine", f * 2), h = ctx.createGain(); h.gain.value = .25; b2.connect(h); h.connect(g); a.connect(g); g.gain.setValueAtTime(0, time); g.gain.linearRampToValueAtTime(.32 * vel, time + .005); g.gain.exponentialRampToValueAtTime(.0001, time + Math.min(2.5, dur + 1)); a.start(time); b2.start(time); a.stop(time + Math.min(2.5, dur + 1) + .05); b2.stop(time + Math.min(2.5, dur + 1) + .05); }
  }
}
let noiseBuf = null;
function drum(ctx, out, k, time, vel) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const g = ctx.createGain(); g.connect(out);
  if (k === "kick") { const o = ctx.createOscillator(); o.frequency.setValueAtTime(140, time); o.frequency.exponentialRampToValueAtTime(42, time + .25); g.gain.setValueAtTime(.9 * vel, time); g.gain.exponentialRampToValueAtTime(.001, time + .35); o.connect(g); o.start(time); o.stop(time + .4); return; }
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; const f = ctx.createBiquadFilter();
  f.type = k === "snare" || k === "clap" ? "bandpass" : "highpass"; f.frequency.value = k === "snare" ? 1800 : k === "clap" ? 1200 : 7500; n.connect(f); f.connect(g);
  const len = k === "openhat" ? .32 : k === "hat" ? .05 : k === "clap" ? .14 : .18;
  g.gain.setValueAtTime((k === "hat" ? .22 : k === "openhat" ? .18 : .5) * vel, time); g.gain.exponentialRampToValueAtTime(.001, time + len);
  n.start(time); n.stop(time + len + .02);
  if (k === "snare") { const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = 190; og.gain.setValueAtTime(.3 * vel, time); og.gain.exponentialRampToValueAtTime(.001, time + .1); o.connect(og); og.connect(out); o.start(time); o.stop(time + .12); }
}
// everything of the song on one audio context (a live one, or an offline one for the WAV)
function schedule(ctx, song, t0, smp) {
  const master = ctx.createGain(); master.gain.value = .55;
  const comp = ctx.createDynamicsCompressor(); master.connect(comp); comp.connect(ctx.destination);
  const spb = 60 / song.bpm;
  for (const tr of song.tracks) {
    if (tr.mute) continue;
    if (tr.hits) for (const h of tr.hits) drum(ctx, master, h.k, t0 + h.t * spb, h.v);
    else for (const n of tr.notes) voice(ctx, master, tr.inst, t0 + n.t * spb, n.p, Math.max(.05, n.d * spb * .95), .9, smp);
  }
  return song.beats * spb;
}

// ---------- MIDI file: type 1, one track per instrument, drums on channel 10 ----------
function midiFile(song) {
  const TPQ = 480, bytes = [];
  const vlq = (n) => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
  const str = (s) => [...new TextEncoder().encode(s)];
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], u16 = (n) => [(n >> 8) & 255, n & 255];
  const chunk = (id, data) => [...str(id), ...u32(data.length), ...data];
  const track = (events) => { events.sort((a, b) => a.tick - b.tick || a.order - b.order); let last = 0; const d = []; for (const e of events) { d.push(...vlq(e.tick - last), ...e.data); last = e.tick; } d.push(0, 0xff, 0x2f, 0); return chunk("MTrk", d); };
  const mpqn = Math.round(60000000 / song.bpm);
  const tracks = [track([{ tick: 0, order: 0, data: [0xff, 0x03, ...vlq(str(song.title).length), ...str(song.title)] }, { tick: 0, order: 1, data: [0xff, 0x51, 3, (mpqn >> 16) & 255, (mpqn >> 8) & 255, mpqn & 255] }, { tick: 0, order: 2, data: [0xff, 0x58, 4, 4, 2, 24, 8] }])];
  let ch = 0;
  for (const tr of song.tracks) {
    if (!tr.hits && ch === 9) ch++;                                 // channel 10 (9 here) is for drums only
    const c = tr.hits ? 9 : ch++ % 16, ev = [];
    ev.push({ tick: 0, order: 0, data: [0xff, 0x03, ...vlq(str(tr.name).length), ...str(tr.name)] });
    if (!tr.hits) ev.push({ tick: 0, order: 1, data: [0xc0 | c, INSTR[tr.inst].gm] });
    const notes = tr.hits ? tr.hits.map((h) => ({ t: h.t, d: .2, p: DRUMS[h.k], v: Math.round(h.v * 110) })) : tr.notes.map((n) => ({ ...n, v: 96 }));
    for (const n of notes) { const on = Math.round(n.t * TPQ), off = Math.round((n.t + n.d) * TPQ); ev.push({ tick: on, order: 3, data: [0x90 | c, n.p, n.v] }, { tick: Math.max(on + 1, off), order: 2, data: [0x80 | c, n.p, 0] }); }
    tracks.push(track(ev));
  }
  bytes.push(...chunk("MThd", [...u16(1), ...u16(tracks.length), ...u16(TPQ)]));
  for (const t of tracks) bytes.push(...t);
  return new Blob([new Uint8Array(bytes)], { type: "audio/midi" });
}
async function wavFile(song) {
  const sr = 44100, len = song.beats * 60 / song.bpm + 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * len), sr);
  schedule(ctx, song, .05, await preload(ctx, song));
  const buf = await ctx.startRendering(), L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
  const dv = new DataView(new ArrayBuffer(44 + n * 4));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 4, true);
  for (let i = 0, o = 44; i < n; i++, o += 4) { dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); dv.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  return new Blob([dv], { type: "audio/wav" });
}
const fileName = (s, ext) => (s.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, " ") || "song") + "." + ext;

// ---------- the chat tool ----------
const NOTATION = `Notes are written as PITCH/BEATS separated by spaces: C4/1 is middle C for one beat (a quarter note), E4/0.5 an eighth note, G4/2 a half note, R/1 a one-beat rest, and a chord is [C4 E4 G4]/2. Repeat a group with (...)xN: (A2/0.5 A3/0.5)x8 is a driving bass for two bars; use it for every repeated figure so the answer stays short. Sharps and flats: F#4, Bb3. 4 beats make one bar. Melodies sit around octave 4 to 5, chords around 3 to 4, bass around 2 to 3.`;
window.runMusicTool = async function (model, text) {
  const block = { type: "music", active: true, thinkLabel: "Composing…" };
  await toolAnswer(model, text, block, async ({ ask, history }) => {
    const str = { type: "string" };
    const schema = { type: "object", properties: {
      language: str, title: str, description: str, key: str, bpm: { type: "integer" }, bars: { type: "integer" },
      tracks: { type: "array", items: { type: "object", properties: { name: str, instrument: { type: "string", enum: Object.keys(INSTR) }, loop: { type: "boolean" }, notes: str }, required: ["name", "instrument", "loop", "notes"] } },
      drums: { type: "object", properties: { kick: str, snare: str, clap: str, hat: str, openhat: str }, required: ["kick", "snare", "clap", "hat", "openhat"] },
      reply: str }, required: ["language", "title", "description", "key", "bpm", "bars", "tracks", "drums", "reply"] };
    const sys = `You are a composer. You write a short, catchy, musically correct piece for what the user asks. Reply only with JSON.
- "language": the language the request is written in (for example English or German). Write "title", "description" and "reply" in it.
- "title", "description" (one sentence on mood and style), "key" (like "A minor"), "bpm", "bars" (8 to 32; 16 is a good length).
- Speed: the tempo AND the note lengths make music feel fast or slow. Calm: 60 to 90 bpm with long notes. Fast, energetic, dance, techno, rock, drum and bass: 130 to 180 bpm, with a busy melody of mostly 0.5 and 0.25 notes (8 to 16 notes per bar), a driving bass in 0.5 notes, and drums with hats on every step.
- "tracks": 2 to 5 instruments that fit the style, from: ${Object.keys(INSTR).join(", ")}. Usually chords (piano, epiano, pad, strings, guitar or organ), a bass line and a melody (lead, flute, bells, piano, brass…). Each track: "name", "instrument", "notes" and "loop". With "loop": true the notes repeat until the end (good for a 4-bar chord or bass pattern); with false they play once, so write all bars (a melody with a beginning, a repeat with variation and an ending).
- ${NOTATION} Stay in the key, give the melody a clear idea that comes back, let the bass play the chord roots, and make every track the right length.
- "drums": patterns of 16 steps per bar (sixteenth notes), x = hit, X = accented hit, . = nothing, for kick, snare, clap, hat, openhat; one bar repeats, or write several bars in a row. Leave a part "" if it doesn't play; all "" for no drums (calm, classical, lullabies).
- "reply": 1 or 2 sentences to the user about the piece, in the same language as the request.`;
    // a follow-up ("make it faster", "add drums") changes the last piece of this chat: the model sees what it was
    const prevSong = [...current.messages].reverse().map((m) => (m.blocks || []).find((b) => b.type === "music" && b.song)).find(Boolean)?.song;
    const prevText = prevSong ? `The last piece in this chat (change it if the request asks for a change): "${prevSong.title}", ${prevSong.key}, ${prevSong.bpm} bpm, ${prevSong.beats / 4} bars; ${prevSong.tracks.map((t) => t.name + " (" + t.inst + ")").join(", ")}. ${prevSong.about}` : "";
    const user = [history && `The conversation so far:\n${history}`, prevText, `Request: ${text}`].filter(Boolean).join("\n\n");
    const r = await ask([{ role: "system", content: sys }, { role: "user", content: user }], schema);
    block.song = buildSong(r);
    return String(r.reply || "").trim() || `Here is “${block.song.title}”. Press play, or download it for GarageBand.`;
  });
};

// ---------- the card: piano roll, play, mute tracks, downloads ----------
let playing = null;                                       // { ctx, card, t0, dur, raf }
function stopPlaying() { if (!playing) return; try { playing.ctx.close(); } catch {} cancelAnimationFrame(playing.raf); playing.card.querySelector('[data-a="play"]').textContent = "▶ Play"; playing.card.querySelector(".mu-head .pos").style.width = "0"; playing = null; }
function drawRoll(cv, song) {
  const W = cv.clientWidth, H = cv.clientHeight, dpr = Math.min(2, devicePixelRatio || 1); cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext("2d"); x.scale(dpr, dpr);
  const all = song.tracks.filter((t) => t.notes).flatMap((t) => t.notes.map((n) => n.p));
  const lo = Math.min(...all, 48) - 1, hi = Math.max(...all, 72) + 1, drumH = song.tracks.some((t) => t.hits) ? 16 : 0, rollH = H - drumH;
  x.fillStyle = "rgba(127,127,127,.08)"; for (let b = 0; b < song.beats; b += 4) if ((b / 4) % 2) x.fillRect(b / song.beats * W, 0, 4 / song.beats * W, H);
  for (const tr of song.tracks) {
    x.globalAlpha = tr.mute ? .18 : .9; x.fillStyle = tr.color;
    if (tr.notes) for (const n of tr.notes) x.fillRect(n.t / song.beats * W, rollH - (n.p - lo + 1) / (hi - lo) * rollH, Math.max(1.5, n.d / song.beats * W - 1), Math.max(2, rollH / (hi - lo)));
    else for (const h of tr.hits) x.fillRect(h.t / song.beats * W, rollH + 2 + (h.k === "kick" ? 8 : h.k === "snare" || h.k === "clap" ? 4 : 0), 2, 3);
  }
  x.globalAlpha = 1;
}
window.musicCard = function (b) {
  const w = document.createElement("div"); w.className = "tool-block";
  if (b.active) { w.innerHTML = '<div class="search-bar active"><span class="spin"></span><span class="q"></span></div>'; w.querySelector(".q").textContent = b.status || b.thinkLabel; return w; }
  if (b.error || !b.song) { w.innerHTML = '<div class="tool-err"></div>'; w.firstChild.textContent = "Couldn't compose that: " + (b.error || "no song"); return w; }
  const song = b.song, secs = Math.round(song.beats * 60 / song.bpm);
  const card = document.createElement("div"); card.className = "music-card";
  card.innerHTML = `<div class="mu-head"><button class="btn primary" data-a="play" type="button">▶ Play</button><div class="mu-ti"><b></b><small></small></div><i class="pos"></i></div>
    <canvas class="mu-roll" aria-label="The notes of the piece"></canvas><div class="mu-tracks"></div><p class="mu-about"></p>
    <div class="mu-acts"><button class="btn small primary" data-a="midi" type="button">Download MIDI (GarageBand)</button><button class="btn small" data-a="wav" type="button">Download WAV</button></div>`;
  card.querySelector("b").textContent = song.title;
  card.querySelector("small").textContent = [song.key, song.bpm + " bpm", Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0")].filter(Boolean).join(" · ");
  card.querySelector(".mu-about").textContent = song.about;
  const roll = card.querySelector(".mu-roll");
  for (const tr of song.tracks) {
    const t = document.createElement("button"); t.type = "button"; t.className = "mu-tr" + (tr.mute ? " off" : ""); t.style.setProperty("--c", tr.color);
    t.textContent = tr.name + (tr.hits ? "" : " · " + INSTR[tr.inst].name); t.title = "Click to mute or unmute";
    t.onclick = () => { tr.mute = !tr.mute; t.classList.toggle("off", tr.mute); drawRoll(roll, song); if (playing && playing.card === card) { stopPlaying(); card.querySelector('[data-a="play"]').click(); } };
    card.querySelector(".mu-tracks").appendChild(t);
  }
  card.querySelector('[data-a="play"]').onclick = async (e) => {
    if (playing && playing.card === card) return stopPlaying();
    stopPlaying();
    const ctx = new (window.AudioContext || window.webkitAudioContext)(), btn = e.target; btn.textContent = "Loading sounds…"; btn.disabled = true;
    const smp = await preload(ctx, song); btn.disabled = false;
    if (playing) { try { ctx.close(); } catch {} return; }       // pressed again while loading
    const t0 = ctx.currentTime + .08, dur = schedule(ctx, song, t0, smp);
    playing = { ctx, card, t0, dur }; btn.textContent = "■ Stop";
    const pos = card.querySelector(".mu-head .pos");
    const tick = () => { if (!playing || playing.card !== card) return; const p = (ctx.currentTime - t0) / dur; if (p >= 1) { stopPlaying(); return; } pos.style.width = Math.max(0, p * 100) + "%"; playing.raf = requestAnimationFrame(tick); };
    tick();
  };
  card.querySelector('[data-a="midi"]').onclick = () => { download(fileName(song, "mid"), midiFile(song)); toast("MIDI saved: open it in GarageBand (File → Open), each instrument is its own track"); };
  card.querySelector('[data-a="wav"]').onclick = async (e) => { const btn = e.target, old = btn.textContent; btn.disabled = true; btn.textContent = "Recording…"; try { download(fileName(song, "wav"), await wavFile(song)); } catch (err) { toast("Couldn't make the WAV: " + err.message); } finally { btn.disabled = false; btn.textContent = old; } };
  w.appendChild(card);
  requestAnimationFrame(() => drawRoll(roll, song));
  return w;
};
window.musicTest = { parseNotes, buildSong, midiFile, wavFile, preload };
})();
