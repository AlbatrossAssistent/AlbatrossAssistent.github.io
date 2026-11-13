"use strict";
// Guest mode recaps: after each guest chat (or chat turn), the AI on this PC writes a short recap for the PC's owner,
// including every file made by this PC (generated pictures in Downloads\Albatross\Pictures, code/files written to
// Downloads\Albatross\Code) and never files or pictures attached by the guest user.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const codeTool = require("./code");

const DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".albatross"), "Albatross");
const STORE_FILE = path.join(DIR, "guest-recaps.json");
const PICS_DIR = path.join(process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross"), "Pictures");
const MAX_RECAPS = 100;

let recaps = null; // loaded on first use
const pendingFiles = new Map(); // chatId (or "_last") -> Array<fileObj>

function load() {
  if (recaps) return recaps;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    recaps = Array.isArray(raw) ? raw : [];
    for (const r of recaps) { r.recapBusy = false; delete r.busyModel; }   // a description cut off by a restart isn't running anymore
  } catch {
    recaps = [];
  }
  return recaps;
}

function save() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = STORE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(load().slice(0, MAX_RECAPS), null, 2));
    fs.renameSync(tmp, STORE_FILE);
  } catch {}
}

function cleanId(id) {
  const s = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return s || "guest-" + Date.now().toString(36);
}

// Verify a file path really lives inside Downloads\Albatross (Pictures or Code) and exists on disk
function isPcMadePath(fullPath) {
  if (!fullPath || typeof fullPath !== "string") return false;
  const resolved = path.resolve(fullPath);
  const picsRoot = path.resolve(PICS_DIR);
  const codeRoot = path.resolve(codeTool.ROOT);
  return (resolved.startsWith(picsRoot + path.sep) || resolved.startsWith(codeRoot + path.sep)) && fs.existsSync(resolved);
}

function normalizeFile(f) {
  if (!f || typeof f !== "object") return null;
  let fullPath = f.path ? path.resolve(String(f.path)) : "";
  if (!fullPath && f.rel) {
    const rel = String(f.rel).replace(/\\/g, "/");
    if (rel.startsWith("Pictures/")) fullPath = path.join(PICS_DIR, path.basename(rel));
    else if (rel.startsWith("Code/")) fullPath = path.join(codeTool.ROOT, ...rel.slice(5).split("/").filter(Boolean));
  }
  if (!isPcMadePath(fullPath)) return null;
  let size = Number(f.size) || 0;
  try { if (!size) size = fs.statSync(fullPath).size; } catch {}
  const ext = path.extname(fullPath).toLowerCase();
  const kind = f.kind || (/^\.(png|jpg|jpeg|webp|gif)$/i.test(ext) ? "image" : "code");
  const name = String(f.name || path.basename(fullPath)).slice(0, 140);
  const rel = fullPath.startsWith(path.resolve(PICS_DIR))
    ? "Pictures/" + path.basename(fullPath)
    : "Code/" + path.relative(path.resolve(codeTool.ROOT), fullPath).replace(/\\/g, "/");
  return {
    id: f.id || crypto.createHash("sha1").update(fullPath).digest("hex").slice(0, 12),
    kind,
    name,
    rel,
    path: fullPath,
    size,
    prompt: f.prompt ? String(f.prompt).slice(0, 240) : undefined,
    model: f.model ? String(f.model).slice(0, 80) : undefined,
    createdAt: f.createdAt || Date.now(),
  };
}

function attachFileToEntry(entry, rawFile) {
  const nf = normalizeFile(rawFile);
  if (!nf) return;
  if (!Array.isArray(entry.files)) entry.files = [];
  const idx = entry.files.findIndex((x) => x.path === nf.path || x.id === nf.id);
  if (idx >= 0) entry.files[idx] = { ...entry.files[idx], ...nf };
  else entry.files.push(nf);
}

// Called by host.js when the PC creates a file during a guest session (e.g. ComfyUI image or /code/write)
function recordPcFile(chatId, rawFile) {
  const nf = normalizeFile(rawFile);
  if (!nf) return null;
  const cid = chatId ? cleanId(chatId) : "_last";
  const list = pendingFiles.get(cid) || [];
  if (!list.some((x) => x.path === nf.path)) list.push(nf);
  pendingFiles.set(cid, list);
  // If a recap entry already exists for this chat, attach it right away too
  const all = load();
  const existing = chatId ? all.find((r) => r.id === cid) : all[0];
  if (existing) {
    attachFileToEntry(existing, nf);
    existing.updatedAt = Date.now();
    save();
  }
  return nf;
}

// Save AI-generated files from assistant replies (e.g. code blocks, slides JSON, music JSON) into Downloads\Albatross\Code\guest-<id>\
// Never saves user-inserted files!
function saveAssistantArtifacts(chatId, aiFiles) {
  if (!Array.isArray(aiFiles) || !aiFiles.length) return [];
  const folder = "guest-" + cleanId(chatId).slice(-10).toLowerCase();
  const toWrite = [];
  for (const af of aiFiles.slice(0, 30)) {
    if (!af || af.fromUser || af.role === "user") continue; // safety check: never user-inserted files
    const name = String(af.name || "").trim();
    const content = typeof af.content === "string" ? af.content : "";
    if (!name || !content) continue;
    toWrite.push({ path: name, content });
  }
  if (!toWrite.length) return [];
  const [st, out] = codeTool.handle("POST", "/code/write", JSON.stringify({ project: folder, files: toWrite }), () => {});
  if (st !== 200 || !out || !Array.isArray(out.written)) return [];
  return out.written.map((w) => ({
    kind: "code",
    name: `${out.project}/${w.path}`,
    path: path.join(out.folder, ...w.path.split("/")),
    rel: `Code/${out.project}/${w.path}`,
    size: w.size,
  }));
}

// Strip any user-attached file content ("[File: name]\n...") from a user message so user-inserted files aren't echoed into recaps
function cleanUserText(text) {
  let s = String(text || "");
  // In app.js, attached text files are prepended or appended as `[File: filename]\n...` or similar; strip large pasted file blocks if marked
  s = s.replace(/\[Attached file:[^\]]*\]/gi, "").trim();
  return s.slice(0, 2000);
}

function buildFallbackRecap(messages, files) {
  const userMsgs = messages.filter((m) => m.role === "user").map((m) => cleanUserText(m.text || m.content || "")).filter(Boolean);
  const asstMsgs = messages.filter((m) => m.role === "assistant").map((m) => String(m.text || m.content || "").trim()).filter(Boolean);
  const parts = [];
  if (userMsgs.length === 1) parts.push(`Guest asked: “${userMsgs[0].slice(0, 180)}${userMsgs[0].length > 180 ? "…" : ""}”`);
  else if (userMsgs.length > 1) parts.push(`Guest sent ${userMsgs.length} messages, starting with “${userMsgs[0].slice(0, 120)}${userMsgs[0].length > 120 ? "…" : ""}” and most recently “${userMsgs[userMsgs.length - 1].slice(0, 120)}${userMsgs[userMsgs.length - 1].length > 120 ? "…" : ""}”.`);
  if (asstMsgs.length) {
    const lastA = asstMsgs[asstMsgs.length - 1].replace(/\s+/g, " ");
    parts.push(`AI reply: ${lastA.slice(0, 220)}${lastA.length > 220 ? "…" : ""}`);
  }
  if (files && files.length) {
    const pics = files.filter((f) => f.kind === "image").length;
    const other = files.length - pics;
    const fdesc = [pics ? `${pics} generated picture${pics > 1 ? "s" : ""}` : "", other ? `${other} generated file${other > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
    parts.push(`Made on this PC: ${fdesc} (${files.map((f) => f.name).slice(0, 5).join(", ")}).`);
  }
  return parts.join(" ") || "Guest session on this PC.";
}

async function pickRecapModel(preferredModel, ollamaUrl, isComfy, allowLoad) {
  const text = (n) => n && !isComfy(n) && !/embed/i.test(n);
  try {
    const ps = await (await fetch(ollamaUrl + "/api/ps", { signal: AbortSignal.timeout(2000) })).json();
    const loaded = (ps.models || []).map((m) => m.name).filter(text);
    if (preferredModel && loaded.includes(preferredModel)) return preferredModel;
    if (!allowLoad) return loaded[0] || "";
    // asked for by the owner: the model they picked may be loaded for it (or, if that's a picture model, a warm text model, else any)
    const tags = await (await fetch(ollamaUrl + "/api/tags", { signal: AbortSignal.timeout(4000) })).json();
    const all = (tags.models || []).map((m) => m.name).filter(text);
    if (preferredModel && all.includes(preferredModel)) return preferredModel;
    return loaded[0] || all[0] || "";
  } catch {}
  return "";
}

// The owner's "Describe" button (PC tab → Guest chats): reads the chat saved on this PC, so it works after the guest has left,
// and keeps running here even if the owner closes the page. Loads the owner's chosen model if it isn't in memory yet.
async function generateAiRecap(entry, ctx, opts = {}) {
  const ollamaUrl = ctx?.ollama || "http://127.0.0.1:11434";
  const isComfy = ctx?.comfy ? (n) => ctx.comfy.isComfy(n) : () => false;
  const messages = Array.isArray(entry.messages) ? entry.messages : [];
  if (!messages.length) { entry.aiError = "This chat's messages weren't saved on the PC (it's from before this feature)."; save(); ctx?.changed?.(); return; }
  const model = await pickRecapModel(opts.model, ollamaUrl, isComfy, !!opts.allowLoad);
  if (!model) { entry.aiError = "No text model is available on this PC."; save(); ctx?.changed?.(); return; }
  entry.recapBusy = true; entry.busyModel = model; delete entry.aiError;
  ctx?.changed?.();
  try {
    const transcript = messages.slice(-24).map((m) => {
      if (m.role === "user") return `Guest: ${cleanUserText(m.text || "(message)")}`;
      const extra = m.genImage ? ` [Generated picture: ${m.prompt || ""}]` : "";
      return `AI: ${String(m.text || "").slice(0, 1200)}${extra}`;
    }).join("\n\n");
    const fileLines = (entry.files || []).map((f) => `- ${f.name} (${f.kind === "image" ? "generated picture" + (f.prompt ? ": " + f.prompt : "") : "file made by PC"})`).join("\n");
    const prompt = `Write a short, plain-English description (2 to 4 sentences) for the PC owner of this guest chat on their PC. State what the guest asked for or worked on and how the AI answered. Mention anything the owner should know about (inappropriate, harmful or unusual requests) plainly.${fileLines ? "\n\nFiles made by the PC during this chat:\n" + fileLines : ""}\n\nChat transcript:\n${transcript}`;
    const res = await fetch(ollamaUrl + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, stream: false, think: false,
        options: { draft_num_predict: 0, temperature: 0.3, num_predict: 260 },
        messages: [
          { role: "system", content: "You write brief, factual descriptions of guest chats for the PC owner. 2 to 4 sentences, plain text, no markdown headings." },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(opts.allowLoad ? 300000 : 45000),   // loading a big model from disk can take minutes
    });
    const j = await res.json().catch(() => ({}));
    const text = String(j?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (text) { entry.aiRecap = text; entry.aiModel = model; entry.aiAt = Date.now(); entry.recap = text; }
    else entry.aiError = j.error ? String(j.error).slice(0, 200) : "The model gave no answer.";
  } catch (e) { entry.aiError = e.name === "TimeoutError" ? "It took too long (the model may still be loading). Try again." : String(e.message || e).slice(0, 200); }
  finally {
    entry.recapBusy = false; delete entry.busyModel;
    save();
    ctx?.changed?.();
  }
}
function describe(id, model, ctx) {
  const entry = load().find((r) => r.id === id);
  if (!entry) return [404, { error: "That guest chat isn't on this PC anymore." }];
  if (entry.recapBusy) return [200, { ok: true, busy: true }];
  generateAiRecap(entry, ctx, { model: String(model || "").slice(0, 120), allowLoad: true }).catch(() => {});
  return [200, { ok: true, busy: true }];
}

// the guest's messages, kept on this PC (newest 40; text only, never files the guest attached). A full copy from the guest's page
// replaces what's there; the PC's own shorter copy (made when the guest left mid-answer) only adds what's new.
function mergeMessages(old, neu) {
  old = Array.isArray(old) ? old : [];
  if (neu.length >= old.length) return neu.slice(-40);
  const same = (a, b) => a && b && a.role === b.role && a.text === b.text;
  const add = neu.filter((m) => !old.slice(-neu.length - 2).some((o) => same(o, m)));
  return old.concat(add).slice(-40);
}

// Upsert a recap entry after a guest chat turn and kick off the AI summary
function upsertRecap(payload, ctx) {
  const all = load();
  const cid = cleanId(payload.chatId);
  let entry = all.find((r) => r.id === cid);
  const now = Date.now();
  if (!entry) {
    entry = {
      id: cid,
      title: String(payload.title || "Guest chat").slice(0, 100),
      createdAt: now,
      updatedAt: now,
      turns: 0,
      model: String(payload.model || "").slice(0, 80),
      recap: "",
      recapBusy: false,
      files: [],
    };
    all.unshift(entry);
  } else {
    // Move to top
    const idx = all.indexOf(entry);
    if (idx > 0) { all.splice(idx, 1); all.unshift(entry); }
    if (payload.title && payload.title !== "New chat" && payload.title !== "Guest chat") {
      entry.title = String(payload.title).slice(0, 100);
    }
    if (payload.model) entry.model = String(payload.model).slice(0, 80);
    entry.updatedAt = now;
  }

  // Drain any pending PC-made files recorded on the host for this chatId or "_last"
  for (const key of [cid, "_last"]) {
    const list = pendingFiles.get(key);
    if (list && list.length) {
      for (const f of list) attachFileToEntry(entry, f);
      pendingFiles.delete(key);
    }
  }

  // Attach any explicitly reported PC-made files (verified on disk inside Pictures or Code)
  if (Array.isArray(payload.pcFiles)) {
    for (const f of payload.pcFiles) attachFileToEntry(entry, f);
  }

  // Save any AI-generated code/artifact files from assistant messages (never user messages!)
  if (Array.isArray(payload.aiFiles) && payload.aiFiles.length) {
    const written = saveAssistantArtifacts(cid, payload.aiFiles);
    for (const f of written) attachFileToEntry(entry, f);
  }

  const rawMsgs = Array.isArray(payload.messages) ? payload.messages : [];
  // Filter messages: strip user-inserted file attachments, keep only user prompt text and assistant responses
  const messages = rawMsgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      text: m.role === "user" ? cleanUserText(m.text || m.content || "") : String(m.text || m.content || "").slice(0, 3000),
      genImage: m.role === "assistant" ? !!m.genImage : false,
      prompt: m.role === "assistant" && m.prompt ? String(m.prompt).slice(0, 240) : undefined,
    }));

  const asstCount = messages.filter((m) => m.role === "assistant").length;
  entry.turns = Math.max(entry.turns + 1, asstCount || 1);
  if ((!entry.title || entry.title === "New chat" || entry.title === "Guest chat") && messages.length) {
    const firstU = messages.find((m) => m.role === "user" && m.text);
    if (firstU) entry.title = firstU.text.slice(0, 48);
  }

  // the chat is kept on this PC, so the owner can have it described later even when the guest is gone
  if (messages.length) {
    const before = JSON.stringify(entry.messages || []);
    entry.messages = mergeMessages(entry.messages, messages.map((m) => ({ ...m, text: String(m.text || "").slice(0, 2000) })));
    if (JSON.stringify(entry.messages) !== before) entry.lastMsgAt = now;
  }
  // a quick summary right away; the AI description only when the owner asks for it (Describe)
  entry.quick = buildFallbackRecap(entry.messages || messages, entry.files);
  entry.recap = entry.aiRecap || entry.quick;
  save();
  ctx?.changed?.();
  return entry;
}

function handleGuestEndpoint(method, p, body, ctx) {
  let j = {};
  try { j = JSON.parse(body || "{}"); } catch {}
  if (p === "/guest/status") return [200, { guest: !!ctx?.guest }];
  if (method === "POST" && p === "/guest/recap") {
    const entry = upsertRecap(j, ctx);
    ctx?.note?.(`Guest recap updated: “${entry.title}” (${entry.files.length} PC file${entry.files.length === 1 ? "" : "s"})`);
    return [200, { ok: true, id: entry.id }];
  }
  return [404, { error: "Unknown guest request" }];
}

function listForOwner() {
  return load().map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    turns: r.turns,
    model: r.model,
    recap: r.aiRecap || r.quick || r.recap,
    summary: r.aiRecap || r.quick || r.recap,
    recapBusy: !!r.recapBusy,
    busyModel: r.busyModel || "",
    described: !!r.aiRecap,
    describedWith: r.aiModel || "",
    describedAt: r.aiAt || 0,
    stale: !!(r.aiRecap && r.lastMsgAt && r.aiAt < r.lastMsgAt),
    canDescribe: Array.isArray(r.messages) && r.messages.length > 0,
    aiError: r.aiError || "",
    files: (r.files || []).filter((f) => isPcMadePath(f.path)).map((f) => ({
      id: f.id,
      kind: f.kind,
      name: f.name,
      rel: f.rel,
      size: f.size,
      prompt: f.prompt,
      model: f.model,
      createdAt: f.createdAt,
    })),
  }));
}

function getFile(recapId, fileId) {
  const r = load().find((x) => x.id === recapId);
  if (!r || !Array.isArray(r.files)) return null;
  const f = r.files.find((x) => x.id === fileId || x.name === fileId);
  if (!f || !isPcMadePath(f.path)) return null;
  return f;
}

function readFileData(recapId, fileId) {
  const f = getFile(recapId, fileId);
  if (!f) return [404, { error: "File not found on this PC." }];
  try {
    const buf = fs.readFileSync(f.path);
    const ext = path.extname(f.path).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "text/plain; charset=utf-8";
    if (f.kind === "image") {
      return [200, { id: f.id, name: f.name, kind: "image", mime, data: buf.toString("base64"), size: buf.length, prompt: f.prompt }];
    }
    return [200, { id: f.id, name: f.name, kind: f.kind, mime, text: buf.slice(0, 500 * 1024).toString("utf8"), data: buf.slice(0, 2 * 1024 * 1024).toString("base64"), size: buf.length }];
  } catch (e) {
    return [500, { error: e.message }];
  }
}

function deleteRecap(id) {
  const all = load();
  const idx = all.findIndex((r) => r.id === id);
  if (idx >= 0) { all.splice(idx, 1); save(); }
  return { ok: true };
}

function clearRecaps() {
  recaps = [];
  save();
  return { ok: true };
}

module.exports = {
  recordPcFile,
  upsertRecap,
  handleGuestEndpoint,
  listForOwner,
  getFile,
  readFileData,
  deleteRecap,
  clearRecaps,
  describe,
};
