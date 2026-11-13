// Installing and removing Ollama models from the app (Settings → Installed models). The models are Ollama's (kept in its own
// folder, usually C:\Users\<you>\.ollama\models), not the app's: updating or reinstalling Albatross never touches them.
// A download runs here on the PC and keeps going if the page closes; the app asks for the progress (GET /pc/modelpull).

const pulls = new Map();     // name -> { name, status, completed, total, done, error, started, ctrl }
const NAME = /^[a-z0-9][a-z0-9._\-/]{0,80}(:[a-z0-9._\-]{1,60})?$/i;
const cloud = (n) => /-cloud$|:cloud$|-cloud:/.test(n);

function list() {
  return [...pulls.values()].map(({ ctrl, ...p }) => p);
}

function start(name, ollama, note) {
  name = String(name || "").trim().toLowerCase().replace(/^ollama\s+(pull|run)\s+/, "");
  if (!NAME.test(name)) throw new Error("That isn't a model name. Names look like qwen3:14b or gemma4:12b (see ollama.com/library).");
  if (cloud(name)) throw new Error("Cloud models run on Ollama's servers, not this PC, so they're turned off here.");
  const old = pulls.get(name);
  if (old && !old.done) return old;
  const p = { name, status: "Starting…", completed: 0, total: 0, done: false, error: "", started: Date.now(), ctrl: new AbortController() };
  pulls.set(name, p);
  note && note("Models: downloading " + name);
  (async () => {
    try {
      const r = await fetch(ollama + "/api/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, stream: true }), signal: p.ctrl.signal });
      if (!r.ok && !r.body) throw new Error("Ollama answered " + r.status);
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.error) throw new Error(/not found|does not exist|manifest/i.test(o.error) ? "Ollama doesn't know a model called " + name + ". Check the name on ollama.com/library." : o.error);
          if (o.status) p.status = o.status;
          if (o.total) { p.total = o.total; p.completed = o.completed || 0; }
        }
      }
      p.status = "Installed"; p.completed = p.total;
      note && note("Models: " + name + " is installed");
    } catch (e) {
      p.error = e.name === "AbortError" ? "Cancelled" : e.message || String(e);
    } finally { p.done = true; p.ended = Date.now(); }
  })();
  return p;
}

async function remove(name, ollama, note) {
  name = String(name || "").trim();
  if (!NAME.test(name)) throw new Error("That isn't a model name.");
  const r = await fetch(ollama + "/api/delete", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name }) });
  if (!r.ok) { let m = ""; try { m = (await r.json()).error; } catch {} throw new Error(m || "Ollama answered " + r.status); }
  note && note("Models: removed " + name);
  return { ok: true };
}

// GET /pc/modelpull → the downloads; POST /pc/modelpull { name } starts one, { name, cancel: true } stops it; POST /pc/modeldelete { name }
async function handle(method, p, body, ollama, note) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  if (p === "/pc/modelpull") {
    if (method === "POST" && j.cancel) { const x = pulls.get(String(j.name || "")); if (x && !x.done) x.ctrl.abort(); return [200, { pulls: list() }]; }
    if (method === "POST" && j.clear) { for (const [k, x] of pulls) if (x.done) pulls.delete(k); return [200, { pulls: list() }]; }
    if (method === "POST") { start(j.name, ollama, note); return [200, { pulls: list() }]; }
    return [200, { pulls: list() }];
  }
  if (p === "/pc/modeldelete") return [200, await remove(j.name, ollama, note)];
  return [404, { error: "Unknown models request" }];
}
// finished downloads are forgotten after an hour
setInterval(() => { for (const [k, x] of pulls) if (x.done && Date.now() - x.ended > 3600e3) pulls.delete(k); }, 600e3).unref();

module.exports = { handle };
