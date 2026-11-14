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
    if (got.size) { const have = [...got.keys()]; out[t.inst] = (p) => { if (got.has(p)) return got.get(p); const q = have.reduce((a, b) => Math.abs(b - p) < Math.abs(a - p) ? b : a); return { buf: got.get(q), rate: Math.pow(2, (p - q) / 12) }; }; }
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
  const hit = smp && smp[inst] && smp[inst](midi), buf = hit && (hit.buf || hit);
  if (buf) {
    const src = ctx.createBufferSource(), g = ctx.createGain(), end = time + dur, rel = inst === "piano" || inst === "pluck" || inst === "bells" || inst === "epiano" ? .5 : .25;
    src.buffer = buf; if (hit.rate) src.playbackRate.value = hit.rate; src.connect(g); g.connect(out);
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
  // a burst of filtered noise, and a pitched thump that falls: the two things every drum is made of
  const noise = (type, freq, q, len, level, at = 0) => {
    const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); n.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
    n.connect(f); f.connect(g); g.connect(out); g.gain.setValueAtTime(level * vel, time + at); g.gain.exponentialRampToValueAtTime(.001, time + at + len);
    n.start(time + at, Math.random() * .5); n.stop(time + at + len + .02);
  };
  const tone = (f0, f1, len, level, type = "sine") => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f0, time); o.frequency.exponentialRampToValueAtTime(f1, time + len * .7);
    o.connect(g); g.connect(out); g.gain.setValueAtTime(level * vel, time); g.gain.exponentialRampToValueAtTime(.001, time + len); o.start(time); o.stop(time + len + .02);
  };
  if (k === "kick") { tone(165, 44, .42, .72); tone(62, 46, .36, .38); noise("highpass", 2800, .7, .018, .3); }
  else if (k === "snare") { tone(235, 175, .14, .4, "triangle"); tone(340, 250, .08, .18, "triangle"); noise("bandpass", 2300, .9, .21, .5); noise("highpass", 6000, .5, .13, .2); }
  else if (k === "clap") { for (let i = 0; i < 3; i++) noise("bandpass", 1500, 1.3, .025, .42, i * .012); noise("bandpass", 1350, 1, .17, .38, .036); }
  else {   // hats: six square waves tuned against each other, like the old drum machines, sound metallic where plain noise only hisses
    const open = k === "openhat", len = open ? .34 : .055, hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 7200; hp.connect(g); g.connect(out);
    g.gain.setValueAtTime((open ? .17 : .22) * vel, time); g.gain.exponentialRampToValueAtTime(.001, time + len);
    for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) { const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = f; o.connect(hp); o.start(time); o.stop(time + len + .02); }
    noise("highpass", 9000, .5, len, open ? .1 : .14);
  }
}
// everything of the song on one audio context (a live one, or an offline one for the WAV)
// a room: noise that dies away, over about two seconds (made here, nothing to download)
function roomImpulse(ctx, secs = 2.1) {
  const n = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < n; i++) { lp += ((Math.random() * 2 - 1) - lp) * .5; d[i] = lp * Math.pow(1 - i / n, 2.8); } }
  return b;
}
const SEND = { strings: .38, pad: .42, choir: .42, flute: .3, bells: .36, brass: .2, lead: .26, piano: .2, epiano: .24, guitar: .14, organ: .2, pluck: .3, bass: 0, synthbass: 0 };
function schedule(ctx, song, t0, smp) {
  const master = ctx.createGain(); master.gain.value = .56;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3.5; comp.attack.value = .006; comp.release.value = .18; master.connect(comp); comp.connect(ctx.destination);
  const rev = ctx.createConvolver(), wet = ctx.createGain(); rev.buffer = roomImpulse(ctx); wet.gain.value = .9; rev.connect(wet); wet.connect(master);
  const spb = 60 / song.bpm;
  for (const tr of song.tracks) {
    if (tr.mute) continue;
    const bus = ctx.createGain(); bus.gain.value = tr.gain ?? 1; bus.connect(master);
    const send = tr.hits ? .05 : (SEND[tr.inst] ?? .18);
    if (send) { const sg = ctx.createGain(); sg.gain.value = send; bus.connect(sg); sg.connect(rev); }
    if (tr.hits) for (const h of tr.hits) drum(ctx, bus, h.k, t0 + h.t * spb, h.v);
    else for (const n of tr.notes) voice(ctx, bus, tr.inst, t0 + n.t * spb, n.p, Math.max(.05, n.d * spb * .95), n.v ?? .9, smp);
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
    const notes = tr.hits ? tr.hits.map((h) => ({ t: h.t, d: .2, p: DRUMS[h.k], v: Math.round(h.v * 110) })) : tr.notes.map((n) => ({ ...n, v: n.v != null ? Math.round(clamp(n.v, .05, 1) * 118) : 96 }));
    for (const n of notes) { const on = Math.round(n.t * TPQ), off = Math.round((n.t + n.d) * TPQ); ev.push({ tick: on, order: 3, data: [0x90 | c, n.p, n.v] }, { tick: Math.max(on + 1, off), order: 2, data: [0x80 | c, n.p, 0] }); }
    tracks.push(track(ev));
  }
  bytes.push(...chunk("MThd", [...u16(1), ...u16(tracks.length), ...u16(TPQ)]));
  for (const t of tracks) bytes.push(...t);
  return new Blob([new Uint8Array(bytes)], { type: "audio/midi" });
}
// the piece rendered with the built-in synth only (no downloads): for tests and as the sound when the recordings can't be loaded
async function renderSynth(song) {
  const sr = 44100, ctx = new OfflineAudioContext(2, Math.ceil(sr * (song.beats * 60 / song.bpm + 2.5)), sr);
  schedule(ctx, song, .05, {});
  return ctx.startRendering();
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
// ---------- the composer: the model has the musical idea, the app writes the notes ----------
// Models are poor at writing raw notes (out of key, no pulse, random wandering). So the model only decides the idea: a style, a key,
// the chords as roman numerals, a short motif in scale degrees and how the piece is built. The app then writes the music from it with
// real music rules: voice-led chords, bass lines and drum patterns that belong to the style, a melody that develops the motif
// (answer, sequence, inversion, cadence), always in the key and landing on chord tones on the strong beats.
const MODES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], "harmonic minor": [0, 2, 3, 5, 7, 8, 11] };
const PCS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }, ROMAN = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function parseKey(str) {
  const m = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*(.*)$/.exec(String(str || "")), rest = (m ? m[3] : "").toLowerCase().trim();
  const pc = m ? ((PCS[m[1].toUpperCase()] + (/[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0)) + 12) % 12 : 0;
  const mode = /harmonic/.test(rest) ? "harmonic minor" : /dorian/.test(rest) ? "dorian" : /mixolydian/.test(rest) ? "mixolydian" : /phrygian/.test(rest) ? "phrygian" : /lydian/.test(rest) ? "lydian" : /^maj|^major/.test(rest) ? "major" : /^m(in|inor)?$|minor|^min/.test(rest) ? "minor" : "major";
  return { pc, mode };
}
// a chord from a roman numeral ("i", "VI", "V7", "bVII", "ii°", "Imaj7") or a name ("Am", "F", "G7", "Cmaj7")
function chordOf(tok, key) {
  const t = String(tok || "").trim(), sc = MODES[key.mode];
  let m = /^([b#♭♯]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(°|o|dim|\+|aug|maj7|M7|m7|7|9|sus4|sus2)?$/.exec(t);
  if (m) {
    const up = m[2] === m[2].toUpperCase(), deg = ROMAN[m[2].toLowerCase()], acc = /[b♭]/.test(m[1]) ? -1 : m[1] ? 1 : 0, q = m[3] || "";
    const tones = [0, up && q !== "m7" ? 4 : 3, 7];
    if (/°|^o$|dim/.test(q)) { tones[1] = 3; tones[2] = 6; } if (/\+|aug/.test(q)) tones[2] = 8;
    if (q === "sus4") tones[1] = 5; if (q === "sus2") tones[1] = 2;
    if (q === "7" || q === "9" || q === "m7") tones.push(10); if (/maj7|M7/.test(q)) tones.push(11);
    return { root: (key.pc + sc[deg] + acc + 12) % 12, tones };
  }
  m = /^([A-G])([#b]?)(maj7|M7|m7|min7|min|m|dim|aug|\+|sus4|sus2|7)?$/.exec(t);
  if (m) {
    const q = m[3] || "", Q = { "": [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], dim: [0, 3, 6], aug: [0, 4, 8], "+": [0, 4, 8], sus4: [0, 5, 7], sus2: [0, 2, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11] }[q];
    return { root: (PCS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12, tones: Q };
  }
  return null;
}
// close voicing near the middle of the piano that moves as little as possible from the last chord
function voiceChord(ch, prev) {
  const pcs = ch.tones.map((x) => (ch.root + x) % 12); let best = null;
  for (let inv = 0; inv < pcs.length; inv++) {
    const order = pcs.slice(inv).concat(pcs.slice(0, inv)); let n = 52; while (n % 12 !== order[0]) n++;
    const notes = [n]; for (const pc of order.slice(1)) { let q = notes[notes.length - 1] + 1; while (q % 12 !== pc) q++; notes.push(q); }
    if (notes[notes.length - 1] > 76) continue;
    const avg = notes.reduce((a, b) => a + b, 0) / notes.length, cost = Math.abs(avg - (prev || 62));
    if (!best || cost < best.cost) best = { notes, cost, avg };
  }
  return best || { notes: pcs.map((pc) => 60 + pc), avg: 62 };
}
const bassNote = (ch) => 36 + (((ch.root - 36) % 12) + 12) % 12;
// style: tempo, feel, who plays, and what the chords, bass and drums do at low (1), medium (2) and high (3) energy
const STYLES = {
  pop:       { bpm: [96, 124], swing: 0, inst: { chords: "piano", bass: "bass", lead: "lead", pad: "strings" }, chord: ["block", "alberti", "comp"], bass: ["root-half", "eighths", "eighths"], pad: 3, drums: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", clap: "", openhat: "..............x." } },
  rock:      { bpm: [112, 150], swing: 0, inst: { chords: "guitar", bass: "bass", lead: "lead", pad: "organ" }, chord: ["strum", "strum", "strum"], bass: ["eighths", "eighths", "eighths"], pad: 3, drums: { kick: "x.....x.x.......", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", clap: "", openhat: "" } },
  lofi:      { bpm: [68, 88], swing: .5, inst: { chords: "epiano", bass: "bass", lead: "pluck", pad: "pad" }, chord: ["comp", "comp", "comp"], bass: ["root-half", "syncop", "syncop"], pad: 3, drums: { kick: "x.....x...x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", clap: "", openhat: "" } },
  edm:       { bpm: [120, 132], swing: 0, inst: { chords: "pad", bass: "synthbass", lead: "lead", pad: "strings" }, chord: ["block", "stab", "stab"], bass: ["sub", "offbeat", "offbeat"], pad: 2, drums: { kick: "x...x...x...x...", snare: "", hat: "..x...x...x...x.", clap: "....x.......x...", openhat: "..x.....x......." } },
  techno:    { bpm: [124, 136], swing: 0, inst: { chords: "organ", bass: "synthbass", lead: "bells", pad: "pad" }, chord: ["pad", "stab", "stab"], bass: ["sixteenth", "sixteenth", "sixteenth"], pad: 2, drums: { kick: "x...x...x...x...", snare: "", hat: "..x...x...x...x.", clap: "........x.......", openhat: "..x...x...x...x." } },
  dnb:       { bpm: [168, 176], swing: 0, inst: { chords: "pad", bass: "synthbass", lead: "lead", pad: "strings" }, chord: ["pad", "pad", "stab"], bass: ["sub", "syncop", "syncop"], pad: 2, drums: { kick: "x.........x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", clap: "", openhat: "......x.......x." } },
  ballad:    { bpm: [60, 80], swing: 0, inst: { chords: "piano", bass: "bass", lead: "flute", pad: "strings" }, chord: ["arp", "arp", "arp"], bass: ["root-half", "root-half", "root-half"], pad: 2, drums: { kick: "x.......x.......", snare: "", hat: "", clap: "........x.......", openhat: "" } },
  classical: { bpm: [72, 104], swing: 0, inst: { chords: "piano", bass: "strings", lead: "flute", pad: "strings" }, chord: ["alberti", "alberti", "alberti"], bass: ["root-half", "root-half", "root-half"], pad: 3, drums: null },
  jazz:      { bpm: [108, 150], swing: .6, sevenths: true, inst: { chords: "epiano", bass: "bass", lead: "flute", pad: "pad" }, chord: ["comp", "comp", "comp"], bass: ["walk", "walk", "walk"], pad: 99, drums: { kick: "x.......x.......", snare: "", hat: "x..xx..xx..xx..x", clap: "", openhat: "" } },
  folk:      { bpm: [88, 116], swing: 0, inst: { chords: "guitar", bass: "bass", lead: "flute", pad: "strings" }, chord: ["arp", "arp", "alberti"], bass: ["folk", "folk", "folk"], pad: 99, drums: { kick: "x.......x.......", snare: "", hat: "", clap: "....x.......x...", openhat: "" } },
  cinematic: { bpm: [66, 92], swing: 0, inst: { chords: "strings", bass: "strings", lead: "brass", pad: "choir" }, chord: ["pad", "pad", "block"], bass: ["sub", "sub", "sub"], pad: 2, drums: { kick: "x...............", snare: "", hat: "", clap: "", openhat: "" } },
  hiphop:    { bpm: [78, 96], swing: .35, inst: { chords: "epiano", bass: "synthbass", lead: "bells", pad: "pad" }, chord: ["comp", "comp", "comp"], bass: ["root-half", "syncop", "syncop"], pad: 99, drums: { kick: "x.....x...x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", clap: "", openhat: "" } },
  game:      { bpm: [124, 152], swing: 0, inst: { chords: "lead", bass: "synthbass", lead: "bells", pad: "organ" }, chord: ["arp", "arp", "arp"], bass: ["eighths", "eighths", "eighths"], pad: 99, drums: { kick: "x...x...x...x...", snare: "", hat: "x.x.x.x.x.x.x.x.", clap: "....x.......x...", openhat: "" } },
};
function chordNotes(pat, v) {   // [{ t, d, n: [pitches] }] for one bar
  const top = v[v.length - 1], four = v.length > 3 ? v[3] : v[0] + 12, r = v[0], at = (list) => list.map(([t, d]) => ({ t, d, n: v }));
  if (pat === "block" || pat === "pad") return [{ t: 0, d: 3.9, n: v }];
  if (pat === "comp") return at([[0, 1.25], [1.5, .5], [2.75, 1]]);
  if (pat === "stab") return [.5, 1.5, 2.5, 3.5].map((t) => ({ t, d: .35, n: v }));
  if (pat === "strum") return Array.from({ length: 8 }, (_, i) => ({ t: i * .5, d: .45, n: [r - 12, r - 5, r] }));
  if (pat === "alberti") return [v[0], v[2] ?? v[1], v[1], v[2] ?? v[1], v[0], v[2] ?? v[1], v[1], v[2] ?? v[1]].map((p, i) => ({ t: i * .5, d: .5, n: [p] }));
  const seq = [v[0], v[1], v[2], four, v[2], v[1], v[2], v[1]];   // arp
  return seq.map((p, i) => ({ t: i * .5, d: .55, n: [p] }));
}
function bassNotes(pat, b, next) {   // [{ t, d, p }]
  const o = (list, p = b) => list.map(([t, d, q]) => ({ t, d, p: q ?? p }));
  if (pat === "sub") return o([[0, 3.9]]);
  if (pat === "root-half") return o([[0, 1.9], [2, 1.9]]);
  if (pat === "eighths") return Array.from({ length: 8 }, (_, i) => ({ t: i * .5, d: .45, p: i % 4 === 3 ? b + 12 : b }));
  if (pat === "offbeat") return [.5, 1.5, 2.5, 3.5].map((t) => ({ t, d: .45, p: b }));
  if (pat === "sixteenth") return [2, 3, 6, 7, 10, 11, 14, 15].map((s) => ({ t: s * .25, d: .2, p: b }));
  if (pat === "syncop") return o([[0, .75], [1.5, .5], [2.5, .75], [3.5, .4]]);
  if (pat === "folk") return o([[0, 1.9], [2, 1.9, b + 7 > 50 ? b : b + 7]]);
  return o([[0, .95], [1, .95, b + 4 > 50 ? b : b + 4], [2, .95, b + 7 > 50 ? b : b + 7], [3, .95, next - 1]]);   // walk: root, third, fifth, a step below the next root
}
function parseMotif(str) {
  const out = []; let t = 0;
  for (const tok of String(str || "").trim().split(/[\s,]+/)) {
    const m = /^([1-7]|[rR])([+-]*)(?:\/([\d.]+))?$/.exec(tok); if (!m) continue;
    const d = clamp(Number(m[3]) || 1, .25, 4);
    if (/r/i.test(m[1])) { t += d; continue; }
    out.push({ t, d, deg: Number(m[1]) - 1 + 7 * ((m[2].match(/\+/g) || []).length - (m[2].match(/-/g) || []).length) });
    t += d;
  }
  return { notes: out, len: t };
}
function makeMotif(rng) {   // when the model gave none (or an unusable one): a singable one, mostly steps
  const rhythms = [[1, 1, 1, 1], [1.5, .5, 1, 1], [1, .5, .5, 1, 1], [.5, .5, 1, .5, .5, 1], [2, 1, .5, .5], [1, 1, 2]], r = rhythms[Math.floor(rng() * rhythms.length)];
  let deg = [0, 2, 4][Math.floor(rng() * 3)], t = 0; const notes = [];
  r.forEach((d) => { notes.push({ t, d, deg }); t += d; deg = clamp(deg + [-2, -1, -1, 1, 1, 2, 2][Math.floor(rng() * 7)], -2, 8); });
  notes[notes.length - 1].deg = [0, 1, 2, 4][Math.floor(rng() * 4)];
  return { notes, len: 4 };
}
// one phrase (two bars) from the motif: A states it and answers, B is the sequence a step or two higher, C turns it upside down, END settles on the tonic
function phrase(motif, kind) {
  const cp = (ns, f) => ns.map((n) => ({ ...n, deg: f(n) })), a = motif.notes, c = a[0].deg, fit = motif.len <= 4 ? 4 : 8;
  const sh = (ns, k) => cp(ns, (n) => n.deg + k), inv = (ns) => cp(ns, (n) => 2 * c - n.deg), later = (ns, t0) => ns.map((n) => ({ ...n, t: n.t + t0 }));
  const end = (ns) => { const x = ns.map((n) => ({ ...n })), l = x[x.length - 1]; l.deg = 0; l.d = Math.max(l.d, fit - l.t - .1); return x; };
  let out;
  if (fit === 4) {
    const first = kind === "B" ? sh(a, 2) : a, second = kind === "B" ? sh(a, 1) : kind === "C" ? inv(a) : kind === "END" ? end(a) : cp(a, (n) => n === a[a.length - 1] ? n.deg + 1 : n.deg);
    out = [...first, ...later(second, 4)];
  } else out = kind === "B" ? sh(a, 2) : kind === "C" ? inv(a) : kind === "END" ? end(a) : a;
  return out.filter((n) => n.t < 8).map((n) => ({ ...n, d: Math.min(n.d, 8 - n.t) }));
}
function composeSong(spec) {
  const title = String(spec.title || "Untitled").slice(0, 80), key = parseKey(spec.key), style = STYLES[spec.style] ? spec.style : "pop", st = STYLES[style], sc = MODES[key.mode];
  let h = 2166136261; for (const ch of title + key.pc + style) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rng = () => { h = (h + 0x6D2B79F5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const bpm = clamp(Math.round(Number(spec.bpm)) || Math.round((st.bpm[0] + st.bpm[1]) / 2), st.bpm[0] - 12, st.bpm[1] + 12), swing = st.swing;
  const minor = key.mode !== "major" && key.mode !== "lydian" && key.mode !== "mixolydian";
  let raw = Array.isArray(spec.progression) ? spec.progression : String(spec.progression || "").split(/[\s,|]+/);
  let prog = raw.map((x) => chordOf(x, key)).filter(Boolean).slice(0, 8);
  if (!prog.length) prog = (minor ? ["i", "VI", "III", "VII"] : ["I", "V", "vi", "IV"]).map((x) => chordOf(x, key));
  if (st.sevenths) for (const ch of prog) if (ch.tones.length === 3) ch.tones.push(ch.tones[1] === 4 ? 11 : 10);
  const clean = (Array.isArray(spec.structure) ? spec.structure : []).slice(0, 10).map((x, i) => ({ name: String(x?.name || "Part " + (i + 1)).slice(0, 24), bars: clamp(Math.round(Number(x?.bars)) || 8, 2, 16), energy: clamp(Math.round(Number(x?.energy)) || 2, 1, 3), melody: /^b$/i.test(x?.melody) ? "B" : /^none|^-$|^no/i.test(String(x?.melody || "")) ? "" : "A" }));
  let structure = []; let total = 0;
  for (const x of clean) { if (total + x.bars > 64) break; structure.push(x); total += x.bars; }
  if (!structure.length) structure = [{ name: "Intro", bars: 4, energy: 1, melody: "" }, { name: "Verse", bars: 8, energy: 2, melody: "A" }, { name: "Chorus", bars: 8, energy: 3, melody: "B" }, { name: "Outro", bars: 4, energy: 1, melody: "A" }];
  const mA0 = parseMotif(spec.motif), mB0 = parseMotif(spec.motif_b), ok = (m) => m.notes.length >= 3 && m.len >= 2 && m.len <= 8;
  const mA = ok(mA0) ? mA0 : makeMotif(rng), mB = ok(mB0) ? mB0 : { notes: mA.notes.map((n) => ({ ...n, deg: n.deg + 2 })), len: mA.len };
  const ins = { ...st.inst, ...(spec.instruments && typeof spec.instruments === "object" ? Object.fromEntries(Object.entries(spec.instruments).filter(([k, v]) => k in st.inst && INSTR[v])) : {}) };
  const tonic = 60 + key.pc - (key.pc > 5 ? 12 : 0) + 12, degPitch = (d) => tonic + 12 * Math.floor(d / 7) + sc[((d % 7) + 7) % 7];
  const tr = { chords: [], bass: [], lead: [], pad: [] }, hits = [], pcSet = (ch) => new Set(ch.tones.map((x) => (ch.root + x) % 12)), inScale = new Set(sc.map((x) => (key.pc + x) % 12));
  const sw = (t) => (Math.abs((t % 1) - .5) < .01 ? t + swing * .33 : t);
  const hum = (a) => (rng() - .5) * 2 * a, at0 = (t) => Math.max(0, t), jit = (v) => v * (.93 + rng() * .14);   // a little human: timing and loudness never exactly the same twice
  const drumHits = (bar0, e, fill) => {
    if (!st.drums) return;
    for (const k of Object.keys(DRUMS)) {
      let pat = st.drums[k] || ""; if (!pat) continue;
      if (e === 1 && !["kick", "hat"].includes(k) && !(k === "clap" && style === "ballad")) continue;
      if (e === 1 && k === "hat") pat = "x...x...x...x...";
      if (k === "openhat" && e < 3) continue;
      if (k === "snare" && fill) pat = "....x...x.x.xxxx";
      const base = { kick: .95, snare: .9, clap: .8, hat: .6, openhat: .62 }[k] * (e === 3 ? 1 : e === 2 ? .88 : .75);
      [...pat].forEach((c, i) => { if (c === "x" || c === "X") hits.push({ t: bar0 * 4 + i * .25 + (swing && i % 4 === 2 ? swing * .33 : swing && i % 2 === 1 ? swing * .16 : 0), k, v: Math.min(1, jit(k === "hat" ? base * (i % 4 === 0 ? 1.15 : i % 2 === 0 ? .85 : .6) : base) * (c === "X" ? 1.12 : 1)) }); });
    }
  };
  let bar = 0, prevAvg = 0;
  structure.forEach((sec, si) => {
    const e = sec.energy, motif = sec.melody === "B" ? mB : mA, nPh = Math.ceil(sec.bars / 2), kinds = ["A", "A", "B", "A"], last = si === structure.length - 1;
    for (let b = 0; b < sec.bars; b++) {
      const ch = prog[b % prog.length], next = prog[(b + 1) % prog.length], vc = voiceChord(ch, prevAvg), t0 = (bar + b) * 4; prevAvg = vc.avg;
      const strum = ["block", "comp", "strum"].includes(st.chord[e - 1]) ? .025 : 0;   // a chord is never struck by all fingers at the same instant
      for (const ev of chordNotes(st.chord[e - 1], vc.notes)) ev.n.forEach((p, i) => tr.chords.push({ t: at0(sw(t0 + ev.t) + hum(.012) + i * strum), d: ev.d, p, v: jit((ev.t === 0 ? .74 : ev.t % 1 === 0 ? .6 : .5) * (e === 3 ? 1.1 : e === 1 ? .85 : 1)) }));
      if (e >= 2 || ["sub", "root-half"].includes(st.bass[0])) for (const n of bassNotes(st.bass[e - 1], bassNote(ch), bassNote(next))) tr.bass.push({ t: at0(sw(t0 + n.t) + hum(.008)), d: n.d, p: n.p, v: jit(n.t % 4 === 0 ? .95 : n.t % 1 === 0 ? .82 : .7) });
      if (e >= st.pad) vc.notes.forEach((p, i) => tr.pad.push({ t: t0 + i * .04, d: 3.95 - i * .04, p: p - (style === "cinematic" ? 12 : 0), v: jit(.42 * (e === 3 ? 1.15 : 1)) }));
      drumHits(bar + b, e, e >= 2 && !last && b === sec.bars - 1);
    }
    if (sec.melody) for (let ph = 0; ph < nPh; ph++) {
      const kind = ph === nPh - 1 ? "END" : kinds[ph % 4];
      for (const n of phrase(motif, kind)) {
        const t = ph * 8 + n.t; if (t >= sec.bars * 4) continue;
        const ch = prog[Math.floor(t / 4) % prog.length], strong = (t % 2 === 0) && n.d >= .75;
        let p = degPitch(n.deg);
        if (strong) { const set = pcSet(ch); let best = p; for (const dd of [0, -1, 1, -2, 2]) if (set.has((p + dd + 120) % 12) && inScale.has((p + dd + 120) % 12)) { best = p + dd; break; } p = best; }
        while (p > 91) p -= 12; while (p < 62) p += 12;
        tr.lead.push({ t: at0(sw(bar * 4 + t) + hum(.01)), d: Math.min(n.d, sec.bars * 4 - t) * .95, p, v: Math.min(1, jit((strong ? .95 : t % 1 === 0 ? .86 : .74) * (e === 3 ? 1.05 : e === 1 ? .8 : .92))) });
      }
    }
    bar += sec.bars;
  });
  // the last bar: everything settles on the tonic chord
  const tonicCh = prog[0].root === key.pc ? prog[0] : { root: key.pc, tones: [0, minor ? 3 : 4, 7] }, tv = voiceChord(tonicCh, prevAvg), tb = bar * 4;
  tv.notes.forEach((p, i) => { tr.chords.push({ t: tb + i * .03, d: 3.5, p, v: .7 }); if (st.pad < 99) tr.pad.push({ t: tb + i * .04, d: 3.8, p, v: .4 }); });
  tr.bass.push({ t: tb, d: 3.5, p: bassNote(tonicCh), v: .9 });
  if (structure.some((x) => x.melody)) tr.lead.push({ t: tb, d: 3, p: degPitch(0) + (degPitch(0) < 66 ? 12 : 0), v: .9 });
  if (st.drums) hits.push({ t: tb, k: "kick", v: .9 });
  // levels like a mixer: the melody on top, the bass solid, chords and pad behind
  const tracks = [], add = (name, inst, notes, i, gain) => notes.length && tracks.push({ name, inst, notes, color: COLORS[i % COLORS.length], mute: false, gain });
  add("Chords", ins.chords, tr.chords, 0, .8); add("Bass", ins.bass, tr.bass, 1, .95); add("Melody", ins.lead, tr.lead, 2, 1); add("Pad", ins.pad, tr.pad, 3, .55);
  if (hits.length) tracks.push({ name: "Drums", inst: "drums", hits, color: "#8E8E93", mute: false, gain: .9 });
  const names = prog.map((c) => NN[c.root]).join(" ");
  return { title, about: String(spec.description || "").slice(0, 400), key: `${NN[key.pc]} ${key.mode}`, bpm, beats: (bar + 1) * 4, tracks,
    spec: { style, key: `${NN[key.pc]} ${key.mode}`, bpm, progression: raw.slice(0, 8).join(" "), motif: String(spec.motif || ""), motif_b: String(spec.motif_b || ""), structure, chordRoots: names } };
}
// what the model fills in, as a form: the same for the chat tool and for models without tools
const MUSIC_PROPS = (() => {
  const str = { type: "string" };
  return {
    title: { type: "string", description: "Title of the piece" }, description: { type: "string", description: "One sentence on mood and style" },
    style: { type: "string", enum: Object.keys(STYLES), description: "pop, rock, lofi (calm beats), edm, techno, dnb (drum and bass), ballad (slow piano), classical, jazz, folk, cinematic (film score), hiphop, game (chiptune-like)" },
    key: { type: "string", description: "Key and mode, like \"A minor\", \"C major\", \"D dorian\", \"E phrygian\" (dark), \"F lydian\" (dreamy)" },
    bpm: { type: "integer", description: "Tempo; it should suit the style (ballad 60 to 80, pop 100 to 120, techno 125 to 135, drum and bass 170)" },
    progression: { type: "array", items: str, description: "The chords, one per bar, as roman numerals in the key, 4 or 8 of them: major like I V vi IV or I vi IV V, minor like i VI III VII, i iv v i or i VII VI V. Uppercase is a major chord, lowercase minor; add 7 for a seventh (V7), ° for diminished (vii°). Chord names (Am, F, C, G7) also work." },
    motif: { type: "string", description: "The main melody idea, one bar (4 beats), written as scale degrees of the key with a length in beats after a slash: 1 is the tonic, 5 the fifth, 1/1 = one beat, 3/0.5 = half a beat, add + for an octave up and - for an octave down (1+/1), r/1 is a rest. Like \"3/1 5/0.5 6/0.5 5/2\". Mostly steps with a leap now and then; the app develops it into a whole melody." },
    motif_b: { type: "string", description: "Optional second idea for the chorus, same notation" },
    structure: { type: "array", description: "How the piece is built, 16 to 48 bars in total", items: { type: "object", properties: { name: str, bars: { type: "integer", description: "2 to 16, usually 4 or 8" }, energy: { type: "integer", description: "1 calm, 2 medium, 3 full" }, melody: { type: "string", enum: ["A", "B", "none"], description: "A = the main idea, B = the second idea (chorus), none = no melody" } }, required: ["name", "bars", "energy", "melody"] } },
    instruments: { type: "object", description: "Optional: change who plays what, from: " + Object.keys(INSTR).join(", "), properties: { chords: str, bass: str, lead: str, pad: str } },
  };
})();
window.musicCompose = composeSong;
window.MUSIC_PROPS = MUSIC_PROPS;
window.runMusicTool = async function (model, text) {
  const block = { type: "music", active: true, thinkLabel: "Composing…" };
  await toolAnswer(model, text, block, async ({ ask, history }) => {
    const str = { type: "string" };
    const schema = { type: "object", properties: { language: str, ...MUSIC_PROPS, reply: str }, required: ["language", "title", "description", "style", "key", "bpm", "progression", "motif", "structure", "reply"] };
    const sys = `You are a composer. You come up with the musical idea for what the user asks, and the app writes out the notes. Reply only with JSON.
- "language": the language the request is written in (for example English or German). Write "title", "description" and "reply" in it.
- "style", "key", "bpm": choose them to fit the mood the user wants (sad: minor, slow; happy: major, medium; dark: minor or phrygian; dreamy: lydian or major 7ths; epic: minor, cinematic).
- "progression": 4 or 8 chords, one per bar, as roman numerals in the key (uppercase major, lowercase minor), like I V vi IV or i VI III VII. Chords that really belong together; the last chord should lead back to the first.
- "motif": the melody idea, one bar, as scale degrees with beat lengths, like "3/1 5/0.5 6/0.5 5/2". Make it singable and memorable: mostly steps, one leap, ending on a calm note (1, 3 or 5). "motif_b" optional for the chorus.
- "structure": 3 to 5 parts (intro, verse, chorus, outro...), 16 to 48 bars in all, with an energy from 1 to 3 and which melody plays (A, B or none). Build up: start calm, end on the biggest part or a calm outro.
- "reply": 1 or 2 sentences to the user about the piece, in the same language as the request.`;
    // a follow-up ("make it faster", "add drums") changes the last piece of this chat: the model sees what it was
    const prevSong = [...current.messages].reverse().map((m) => (m.blocks || []).find((b) => b.type === "music" && b.song)).find(Boolean)?.song;
    const prevText = prevSong?.spec ? `The last piece in this chat (change it if the request asks for a change; keep what isn't mentioned): ${JSON.stringify({ title: prevSong.title, ...prevSong.spec })}` : prevSong ? `The last piece in this chat: "${prevSong.title}", ${prevSong.key}, ${prevSong.bpm} bpm.` : "";
    const user = [history && `The conversation so far:\n${history}`, prevText, `Request: ${text}`].filter(Boolean).join("\n\n");
    const r = await ask([{ role: "system", content: sys }, { role: "user", content: user }], schema);
    block.song = composeSong(r);
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
window.musicTest = { parseNotes, buildSong, composeSong, midiFile, wavFile, preload, renderSynth };
})();
