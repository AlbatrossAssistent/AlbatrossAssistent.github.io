// Better web search: SearXNG (github.com/searxng/searxng, AGPL-3.0), a search engine that asks Google, Brave, Bing, Wikipedia and
// others at once and merges what they find. It runs only on this PC (127.0.0.1), from its own folder:
//   <LocalAppData>\Albatross\searxng\   venv\ (its own Python packages)   src\ (SearXNG itself)   settings.yml   shim\pwd.py
// One click in Settings → Tools → Add-ons installs it (about 60 MB); after that the AI's web searches go through it first, and the
// old way (DuckDuckGo's page, which often answers with a captcha) is only the fallback. It starts with the first search and stops
// after an hour without one.
//   /agent/searxng/status -> {installed, running, install: {running, step, error}}     /agent/searxng/get     /agent/searxng/remove
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const DIR = process.env.ALB_SEARXNG_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "searxng");
const PORT = Number(process.env.ALB_SEARXNG_PORT) || 8890, BASE = `http://127.0.0.1:${PORT}`;
const VPY = path.join(DIR, "venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const SRC = path.join(DIR, "src"), SETTINGS = path.join(DIR, "settings.yml"), SHIM = path.join(DIR, "shim");
const TARBALL = "https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz";
const installed = () => fs.existsSync(VPY) && fs.existsSync(path.join(SRC, "searx", "webapp.py")) && fs.existsSync(SETTINGS) && fs.existsSync(path.join(DIR, "ready"));
const inst = { running: false, step: "", error: "" };
let child = null, starting = null, lastUsed = 0;

// the Python that makes the venv: same search as the voice helper (the plain "python" can be the Microsoft Store stub)
function findPython() {
  if (process.env.ALBATROSS_PYTHON) return process.env.ALBATROSS_PYTHON;
  const base = path.join(process.env.LOCALAPPDATA || "", "Python");
  try { for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "python.exe"); if (fs.existsSync(p)) return p; } } catch {}
  return "python";
}
const run = (cmd, args, opts = {}) => new Promise((ok, fail) => execFile(cmd, args, { windowsHide: true, maxBuffer: 64e6, timeout: 15 * 60e3, ...opts },
  (e, out, err) => e ? fail(new Error((String(err || "").trim().split(/\r?\n/).pop() || e.message).slice(0, 240))) : ok(String(out))));

// SearXNG is written for Linux: it imports the Unix-only "pwd" module for one error message. This stands in for it.
const PWD_SHIM = 'import collections, getpass\n_P = collections.namedtuple("struct_passwd", "pw_name pw_passwd pw_uid pw_gid pw_gecos pw_dir pw_shell")\n' +
  'def getpwuid(uid):\n    return _P(getpass.getuser(), "x", 0, 0, "", "", "")\n';
const settingsYml = (secret) => `use_default_settings: true
general:
  instance_name: "Albatross search"
server:
  bind_address: "127.0.0.1"
  port: ${PORT}
  secret_key: "${secret}"
  limiter: false
  image_proxy: false
search:
  safe_search: 1
  formats: [html, json]
valkey:
  url: false
`;

async function install(note) {
  if (inst.running || installed()) return;
  Object.assign(inst, { running: true, step: "Starting…", error: "" });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { if (fs.statfsSync(DIR).bavail * fs.statfsSync(DIR).bsize < 1e9) throw new Error("Not enough free disk space (it needs about 300 MB while installing)"); } catch (e) { if (/disk space/.test(e.message)) throw e; }
    inst.step = "Downloading SearXNG…";
    const tgz = path.join(DIR, "searxng.tar.gz");
    const r = await fetch(TARBALL, { headers: { "User-Agent": "Albatross-Desktop" }, signal: AbortSignal.timeout(300e3) });
    if (!r.ok) throw new Error("The download failed (" + r.status + ")");
    fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    inst.step = "Unpacking…";
    fs.rmSync(SRC, { recursive: true, force: true }); fs.mkdirSync(SRC, { recursive: true });
    // Windows' own tar can't make the few Unix links in it (example web server configs): those are skipped, which is fine
    // (Windows' own tar.exe by its full path: a GNU tar from Git would read "C:\..." as a network address)
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    await run(tar, ["-xzf", tgz, "-C", SRC, "--strip-components=1"]).catch(() => {});
    fs.rmSync(tgz, { force: true });
    if (!fs.existsSync(path.join(SRC, "searx", "webapp.py"))) throw new Error("The download wasn't complete. Try again.");
    inst.step = "Making its own Python folder…";
    if (!fs.existsSync(VPY)) await run(findPython(), ["-m", "venv", path.join(DIR, "venv")]);
    inst.step = "Installing what it needs (a minute or two)…";
    await run(VPY, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", path.join(SRC, "requirements.txt")]);
    fs.mkdirSync(SHIM, { recursive: true }); fs.writeFileSync(path.join(SHIM, "pwd.py"), PWD_SHIM);
    if (!fs.existsSync(SETTINGS)) fs.writeFileSync(SETTINGS, settingsYml(crypto.randomBytes(24).toString("hex")));
    inst.step = "Trying a search…";
    fs.writeFileSync(path.join(DIR, "ready"), new Date().toISOString());
    const test = await search("open source search engine", 3).catch((e) => { throw new Error("It installed, but the test search failed: " + e.message); });
    if (!test.length) throw new Error("It installed, but the test search found nothing");
    note && note("Search: installed SearXNG");
  } catch (e) { inst.error = e.message; try { fs.rmSync(path.join(DIR, "ready"), { force: true }); } catch {} }
  finally { inst.running = false; inst.step = ""; }
}

const alive = () => child && child.exitCode === null && !child.killed;
const up = () => fetch(BASE + "/healthz", { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
function start() {
  if (starting) return starting;
  starting = (async () => {
    if (await up()) return;
    if (!alive()) {
      child = spawn(VPY, ["-m", "searx.webapp"], { cwd: DIR, windowsHide: true, stdio: "ignore",
        env: { ...process.env, SEARXNG_SETTINGS_PATH: SETTINGS, PYTHONPATH: SHIM + path.delimiter + SRC, PYTHONIOENCODING: "utf-8" } });
      child.on("exit", () => { child = null; });
    }
    for (let i = 0; i < 60; i++) { if (await up()) return; if (!alive()) break; await new Promise((r) => setTimeout(r, 500)); }
    throw new Error("SearXNG didn't start");
  })().finally(() => { starting = null; });
  return starting;
}
function stop() { if (alive()) { try { child.kill(); } catch {} } child = null; }
setInterval(() => { if (alive() && Date.now() - lastUsed > 3600e3) stop(); }, 60e3).unref();
process.on("exit", stop);

// [{title, url, content}] like freesearch.js, best first
async function search(query, max = 6) {
  query = String(query || "").trim().slice(0, 300);
  if (!query) throw new Error("Empty query");
  if (!installed()) throw new Error("SearXNG isn't installed");
  lastUsed = Date.now();
  await start();
  const r = await fetch(`${BASE}/search?format=json&q=${encodeURIComponent(query)}`, { headers: { "X-Real-IP": "127.0.0.1" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("SearXNG answered " + r.status);
  const j = await r.json();
  const seen = new Set(), out = [];
  for (const x of j.results || []) {
    if (!/^https?:\/\//.test(x.url || "") || seen.has(x.url)) continue;
    seen.add(x.url);
    out.push({ title: String(x.title || x.url).slice(0, 200), url: x.url, content: String(x.content || "").replace(/\s+/g, " ").slice(0, 600) });
    if (out.length >= max) break;
  }
  return out;
}

async function handle(method, p, body, note) {
  try {
    if (p === "/agent/searxng/status") return [200, { installed: installed(), running: alive(), sizeBytes: 60e6, install: { ...inst } }];
    if (p === "/agent/searxng/get") { install(note); return [200, { started: true }]; }
    if (p === "/agent/searxng/remove") {
      if (inst.running) throw new Error("It is installing: wait until it is done");
      stop(); await new Promise((r) => setTimeout(r, 800));
      fs.rmSync(DIR, { recursive: true, force: true });
      return [200, { removed: true }];
    }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown search request" }];
}
module.exports = { handle, search, installed, stop };
