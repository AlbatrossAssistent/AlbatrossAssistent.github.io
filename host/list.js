// Lists: several requests in a row, run on this PC one after the other, e.g. "picture: a red fox, 3 times", then
// "text: write a short story about it". They keep running when the website is closed or the phone sleeps. Every result goes
// into a chat on this PC (chats.js): the one that was open on the website (chatId), or a new one, so it shows up on every device.
// A step's prompt can use {previous}: the last text answer (so a text step can write the prompt for a picture step).
// Text steps see the conversation so far; a text model that can look at pictures also gets the pictures of the step before.
// Only one list runs at a time; more wait their turn. Lists belong to the account that started them (ctx.uid, see account.js):
// only that account sees them, and their chats are that account's.

const crypto = require("crypto");
const chatStore = require("./chats");

const lists = [];              // newest first
let running = null;
const MAX_STEPS = 30, MAX_TIMES = 20, KEEP = 20;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const clean = (s, n) => String(s || "").replace(/\r/g, "").slice(0, n);
function start(j, ctx) {
  const steps = (Array.isArray(j.steps) ? j.steps : []).slice(0, MAX_STEPS).map((s) => ({
    kind: s.kind === "image" ? "image" : "text",
    prompt: clean(s.prompt, 4000).trim(),
    times: Math.min(MAX_TIMES, Math.max(1, Math.round(Number(s.times) || 1))),
    model: clean(s.model, 200),
    done: 0, error: "",
  })).filter((s) => s.prompt);
  if (!steps.length) return [400, { error: "The list is empty: write at least one request." }];
  for (const s of steps) {
    if (!s.model) s.model = s.kind === "image" ? clean(j.imageModel, 200) : clean(j.textModel, 200);
    if (!s.model) return [400, { error: s.kind === "image" ? "Pick a picture model first (Settings → Image)." : "Pick a chat model first." }];
  }
  const img = j.image || {}, txt = j.text || {};
  const L = {
    id: crypto.randomBytes(8).toString("base64url"),
    title: clean(j.title, 120).trim() || "List: " + steps[0].prompt.slice(0, 60),
    chatId: ID.test(String(j.chatId || "")) ? j.chatId : "list" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
    uid: ctx.uid || "", steps, status: "waiting", created: Date.now(), started: 0, finished: 0, step: 0, rep: 0, progress: "", pct: null, error: "",
    image: {
      width: Math.min(2048, Math.max(256, Number(img.width) || 1024)), height: Math.min(2048, Math.max(256, Number(img.height) || 1024)),
      steps: Number(img.steps) || 0, seed: img.seed === "" || img.seed == null ? null : Number(img.seed), keepMinutes: Number(img.keepMinutes) || 10, style: clean(img.style, 2000).trim(),
    },
    text: { think: txt.think !== false, options: txt.options && typeof txt.options === "object" ? txt.options : {}, system: clean(txt.system, 8000), keepAlive: txt.keepAlive },
    ctrl: new AbortController(),
  };
  lists.unshift(L);
  ctx.note(`List: “${L.title}” queued (${steps.length} step${steps.length > 1 ? "s" : ""}, ${total(L)} request${total(L) > 1 ? "s" : ""})`);
  // forget old finished ones
  for (let i = lists.length - 1; i >= 0 && lists.length > KEEP; i--) if (lists[i].finished) lists.splice(i, 1);
  kick(ctx);
  return [200, { id: L.id, chatId: L.chatId }];
}
const total = (L) => L.steps.reduce((t, s) => t + s.times, 0);
const doneCount = (L) => L.steps.reduce((t, s) => t + s.done, 0);

function kick(ctx) {
  if (running) return;
  const next = [...lists].reverse().find((l) => l.status === "waiting");
  if (!next) return;
  running = next;
  run(next, ctx).catch(() => {}).finally(() => { running = null; kick(ctx); ctx.changed(); });
}

// The chat on this PC: read the newest copy before every change (a device may have renamed it or written in it), then add.
function save(L, add, ctx) {
  let chat = null;
  try { const [st, r] = chatStore.handle("POST", "/chats/get", JSON.stringify({ id: L.chatId }), () => {}, L.uid); if (st === 200) chat = r.chat; } catch {}
  if (!chat) chat = { id: L.chatId, title: L.title, type: L.steps[0].kind === "image" ? "image" : "chat", context: "", system: L.text.system || "", created: L.created, updated: Date.now(), pinned: false, messages: [] };
  if (!chat.messages.length && (!chat.title || chat.title === "New chat")) chat.title = L.title;   // an empty chat gets the list's name
  chat.messages.push(...add);
  chat.updated = Date.now();
  const [st, r] = chatStore.handle("POST", "/chats/put", JSON.stringify({ chat, force: true }), ctx.note, L.uid);
  if (st === 413) {      // too many pictures for one chat: carry on in a new one
    L.chatId = "list" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    L.part = (L.part || 1) + 1;
    const fresh = { ...chat, id: L.chatId, title: `${L.title} (part ${L.part})`, created: Date.now(), messages: add };
    chatStore.handle("POST", "/chats/put", JSON.stringify({ chat: fresh, force: true }), ctx.note, L.uid);
  } else if (st !== 200) throw new Error(r.error || "Couldn't save the chat");
  L.saved = Date.now();
}
function chatNow(L) {
  try { const [st, r] = chatStore.handle("POST", "/chats/get", JSON.stringify({ id: L.chatId }), () => {}, L.uid); if (st === 200) return r.chat.messages; } catch {}
  return [];
}

// Reads Ollama's (or the ComfyUI bridge's) answer line by line.
async function lines(res, each) {
  if (!res.ok) { let msg = ""; try { const t = await res.text(); msg = JSON.parse(t).error || t; } catch {} throw new Error(msg || "HTTP " + res.status); }
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { let o; try { o = JSON.parse(l); } catch { continue; } each(o); } }
  }
  if (buf.trim()) { try { each(JSON.parse(buf)); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
}
const capsCache = new Map();
async function caps(model, ctx) {
  if (capsCache.has(model)) return capsCache.get(model);
  let c = [];
  try { const r = await ctx.upstream("POST", "/api/show", JSON.stringify({ model }), AbortSignal.timeout(15000)); if (r.ok) c = (await r.json()).capabilities || []; } catch {}
  capsCache.set(model, c);
  return c;
}

async function picture(L, s, prompt, rep, ctx) {
  const I = L.image;
  const body = { model: s.model, prompt: [prompt, I.style].filter(Boolean).join(". "), stream: true, width: I.width, height: I.height, keepMinutes: I.keepMinutes };
  if (I.steps) body.steps = I.steps;
  if (Number.isFinite(I.seed) && I.seed !== null) body.seed = I.seed + rep;     // a fixed seed would draw the same picture every time
  const t0 = Date.now();
  let image = "";
  L.pct = null;
  const res = await ctx.upstream("POST", "/api/generate", JSON.stringify(body), L.ctrl.signal);
  await lines(res, (o) => {
    if (o.error) throw new Error(o.error);
    if (o.status) { L.progress = o.status; ctx.changed(); }
    if (o.total) { L.pct = Math.round((o.completed || 0) / o.total * 100); L.progress = "Drawing"; ctx.changed(); }
    const im = o.image || (o.images && o.images[0]);
    if (im) image = im;
  });
  if (!image) throw new Error("The model didn't return a picture");
  return { role: "assistant", content: "", genImage: image, prompt: body.prompt, asked: prompt, model: s.model, genAt: Date.now(), stats: `${s.model} · ${I.width}×${I.height} · ${((Date.now() - t0) / 1000).toFixed(1)}s · from a list` };
}

async function answer(L, s, history, images, ctx) {
  const c = await caps(s.model, ctx);
  const msgs = [];
  if (L.text.system) msgs.push({ role: "system", content: L.text.system });
  for (const m of history) {
    if (m.isError || m.isEvent) continue;
    if (m.genImage !== undefined) msgs.push({ role: "assistant", content: `[Picture made with ${m.model || "an image model"}: ${m.prompt || m.asked || ""}]` });
    else if (m.content) msgs.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
  }
  const last = msgs[msgs.length - 1];
  if (images.length && c.includes("vision") && last && last.role === "user") last.images = images.slice(-3);
  const body = { model: s.model, messages: msgs, stream: true, options: L.text.options };
  if (c.includes("thinking")) body.think = !!L.text.think;
  if (L.text.keepAlive !== undefined && L.text.keepAlive !== "") body.keep_alive = L.text.keepAlive;
  let content = "", thinking = "", stats = "";
  L.pct = null;
  const res = await ctx.upstream("POST", "/api/chat", JSON.stringify(body), L.ctrl.signal);
  await lines(res, (o) => {
    if (o.error) throw new Error(o.error);
    if (o.message?.thinking) { thinking += o.message.thinking; if (!content) { L.progress = "Thinking"; ctx.changed(); } }
    if (o.message?.content) { content += o.message.content; L.progress = `Writing · ${content.length} characters`; ctx.changed(); }
    if (o.done && o.eval_count && o.eval_duration) stats = `${s.model} · ${(o.eval_count / (o.eval_duration / 1e9)).toFixed(1)} tok/s · ${o.eval_count} tokens · from a list`;
  });
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!content) throw new Error("The model gave an empty answer");
  return { role: "assistant", content, model: s.model, stats: stats || `${s.model} · from a list`, ...(thinking ? { thinking } : {}) };
}

async function run(L, ctx) {
  L.status = "running"; L.started = Date.now();
  ctx.note(`List: started “${L.title}”`);
  save(L, [], ctx);
  let lastText = "", lastImages = [];
  try {
    for (let si = 0; si < L.steps.length; si++) {
      const s = L.steps[si];
      if (L.ctrl.signal.aborted) break;
      const prompt = s.prompt.replace(/\{previous\}/gi, lastText.slice(0, 3000));
      L.step = si; L.rep = 0; L.progress = "Starting"; ctx.changed();
      save(L, [{ role: "user", content: s.times > 1 ? `${prompt}\n\n(${s.kind === "image" ? "picture" : "answer"} × ${s.times}, from a list)` : prompt }], ctx);
      const before = chatNow(L);                         // the conversation up to this step: every repeat answers it afresh
      const images = [];
      for (let rep = 0; rep < s.times; rep++) {
        if (L.ctrl.signal.aborted) break;
        L.rep = rep; L.progress = "Starting"; ctx.changed();
        ctx.activity();
        try {
          if (s.kind === "image") { const m = await picture(L, s, prompt, rep, ctx); images.push(m.genImage); save(L, [m], ctx); }
          else {
            const hist = before.map((m, i) => (i === before.length - 1 && m.role === "user" ? { ...m, content: prompt } : m));
            const m = await answer(L, s, hist, lastImages, ctx); lastText = m.content; save(L, [m], ctx);
          }
          s.done++;
          ctx.note(`List “${L.title}”: ${s.kind === "image" ? "picture" : "answer"} ${rep + 1} of ${s.times} (step ${si + 1})`);
        } catch (e) {
          if (L.ctrl.signal.aborted || e.name === "AbortError") break;
          s.error = e.message;
          save(L, [{ role: "assistant", content: `Step ${si + 1} (${s.kind === "image" ? "picture" : "text"} ${rep + 1} of ${s.times}) failed: ${e.message}`, isError: true }], ctx);
          ctx.note(`List “${L.title}”: step ${si + 1} failed: ${e.message}`, "error");
        }
      }
      if (s.kind === "image" && images.length) lastImages = images;
    }
    L.status = L.ctrl.signal.aborted ? "stopped" : L.steps.some((s) => s.error) ? "finished with errors" : "done";
  } catch (e) {
    L.status = "failed"; L.error = e.message;
    ctx.note(`List “${L.title}” failed: ${e.message}`, "error");
  } finally {
    L.finished = Date.now(); L.progress = ""; L.pct = null;
    ctx.note(`List: “${L.title}” ${L.status} (${doneCount(L)} of ${total(L)})`);
  }
}

const view = (L) => ({
  id: L.id, title: L.title, chatId: L.chatId, status: L.status, created: L.created, started: L.started, finished: L.finished, saved: L.saved || 0,
  step: L.step, rep: L.rep, progress: L.progress, pct: L.pct, error: L.error, done: doneCount(L), total: total(L),
  steps: L.steps.map((s) => ({ kind: s.kind, prompt: s.prompt, times: s.times, model: s.model, done: s.done, error: s.error })),
});

// GET /pc/list or POST { action: "list" }: the account's lists (newest first). POST /pc/list { action: "start" | "stop" | "remove", ... }
function handle(method, body, ctx) {
  const uid = ctx.uid || "", mine = () => lists.filter((l) => l.uid === uid);
  const all = () => [200, { lists: mine().map(view), running: running && running.uid === uid ? running.id : "" }];
  if (method === "GET") return all();
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  if (j.action === "start") return start(j, ctx);
  const L = mine().find((l) => l.id === j.id);
  if (j.action === "stop") {
    if (!L) return [404, { error: "No such list" }];
    if (L.status === "waiting") { L.status = "stopped"; L.finished = Date.now(); }
    L.ctrl.abort(); ctx.note(`List: stopped “${L.title}”`); ctx.changed();
    return [200, { ok: true }];
  }
  if (j.action === "remove") {
    if (!L) return [200, { ok: true }];
    if (!L.finished) return [409, { error: "Stop it first" }];
    lists.splice(lists.indexOf(L), 1); return [200, { ok: true }];
  }
  if (j.action === "list" || !j.action) return all();
  return [400, { error: "Unknown list request" }];
}
const busy = () => !!running;

module.exports = { handle, busy };
