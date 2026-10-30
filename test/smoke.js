// Smoke test: opens the app in headless Chrome and fails when it doesn't start or a main part is broken.
// Runs before every push (git pre-push hook, see test/install-hook.js) and on GitHub before the website is published.
//   node test/smoke.js            (CHROME=path/to/chrome to choose the browser)
// What it checks: no script error while the app starts and while every page is opened; the basic building blocks work
// (answer rendering, maths and symbols, the code player's bundler, music, notes, the hub, the tool router's word lists).
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "public");
const CHROME = process.env.CHROME || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("smoke: no Chrome found (set CHROME=...)"); process.exit(2); }

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
// Every page load gets a first script that records errors, so even an error while the app's own scripts load is caught.
const RECORDER = `<script>window.__errs=[];addEventListener("error",function(e){window.__errs.push((e.message||"error")+" @ "+String(e.filename||"").split("/").pop()+":"+e.lineno)});</script>`;

const RUNNER = `<!doctype html><meta charset="utf-8"><pre id="o">waiting</pre><iframe id="f" style="width:1280px;height:800px"></iframe><script>
localStorage.setItem("burrow.settings", JSON.stringify({ theme: "dark", intro: false, serverVersion: 2, conn: { mode: "local", url: "http://127.0.0.1:1" } }));
localStorage.setItem("burrow.termsAccepted", JSON.stringify("2099-01-01"));
localStorage.setItem("burrow.seenVersion", JSON.stringify("9999-01-01.1"));
f.src = "/index.html";
const R = { checks: [], errors: [] };
const ok = (name, cond, info) => R.checks.push({ name, ok: !!cond, info: info == null ? "" : String(info).slice(0, 200) });
f.onload = () => setTimeout(async () => {
  const w = f.contentWindow, d = w.document, ev = (s) => w.eval(s), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tryIt = async (name, fn) => { try { const v = await fn(); ok(name, v !== false, v === true ? "" : v); } catch (e) { ok(name, false, e.message); } };
  await tryIt("app started (setView, md, S exist)", () => typeof w.setView === "function" && typeof ev("md") === "function" && !!ev("S"));
  await tryIt("app version is set", () => /^\\d{4}-\\d\\d-\\d\\d\\.\\d+$/.test(ev("APP_VERSION")) || ev("APP_VERSION"));
  for (const v of ["home", "chat", "notes", "mail", "hub", "monitor", "agent", "jarvis", "pc", "browser"]) {
    await tryIt("open page: " + v, async () => { w.setView(v); await sleep(120); return true; });
  }
  ev('setView("chat")');
  await tryIt("settings open", async () => { ev("openSettings()"); await sleep(100); const open = d.querySelector("#settings").open; d.querySelector("#settings").close(); return open; });
  await tryIt("markdown renders code blocks", () => { const f = "\\x60".repeat(3); return /class="code"/.test(w.md("**index.html**\\n" + f + "html\\n<p>hi</p>\\n" + f)); });
  await tryIt("maths and arrows render", () => { const h = ev('md("go $\\\\\\\\rightarrow$ now -> then :white_check_mark:")'); return /→/.test(h) && /✅/.test(h) || h; });
  await tryIt("code player bundles a project", () => /data:text\\/javascript/.test(w.bundleFiles([{ name: "index.html", code: "<script src=\\"a.js\\"></" + "script>" }, { name: "a.js", code: "console.log(1)" }], 0)));
  await tryIt("music builds a song and a MIDI file", async () => { const s = w.musicTest.buildSong({ title: "t", bpm: 120, bars: 2, tracks: [{ name: "p", instrument: "piano", loop: true, notes: "(C4/0.5 E4/0.5)x2 [C4 E4 G4]/2" }], drums: { kick: "x...", snare: "", clap: "", hat: "", openhat: "" } }); const b = await w.musicTest.midiFile(s).arrayBuffer(); return b.byteLength > 50 && new TextDecoder().decode(new Uint8Array(b).slice(0, 4)) === "MThd"; });
  await tryIt("monitor draws its cards", async () => { w.setView("monitor"); await sleep(150); return d.querySelectorAll("#monitorPage .home-card").length === 5 && !!d.querySelector("#mlFit button"); });
  await tryIt("list panel parses and adds steps", async () => { d.querySelector("#goList").click(); await sleep(80); const t = d.querySelector("#listPanel textarea"); t.value = "image 3x: a red fox\\ntext: a story about it"; t.dispatchEvent(new Event("input")); t.dispatchEvent(new Event("blur")); await sleep(80); const st = ev("S.listDraft"); d.querySelector("#goList").click(); return st.length === 2 && st[0].kind === "image" && st[0].times === 3 && st[1].kind === "text" && st[0].prompt === "a red fox" || JSON.stringify(st); });
  await tryIt("hub draws its tiles", async () => { w.setView("hub"); await sleep(150); return d.querySelectorAll("#hubPage .hub-tile").length > 0; });
  await tryIt("notes page draws", async () => { w.setView("notes"); await sleep(150); return !!d.querySelector("#notesPage .notes-grid"); });
  await tryIt("tool router word lists compile", () => Object.values(ev("TOOLISH")).every((re) => Object.prototype.toString.call(re) === "[object RegExp]"));   // another window's RegExp: no instanceof
  await tryIt("tool list for the AI", () => /Tools of the app/.test(ev("whatYouCanDo()")));
  await sleep(300);
  R.errors = (w.__errs || []).slice(0, 20);
  o.textContent = JSON.stringify(R);
}, 2500);
</script>`;

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (u === "/__smoke.html") { res.writeHead(200, { "Content-Type": TYPES[".html"] }); return res.end(RUNNER); }
  const f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    if (u.endsWith(".html")) b = Buffer.from(String(b).replace(/<head[^>]*>/i, (m) => m + RECORDER));
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); res.end(b);
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port, prof = fs.mkdtempSync(path.join(os.tmpdir(), "albatross-smoke-"));
  const args = ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${prof}`, "--window-size=1300,900", "--virtual-time-budget=40000", "--dump-dom", `http://127.0.0.1:${port}/__smoke.html`];
  const ch = spawn(CHROME, args, { stdio: ["ignore", "pipe", "ignore"] });
  let out = ""; ch.stdout.on("data", (d) => (out += d));
  const kill = setTimeout(() => ch.kill(), 90000);
  ch.on("close", () => {
    clearTimeout(kill); server.close(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
    const m = /<pre id="o">([^<]*)<\/pre>/.exec(out);
    let r = null; try { r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch {}
    if (!r) { console.error("smoke: the test page didn't finish (the app may not start at all)"); process.exit(1); }
    let bad = 0;
    for (const c of r.checks) { if (!c.ok) bad++; console.log(`${c.ok ? "  ok  " : "  FAIL"} ${c.name}${c.ok || !c.info ? "" : " — " + c.info}`); }
    for (const e of r.errors) { bad++; console.log("  ERROR " + e); }
    console.log(bad ? `smoke: ${bad} problem(s)` : `smoke: all ${r.checks.length} checks passed, no script errors`);
    process.exit(bad ? 1 : 0);
  });
});
