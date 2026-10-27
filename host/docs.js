// "Ask your documents": the folders the user picks (inside their own user folder) are read, their text is cut into passages, and
// each passage gets an embedding from a small Ollama model (embeddinggemma), all on this PC. A question then finds the passages
// that mean the closest thing, and the website's AI answers from them, naming the files.
// Reads: txt, md, csv, json, html, docx, pptx, xlsx, pdf. Never changes or deletes anything.
// Kept in <LocalAppData>\Albatross\docs (config.json: the folders; index.json: the passages and their embeddings).
const fs = require("fs"), path = require("path"), os = require("os"), zlib = require("zlib");

const DIR = process.env.ALB_DOCS_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "docs");
const CONFIG = path.join(DIR, "config.json"), INDEX = path.join(DIR, "index.json");
const MODEL = "embeddinggemma", V = 2;           // V: raise when what goes into an embedding changes, so everything is read again
const EXT = /\.(txt|md|markdown|csv|json|html?|docx|pptx|xlsx|pdf)$/i, SKIP_DIR = /^(node_modules|\.git|\$recycle\.bin|appdata|\.cache|__pycache__|venv|\.venv)$/i;
const MAX_FILES = 4000, MAX_BYTES = 40 * 1024 * 1024, CHUNK = 900, OVERLAP = 150;
let OLLAMA = "http://127.0.0.1:11434";

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const config = () => readJson(CONFIG, { folders: [] });
let index = null;                                    // { model, files: { path: { mtime, size, chunks: [{ t, p, e }] } } }
const loadIndex = () => { if (!index) { index = readJson(INDEX, {}); if (index.v !== V || index.model !== MODEL) index = { v: V, model: MODEL, files: {} }; } return index; };
const saveIndex = () => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(index)); };
const state = { running: false, done: 0, total: 0, file: "", error: "", finished: 0, added: 0, removed: 0 };

// only folders inside the user's own folder (Documents, Desktop, Downloads, OneDrive...), never system places
function checkFolder(p) {
  const full = path.resolve(String(p || "").trim().replace(/^["']|["']$/g, ""));
  const home = path.resolve(os.homedir());
  if (!full.toLowerCase().startsWith(home.toLowerCase() + path.sep) && full.toLowerCase() !== home.toLowerCase()) throw new Error(`Only folders inside your user folder (${home}) can be added.`);
  if (/\\appdata(\\|$)/i.test(full)) throw new Error("App data folders can't be added.");
  let st; try { st = fs.statSync(full); } catch { throw new Error("That folder doesn't exist."); }
  if (!st.isDirectory()) throw new Error("That is a file, not a folder.");
  return full;
}

// ---------- reading text out of files ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
// a small zip reader (docx, pptx and xlsx are zip files): name -> Buffer
function unzip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const n = buf.readUInt16LE(e + 10), out = {}; let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString("utf8"); p += 46 + nl + xl + cl;
    if (!/\.xml$/i.test(name)) continue;
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), data = buf.slice(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    try { out[name] = method === 8 ? zlib.inflateRawSync(data) : data; } catch {}
  }
  return out;
}
const xmlText = (x, para) => unent(String(x).replace(new RegExp(`</(${para})>`, "g"), "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
let pdfjs = null;
async function pdfPages(buf) {
  pdfjs = pdfjs || (await import("pdfjs-dist/legacy/build/pdf.mjs"));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 500); i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(" ").replace(/[ \t]+/g, " ").trim());
  }
  await doc.destroy();
  return pages;
}
// [{ text, page }] for a file ("page" is a page or slide number where it helps)
async function extract(file) {
  const ext = path.extname(file).slice(1).toLowerCase(), buf = fs.readFileSync(file);
  if (ext === "pdf") return (await pdfPages(buf)).map((t, i) => ({ text: t, page: i + 1 }));
  if (ext === "docx") { const z = unzip(buf); return [{ text: xmlText(z["word/document.xml"] || "", "w:p") }]; }
  if (ext === "pptx") { const z = unzip(buf); return Object.keys(z).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))).map((n) => ({ text: xmlText(z[n], "a:p"), page: parseInt(n.match(/\d+/)) })); }
  if (ext === "xlsx") { const z = unzip(buf); return [{ text: xmlText(z["xl/sharedStrings.xml"] || "", "si") }]; }
  let t = buf.toString("utf8");
  if (/^html?$/.test(ext)) t = unent(t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ");
  return [{ text: t }];
}
// passages of about CHUNK characters, cut at paragraph or sentence ends where possible
function chunks(parts) {
  const out = [];
  for (const { text, page } of parts) {
    const t = String(text || "").replace(/\r/g, "").trim(); if (t.length < 20) continue;
    for (let i = 0; i < t.length;) {
      let end = Math.min(t.length, i + CHUNK);
      if (end < t.length) { const cut = Math.max(t.lastIndexOf("\n", end), t.lastIndexOf(". ", end)); if (cut > i + CHUNK * 0.5) end = cut + 1; }
      const c = t.slice(i, end).trim(); if (c.length >= 20) out.push({ t: c, p: page || 0 });
      if (end >= t.length) break; i = Math.max(end - OVERLAP, i + 1);
    }
  }
  return out;
}

// ---------- embeddings ----------
async function embed(texts) {
  const r = await fetch(OLLAMA + "/api/embed", { method: "POST", body: JSON.stringify({ model: MODEL, input: texts, truncate: true }), signal: AbortSignal.timeout(300000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(/not found/i.test(j.error || "") ? `The search model isn't on this PC yet (${MODEL}). Download it in Settings → Tools → Documents.` : j.error || "HTTP " + r.status);
  return j.embeddings.map((v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); });
}
const pack = (f32) => Buffer.from(f32.buffer).toString("base64");
const unpack = (b64) => { const b = Buffer.from(b64, "base64"); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
let vecCache = null;                                  // the unpacked embeddings, for searching
async function hasModel() { try { const j = await (await fetch(OLLAMA + "/api/tags")).json(); return (j.models || []).some((m) => m.name.split(":")[0] === MODEL); } catch { return false; } }

// ---------- indexing (in the background; the website polls the status) ----------
function walk(dir, list) {
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (list.length >= MAX_FILES) return;
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name) && !e.name.startsWith(".")) walk(p, list); }
    else if (EXT.test(e.name) && !e.name.startsWith("~$")) list.push(p);
  }
}
async function runIndex(note) {
  if (state.running) return;
  Object.assign(state, { running: true, done: 0, total: 0, file: "", error: "", added: 0, removed: 0 });
  try {
    loadIndex();
    if (!(await hasModel())) throw new Error(`The search model isn't on this PC yet (${MODEL}). Download it in Settings → Tools → Documents.`);
    const files = []; for (const f of config().folders) walk(f, files);
    const keep = new Set(files);
    for (const f of Object.keys(index.files)) if (!keep.has(f)) { delete index.files[f]; state.removed++; }
    const todo = files.filter((f) => { try { const st = fs.statSync(f); const old = index.files[f]; return st.size <= MAX_BYTES && (!old || old.mtime !== st.mtimeMs || old.size !== st.size); } catch { return false; } });
    state.total = todo.length;
    let sinceSave = 0;
    for (const f of todo) {
      state.file = path.basename(f);
      try {
        const st = fs.statSync(f), cs = chunks(await extract(f));
        for (let i = 0; i < cs.length; i += 32) { const vs = await embed(cs.slice(i, i + 32).map((c) => `title: ${path.basename(f)} | text: ${c.t}`)); vs.forEach((v, k) => (cs[i + k].e = pack(v))); }
        index.files[f] = { mtime: st.mtimeMs, size: st.size, chunks: cs }; state.added++;
      } catch (e) { if (/search model/.test(e.message)) throw e; index.files[f] = { mtime: -1, size: -1, chunks: [], error: e.message.slice(0, 120) }; }
      state.done++; vecCache = null;
      if (++sinceSave >= 25) { saveIndex(); sinceSave = 0; }
    }
    saveIndex(); vecCache = null;
    note && note(`Documents: indexed ${state.added} file${state.added === 1 ? "" : "s"}${state.removed ? `, ${state.removed} gone` : ""}`);
  } catch (e) { state.error = e.message; }
  finally { state.running = false; state.file = ""; state.finished = Date.now(); }
}
function search(q, vec, k) {
  loadIndex();
  if (!vecCache) { vecCache = []; for (const [f, x] of Object.entries(index.files)) for (const c of x.chunks || []) if (c.e) vecCache.push({ f, c, v: unpack(c.e) }); }
  const hits = vecCache.map((h) => { let s = 0; for (let i = 0; i < vec.length; i++) s += vec[i] * h.v[i]; return { h, s }; }).sort((a, b) => b.s - a.s);
  const out = [], perFile = {}, floor = Math.max(0.2, (hits[0]?.s || 0) * 0.55);   // weak matches only add noise
  for (const { h, s } of hits) {                      // at most 3 passages from one file, so several files can speak
    if (out.length >= k || s < floor) break; if ((perFile[h.f] = (perFile[h.f] || 0) + 1) > 3) continue;
    out.push({ file: path.basename(h.f), path: h.f, page: h.c.p || 0, text: h.c.t, score: Math.round(s * 1000) / 1000 });
  }
  return out;
}

async function handle(method, p, body, note, opts) {
  if (opts && opts.ollama) OLLAMA = opts.ollama;
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  try {
    if (p === "/agent/docs/status") {
      loadIndex(); const files = Object.values(index.files);
      return [200, { folders: config().folders, home: os.homedir(), model: MODEL, hasModel: await hasModel(), files: files.filter((x) => x.chunks.length).length, failed: files.filter((x) => x.error).length, passages: files.reduce((n, x) => n + x.chunks.length, 0), ...state }];
    }
    if (p === "/agent/docs/folders") {
      const list = (Array.isArray(j.folders) ? j.folders : []).slice(0, 20).map(checkFolder);
      fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify({ folders: [...new Set(list)] }, null, 2));
      return [200, { folders: config().folders }];
    }
    if (p === "/agent/docs/index") { runIndex(note); return [200, { started: true }]; }
    if (p === "/agent/docs/pull") {
      const r = await fetch(OLLAMA + "/api/pull", { method: "POST", body: JSON.stringify({ model: MODEL, stream: false }), signal: AbortSignal.timeout(1800000) });
      const x = await r.json().catch(() => ({})); if (!r.ok || x.error) throw new Error(x.error || "The download failed");
      note && note(`Documents: downloaded the search model ${MODEL}`); return [200, { ok: true }];
    }
    if (p === "/agent/docs/search") {
      const q = String(j.q || "").trim().slice(0, 2000); if (!q) throw new Error("Ask something");
      loadIndex(); if (!Object.keys(index.files).length) throw new Error("No documents yet: pick folders in Settings → Tools → Documents.");
      const [v] = await embed(["task: search result | query: " + q]);
      return [200, { results: search(q, v, Math.max(1, Math.min(12, Number(j.k) || 6))) }];
    }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown documents request" }];
}
module.exports = { handle, extract, chunks, unzip, _test: { runIndex, state } };
