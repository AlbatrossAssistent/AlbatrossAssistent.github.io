// Chat requests that keep running on this PC when the device that sent them goes to the background (a phone locks, a tab sleeps).
// The website starts a job here instead of holding one long connection open, then picks up the answer in pieces ("poll") from
// wherever it left off. The model keeps working either way, and the finished answer is saved into the chat on this PC even if
// nobody picks it up (the app was closed), so the next device that opens the chat finds it.

const crypto = require("crypto");
const chatStore = require("./chats");

const jobs = new Map();       // id -> job
const KEEP_MS = 30 * 60e3;    // how long a finished answer waits to be picked up
const MAX_CHARS = 24e6;       // per job; a longer answer is cut, never the whole PC's memory

function start({ body, chatId, upstream, note, uid }) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  const id = crypto.randomBytes(9).toString("base64url");
  const ctrl = new AbortController();
  const job = { id, uid: uid || "", chatId: /^[A-Za-z0-9_-]{1,64}$/.test(String(chatId || "")) ? chatId : "", model: j.model || "", ctrl, lines: [], chars: 0, done: false, error: "", started: Date.now(), polled: Date.now(), content: "", thinking: "", stats: "", waiters: [] };
  jobs.set(id, job);
  const wake = () => { for (const w of job.waiters.splice(0)) w(); };
  const push = (line) => { job.lines.push(line); job.chars += line.length; wake(); };
  (async () => {
    try {
      const res = await upstream("POST", "/api/chat", body, ctrl.signal);
      if (!res.ok) {
        let msg = ""; try { const t = await res.text(); msg = (JSON.parse(t).error) || t; } catch {}
        throw new Error(msg || "HTTP " + res.status);
      }
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.message?.content) job.content += o.message.content;
            if (o.done && o.eval_count && o.eval_duration) job.stats = `${job.model} · ${(o.eval_count / (o.eval_duration / 1e9)).toFixed(1)} tok/s · ${o.eval_count} tokens`;
          } catch {}
          if (job.chars < MAX_CHARS) push(line);
        }
      }
      if (buf.trim()) push(buf);
    } catch (e) {
      if (e.name !== "AbortError") { job.error = e.message || String(e); push(JSON.stringify({ error: job.error })); }
      else job.cancelled = true;
    } finally {
      job.done = true; wake();
      // Nobody has been looking for a minute (the app was closed or killed in the background): keep the answer in the chat on this PC.
      setTimeout(() => saveOrphan(job, note), 65e3).unref();
    }
  })();
  return [200, { id }];
}

function saveOrphan(job, note) {
  if (job.saved || job.cancelled || job.error || !job.chatId || !job.content) return;
  if (Date.now() - job.polled < 60e3 && !job.taken) return;      // someone is still reading it
  if (job.taken) return;                                          // the device that asked got the whole answer
  try {
    const [st, r] = chatStore.handle("POST", "/chats/get", JSON.stringify({ id: job.chatId }), () => {}, job.uid);
    if (st !== 200) return;
    const chat = r.chat;
    chat.messages.push({ role: "assistant", content: job.content, model: job.model, stats: job.stats + " · finished on the PC while you were away" });
    chat.updated = Date.now();
    chatStore.handle("POST", "/chats/put", JSON.stringify({ chat, force: true }), () => {}, job.uid);
    job.saved = true;
    note && note("Chats: saved an answer that finished while the app was closed");
  } catch {}
}

// Returns the lines after `from`, waiting up to 20 s for new ones (so the device isn't asking every moment).
async function poll({ id, from }) {
  const job = jobs.get(id);
  if (!job) return [404, { error: "That request is gone (the PC restarted or it is too old)." }];
  job.polled = Date.now();
  from = Math.max(0, Number(from) || 0);
  if (job.lines.length <= from && !job.done) {
    await new Promise((res) => { const t = setTimeout(res, 20e3); job.waiters.push(() => { clearTimeout(t); res(); }); });
  }
  const lines = job.lines.slice(from, from + 400);
  const next = from + lines.length;
  const done = job.done && next >= job.lines.length;
  if (done) job.taken = true;
  return [200, { lines, next, done, error: done ? job.error : "" }];
}

function cancel({ id }) {
  const job = jobs.get(id); if (!job) return [200, { ok: true }];
  job.cancelled = true; job.ctrl.abort(); return [200, { ok: true }];
}
// The live way to read a job: lines flow as the model writes them, starting at line `from`. If the connection drops (a phone goes to sleep),
// the device simply attaches again from the last line it got. A line {"_ka":1} keeps proxies from closing a quiet connection, {"_end":true} says
// the answer is complete.
async function stream({ id, from }, write, signal) {
  const job = jobs.get(id);
  if (!job) return write(JSON.stringify({ error: "That request is gone (the PC restarted or it is too old)." }) + "\n");
  let i = Math.max(0, Number(from) || 0);
  for (;;) {
    if (signal && signal.aborted) return;
    job.polled = Date.now();
    if (i < job.lines.length) { write(job.lines.slice(i, i + 200).join("\n") + "\n"); i = Math.min(job.lines.length, i + 200); continue; }
    if (job.done) { job.taken = true; return write(JSON.stringify({ _end: true }) + "\n"); }
    await new Promise((res) => {
      const t = setTimeout(() => { res(); write(JSON.stringify({ _ka: 1 }) + "\n"); }, 15e3);
      const w = () => { clearTimeout(t); res(); };
      job.waiters.push(w);
      if (signal) signal.addEventListener("abort", w, { once: true });
    });
  }
}
// What is running now (the page shows "still working on the PC" after a reopen), for the account that asks
function list(uid) {
  return [200, { jobs: [...jobs.values()].filter((j) => j.uid === (uid || "")).map((j) => ({ id: j.id, chatId: j.chatId, model: j.model, done: j.done, started: j.started, chars: j.content.length })) }];
}

async function handle(method, p, body, ctx) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  if (p === "/jobs/start") return start({ body: typeof j.body === "string" ? j.body : JSON.stringify(j.body || {}), chatId: j.chatId, upstream: ctx.upstream, note: ctx.note, uid: ctx.uid });
  if (p === "/jobs/poll") return poll(j);
  if (p === "/jobs/cancel") return cancel(j);
  if (p === "/jobs/list") return list(ctx.uid);
  return [404, { error: "Unknown jobs request" }];
}
const active = () => [...jobs.values()].filter((j) => !j.done).length;
setInterval(() => { for (const [id, j] of jobs) if (j.done && Date.now() - j.started > KEEP_MS && Date.now() - j.polled > KEEP_MS) jobs.delete(id); }, 60e3).unref();

module.exports = { handle, active, stream };
