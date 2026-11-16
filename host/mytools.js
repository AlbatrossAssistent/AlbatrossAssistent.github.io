// Your own tools on this PC. They show up in the website's chat (and the Chrome sidebar) whenever it is connected to this PC,
// for you and nobody else (guest mode never reaches /agent/). The AI sees them as pc_<name>.
//
// Three kinds of tool, and where each may come from:
//   prompt   a text with {{input}} gaps that goes back to the AI to follow          website or file
//   http     calls a web address (a service, an API) with the inputs filled in      website or file
//   script   runs a Node script from the tools folder                               FILE ONLY
//   MCP      "mcp.json" in the tools folder connects MCP servers (the open-source tool collections: files, memory, git, search...)  FILE ONLY
// Nothing the website sends is ever run as a program: a tool made on the website can only be a prompt or a call to a public https
// address (never this PC or your home network), and it can't replace a tool that comes from a file. Programs (script, MCP) only run
// because you put them in the folder yourself.
//
// The folder: host/my-tools (or ALBATROSS_TOOLS). One <name>.json per tool. Examples: host/tools-examples.
//   /agent/mytools/list    -> { tools: [{ name, description, kind, source, schema }], servers: [...], dir }
//   /agent/mytools/run     { name, args } -> { result }
//   /agent/mytools/get     { name } -> the tool (header values hidden), for the editor
//   /agent/mytools/save    { tool }   (prompt and http only)
//   /agent/mytools/delete  { name }   (only tools made on the website)

const fs = require("fs");
const path = require("path");
const net = require("net");
const dns = require("dns").promises;
const { spawn } = require("child_process");

const DIR = process.env.ALBATROSS_TOOLS || path.join(process.env.ALBATROSS_DATA || __dirname, "my-tools");
const OUT_MAX = 8000, TOOLS_MAX = 60, SERVERS_MAX = 8, MASK = "(kept)";
const slug = (s, n = 34) => { let t = String(s || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, n); if (t && !/^[a-z]/.test(t)) t = "t_" + t; return t; };
let note = () => {};

// ---------- tool files ----------
function cleanParams(list) {
  const seen = new Set(), out = [];
  for (const p of (Array.isArray(list) ? list : []).slice(0, 10)) {
    if (!p || typeof p !== "object") continue;
    const name = String(p.name || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_$&").slice(0, 31);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, type: ["string", "number", "boolean"].includes(p.type) ? p.type : "string", description: String(p.description || "").slice(0, 200), required: !!p.required });
  }
  return out;
}
// one tool, checked: throws a plain sentence when something's wrong. fromFile: it was written by the owner on this PC.
function clean(x, fromFile) {
  if (!x || typeof x !== "object") throw new Error("That isn't a tool.");
  const name = slug(x.name), description = String(x.description || "").trim().slice(0, 600);
  if (!name) throw new Error("Give the tool a name.");
  if (!description) throw new Error("Say what the tool does: the AI reads it to know when to use it.");
  const kind = x.kind;
  if (!["prompt", "http", "script"].includes(kind)) throw new Error("The kind must be prompt, http or script.");
  if (kind === "script" && !fromFile) throw new Error("Scripts can only be put in the tools folder on the PC, not made from the website.");
  const t = { name, description, kind, params: cleanParams(x.params) };
  if (kind === "prompt") { t.text = String(x.text || "").slice(0, 20000); if (!t.text.trim()) throw new Error("The tool has no text yet."); }
  if (kind === "http") {
    t.url = String(x.url || "").trim().slice(0, 1000); t.method = String(x.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
    let u; try { u = new URL(t.url.split("{{").join("x").split("}}").join("")); } catch { throw new Error("The web address isn't valid (it must start with https://)."); }
    if (u.protocol !== "https:" && !(fromFile && u.protocol === "http:")) throw new Error("The web address must start with https://.");
    t.body = String(x.body || "").slice(0, 5000);
    t.headers = {};
    for (const [k, v] of Object.entries(x.headers && typeof x.headers === "object" ? x.headers : {}).slice(0, 10)) if (/^[A-Za-z0-9-]{1,40}$/.test(k)) t.headers[k] = String(v).slice(0, 500);
  }
  if (kind === "script") { t.file = String(x.file || ""); if (!/^[A-Za-z0-9_.-]{1,80}$/.test(t.file) || !/[.](js|mjs|cjs)$/.test(t.file) || t.file.includes("..")) throw new Error("The script must be a .js file in the tools folder."); }
  return t;
}
function readDefs() {
  const out = [];
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && !/^mcp([.]|$)/i.test(f)).sort(); } catch { return out; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      const t = clean(j, j.origin !== "app");
      t.origin = j.origin === "app" ? "app" : "file"; t.id = f;
      if (!out.some((o) => o.name === t.name)) out.push(t);
    } catch {}
  }
  return out.slice(0, TOOLS_MAX);
}
const schemaOf = (params) => ({ type: "object", properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}) }])), required: params.filter((p) => p.required).map((p) => p.name) });
const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v));
function fill(text, args, enc) {
  let s = String(text);
  for (const [k, v] of Object.entries(args || {})) s = s.split("{{" + k + "}}").join(enc(asText(v == null ? "" : v)));
  return s.split("{{").length > 1 ? s.replace(/[{][{][A-Za-z0-9_]+[}][}]/g, "") : s;
}

// ---------- calling a web address ----------
function privateIp(ip) {
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); if (l.startsWith("::ffff:") && net.isIPv4(l.slice(7))) return privateIp(l.slice(7)); return l === "::1" || l === "::" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l); }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function mustBePublic(u) {
  if (u.protocol !== "https:") throw new Error("Tools made on the website can only call https addresses.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error("That web address can't be found.");
  if (addrs.some(privateIp)) throw new Error("Tools made on the website can't call this PC or your home network. Put the tool in the tools folder on the PC instead.");
}
async function runHttp(t, args) {
  const u = new URL(fill(t.url, args, encodeURIComponent));
  const fromApp = t.origin === "app";
  if (fromApp) await mustBePublic(u);
  const headers = { "User-Agent": "Albatross", ...t.headers };
  const opts = { method: t.method, headers, redirect: fromApp ? "manual" : "follow", signal: AbortSignal.timeout(20000) };
  if (t.method === "POST") { opts.body = t.body ? fill(t.body, args, (x) => x) : JSON.stringify(args || {}); if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json"; }
  const r = await fetch(u, opts);
  if (fromApp && r.status >= 300 && r.status < 400) throw new Error("That address redirects somewhere else; tools made on the website don't follow redirects.");
  const text = (await r.text()).slice(0, OUT_MAX);
  if (!r.ok) throw new Error("The service answered HTTP " + r.status + ": " + text.slice(0, 300));
  return text || "(empty answer)";
}

// ---------- running a script from the folder ----------
function runScript(t, args) {
  const file = path.join(DIR, t.file);
  if (path.relative(DIR, file).startsWith("..") || !fs.existsSync(file)) return Promise.reject(new Error("The script " + t.file + " isn't in the tools folder."));
  return new Promise((ok, no) => {
    const keep = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"], env = {};
    for (const k of keep) if (process.env[k]) env[k] = process.env[k];
    const c = spawn(process.execPath, [file], { cwd: DIR, windowsHide: true, env });
    let out = "", err = "", done = false;
    const end = (f) => { if (done) return; done = true; clearTimeout(timer); f(); };
    const timer = setTimeout(() => { try { c.kill(); } catch {} end(() => no(new Error("The script took longer than 30 seconds and was stopped."))); }, 30000);
    c.stdout.on("data", (d) => { if (out.length < OUT_MAX) out += d; });
    c.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
    c.on("error", (e) => end(() => no(e)));
    c.on("close", (code) => end(() => code === 0 ? ok(out.trim().slice(0, OUT_MAX) || "(no output)") : no(new Error("The script failed" + (err.trim() ? ": " + err.trim().split("\n").slice(-3).join(" ").slice(0, 400) : " (exit code " + code + ")")))));
    c.stdin.on("error", () => {});
    c.stdin.end(JSON.stringify(args || {}));
  });
}

// ---------- MCP servers (mcp.json) ----------
// { "servers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/me/Documents"] } } }
// Each server is started once, asked for its tools, and kept running. Talks the standard MCP protocol over the program's stdin/stdout.
class Mcp {
  constructor(name, cfg) { Object.assign(this, { name, cfg, state: "starting", error: "", tools: [], id: 0, pending: new Map(), buf: "", child: null, ready: null }); this.ready = this.start(); this.ready.catch(() => {}); }
  fail(msg) { this.state = "failed"; this.error = String(msg).slice(0, 300); for (const p of this.pending.values()) p.no(new Error(this.error)); this.pending.clear(); try { this.child && this.child.kill(); } catch {} }
  send(o) { if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(o) + String.fromCharCode(10)); }
  request(method, params, ms = 60000) {
    return new Promise((ok, no) => {
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); no(new Error("The tool server didn't answer in time.")); }, ms);
      this.pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, no: (e) => { clearTimeout(timer); no(e); } });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  onLine(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && !m.method) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.no(new Error(m.error.message || "error")) : p.ok(m.result); } }
    else if (m.id != null) this.send({ jsonrpc: "2.0", id: m.id, ...(m.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Not supported" } }) });
  }
  async start() {
    const c = this.cfg, win = process.platform === "win32";
    const q = (a) => (win && /[ ]/.test(a) ? '"' + a + '"' : a);
    let err = "";
    this.child = spawn(q(String(c.command || "")), (Array.isArray(c.args) ? c.args : []).map((a) => q(String(a))), { shell: win, windowsHide: true, cwd: DIR, env: { ...process.env, ...(c.env && typeof c.env === "object" ? c.env : {}) } });
    this.child.on("error", (e) => this.fail("Couldn't start: " + e.message));
    this.child.on("exit", (code) => { if (this.state !== "failed") { this.state = "stopped"; this.error = "The server stopped (exit code " + code + ")" + (err.trim() ? ": " + err.trim().split(String.fromCharCode(10)).slice(-2).join(" ").slice(0, 200) : ""); } for (const p of this.pending.values()) p.no(new Error(this.error)); this.pending.clear(); });
    this.child.stderr.on("data", (d) => { err = (err + d).slice(-1500); });
    this.child.stdout.on("data", (d) => { this.buf += d; let i; while ((i = this.buf.indexOf(String.fromCharCode(10))) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (line) this.onLine(line); } });
    try {
      await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "albatross", version: "1" } }, 180000);   // the first start of an npx server downloads it
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      let cursor, tools = [];
      for (let i = 0; i < 5; i++) { const r = await this.request("tools/list", cursor ? { cursor } : {}); tools.push(...(r.tools || [])); cursor = r.nextCursor; if (!cursor) break; }
      this.tools = tools.slice(0, 40); this.state = "ready";
    } catch (e) { this.fail(e.message); }
  }
  async call(tool, args) {
    if (this.state === "starting") await this.ready;
    if (this.state !== "ready") throw new Error(this.error || "The tool server isn't running.");
    const r = await this.request("tools/call", { name: tool, arguments: args || {} }, 90000);
    const text = (r.content || []).map((c) => (c.type === "text" ? c.text : "[" + c.type + "]")).join(String.fromCharCode(10)).slice(0, OUT_MAX);
    if (r.isError) throw new Error(text || "The tool failed.");
    return text || "(no output)";
  }
  stop() { try { this.child && this.child.kill(); } catch {} }
}
let servers = new Map(), mcpStamp = "";
function syncServers() {
  let stamp = "", cfg = {};
  try { const f = path.join(DIR, "mcp.json"); stamp = String(fs.statSync(f).mtimeMs); cfg = (JSON.parse(fs.readFileSync(f, "utf8")).servers) || {}; } catch {}
  if (stamp !== mcpStamp) {
    for (const s of servers.values()) s.stop();
    servers = new Map(); mcpStamp = stamp;
    for (const [name, c] of Object.entries(cfg).slice(0, SERVERS_MAX)) if (c && typeof c === "object" && c.command && slug(name)) servers.set(slug(name), new Mcp(slug(name), c));
  }
  // one that stopped or failed is started again the next time the list is asked for
  for (const [n, s] of servers) if (s.state === "stopped") { const c = s.cfg; servers.set(n, new Mcp(n, c)); }
}
function mcpTools() {
  const out = [];
  for (const s of servers.values()) for (const t of s.tools) {
    const sc = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {};
    out.push({ name: ("pc_" + s.name + "_" + slug(t.name, 30)).slice(0, 48), description: String(t.description || t.name).slice(0, 600), kind: "mcp", source: s.name, schema: { type: "object", properties: sc.properties && typeof sc.properties === "object" ? sc.properties : {}, required: Array.isArray(sc.required) ? sc.required : [] }, _server: s, _tool: t.name });
  }
  return out;
}

// ---------- the requests ----------
const all = () => {
  const defs = readDefs().map((t) => ({ name: "pc_" + t.name, description: t.description, kind: t.kind, source: t.origin === "app" ? "website" : "file", schema: schemaOf(t.params), _def: t }));
  const names = new Set(defs.map((d) => d.name)), m = mcpTools().filter((t) => !names.has(t.name));
  return [...defs, ...m].slice(0, TOOLS_MAX);
};
const pub = ({ name, description, kind, source, schema }) => ({ name, description, kind, source, schema });
const fileFor = (name) => path.join(DIR, slug(name) + ".json");

async function handle(method, p, body, noteFn) {
  if (noteFn) note = noteFn;
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  syncServers();

  if (p === "/agent/mytools/list") {
    const starting = [...servers.values()].filter((s) => s.state === "starting");
    if (starting.length) await Promise.race([Promise.allSettled(starting.map((s) => s.ready)), new Promise((r) => setTimeout(r, 3000))]);
    return [200, { tools: all().map(pub), dir: DIR, servers: [...servers.values()].map((s) => ({ name: s.name, state: s.state, error: s.error, tools: s.tools.length })) }];
  }
  if (p === "/agent/mytools/run") {
    const t = all().find((x) => x.name === String(j.name || ""));
    if (!t) return [404, { error: "There is no tool called " + j.name + " on this PC (any more)." }];
    const args = j.args && typeof j.args === "object" && !Array.isArray(j.args) ? j.args : {};
    note("My tools: " + t.name);
    let result;
    if (t.kind === "mcp") result = await t._server.call(t._tool, args);
    else if (t._def.kind === "prompt") result = fill(t._def.text, args, (x) => x).slice(0, OUT_MAX);
    else if (t._def.kind === "http") result = await runHttp(t._def, args);
    else result = await runScript(t._def, args);
    return [200, { result }];
  }
  if (p === "/agent/mytools/get") {
    const t = readDefs().find((x) => x.name === slug(j.name));
    if (!t) return [404, { error: "No such tool." }];
    const { id, ...rest } = t;
    return [200, { tool: { ...rest, ...(rest.headers ? { headers: Object.fromEntries(Object.keys(rest.headers).map((k) => [k, MASK])) } : {}), editable: t.origin === "app" } }];
  }
  if (p === "/agent/mytools/save") {
    const x = j.tool && typeof j.tool === "object" ? { ...j.tool } : {};
    const old = readDefs().find((d) => d.name === slug(x.name));
    if (old && old.origin !== "app") return [409, { error: "That tool comes from a file on this PC. Change it there." }];
    if (x.kind === "http" && old && old.kind === "http" && x.headers && typeof x.headers === "object") for (const [k, v] of Object.entries(x.headers)) if (v === MASK && old.headers[k] != null) x.headers[k] = old.headers[k];
    const t = clean(x, false);
    if (t.kind === "http") await mustBePublic(new URL(t.url.split("{{").join("x").split("}}").join("")));
    if (!old && readDefs().length >= TOOLS_MAX) return [409, { error: "That's the most tools you can have." }];
    fs.writeFileSync(fileFor(t.name), JSON.stringify({ ...t, origin: "app" }, null, 2));
    note("My tools: saved pc_" + t.name);
    return [200, { ok: true, name: "pc_" + t.name }];
  }
  if (p === "/agent/mytools/delete") {
    const old = readDefs().find((d) => d.name === slug(j.name));
    if (!old) return [404, { error: "No such tool." }];
    if (old.origin !== "app") return [409, { error: "That tool comes from a file on this PC. Delete the file to remove it." }];
    fs.unlinkSync(path.join(DIR, old.id));
    return [200, { ok: true }];
  }
  return [404, { error: "Unknown request" }];
}
function stopAll() { for (const s of servers.values()) s.stop(); }
process.on("exit", stopAll);

module.exports = { handle, clean, fill, privateIp, DIR, stopAll };
