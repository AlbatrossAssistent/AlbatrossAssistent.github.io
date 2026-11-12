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
  await tryIt("home has AI modes and manual task shortcuts", () => {
    w.setView("home");
    return !!d.querySelector(".home-feature [data-go=chat]") && !!d.querySelector(".home-feature [data-go=agent]")
      && !!d.querySelector(".home-action[data-go=beam]") && !!d.querySelector(".home-action[data-go=mail]")
      && !!d.querySelector(".home-action[data-go=print]")
      && !!d.querySelector(".home-hero h1") && !!d.querySelector("#homeManual")
      && !!d.querySelector(".home-hero [data-scroll=homeManual]")
      && !!(d.querySelector("#homeManual").compareDocumentPosition(d.querySelector(".home-feature")) & w.Node.DOCUMENT_POSITION_FOLLOWING)
      && d.querySelector("#homeManual .home-action").getBoundingClientRect().top < w.innerHeight
      && d.querySelectorAll("#homeManual .home-action").length === 4 && !!d.querySelector("#homeManual .ai-panel textarea")
      && d.querySelector(".home-more").open && !!d.querySelector(".home-action[data-go=jarvis]");
  });
  await tryIt("background is a restrained night sky", () => {
    w.dispatchEvent(new w.MouseEvent("pointermove", { clientX: 120, clientY: 240 }));
    return w.getComputedStyle(d.body).backgroundColor === "rgb(0, 0, 0)"
      && w.getComputedStyle(d.querySelector("#sky")).opacity === "0.62"
      && w.getComputedStyle(d.querySelector("#orbs")).display === "none";
  });
  await tryIt("appearance names black and white themes", () => {
    const options = [...d.querySelectorAll("#theme option")].map((o) => o.textContent);
    return options.includes("White (light mode)") && options.includes("Black (dark mode)");
  });
  await tryIt("light background shapes fall, collide and can be dragged", async () => {
    Object.defineProperty(d, "hidden", { configurable: true, get: () => false });
    ev('S.theme = "light"; applyAppearance()');
    const tiles = [...d.querySelectorAll("#orbs i")], mid = (t) => { const r = t.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const starts = tiles.map((t) => mid(t)[1]);
    ev("polygonField.advance(.6)");
    const fallen = tiles.some((t, i) => mid(t)[1] > starts[i] + 10);
    const tile = tiles[tiles.length - 1], [x, y] = mid(tile);
    tile.dispatchEvent(new w.PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 7 }));
    const held = tile.classList.contains("dragging");
    w.dispatchEvent(new w.PointerEvent("pointermove", { bubbles: true, clientX: x + 160, clientY: y + 60, pointerId: 7 }));
    ev("polygonField.advance(.6)");
    const [x2] = mid(tile), dragged = held && x2 > x + 40;
    w.dispatchEvent(new w.PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
    const ok = w.getComputedStyle(d.body).backgroundColor === "rgb(255, 255, 255)"
      && w.getComputedStyle(d.querySelector("#orbs")).display === "block"
      && tiles.length >= 8 && !!tile.querySelector("svg path") && fallen && dragged;
    if (!ok) throw new Error(JSON.stringify({ n: tiles.length, fallen, held, dragged, x, x2, display: w.getComputedStyle(d.querySelector("#orbs")).display }));
    return true;
  });
  await tryIt("Beam: devices tab, private contacts, notifications from the top", async () => {
    ev('openFiles("people")');
    await sleep(150);
    const ok1 = !!d.querySelector("#addForm #cidInput") && !d.querySelector("#pubOn") && !d.querySelector("#peopleList") && !!d.querySelector("#devList") && !!d.querySelector("#contactList");
    ev('notify("smoke", { title: "Smoke test", text: "card", actions: [["OK", () => {}, true]] })');
    ev('toast("Hello from the top")');
    await sleep(400);
    const card = d.querySelector('#offers [data-key="smoke"]'), t = d.querySelector("#toast").getBoundingClientRect();
    const ok2 = !!card && card.getBoundingClientRect().top < 200 && t.top < 120;
    ev('notify("smoke", null); document.querySelector("#filesDlg").close()');
    if (!(ok1 && ok2)) throw new Error(JSON.stringify({ ok1, ok2, card: !!card, cardTop: card && card.getBoundingClientRect().top, toastTop: t.top }));
    return true;
  });
  await tryIt("no WhatsApp section; Print is a manual dialog, not the Agent", async () => {
    w.setView("home"); await sleep(80);
    if (d.querySelector("#waForm") || /whatsapp/i.test(d.querySelector("#home").textContent)) return "WhatsApp still on the home page";
    d.querySelector('.home-action[data-go=print]').click(); await sleep(150);
    const dlg = d.querySelector("#printDlg"), ok = dlg.open && !d.body.classList.contains("agent-view") && !!d.querySelector("#prPrinter") && d.querySelector("#prGo").disabled;
    ev('prChoose({ name: "letter.pdf", size: 1234, blob: new Blob(["x"]), from: "This device" })');
    const chosen = !d.querySelector("#prChosen").hidden && /letter.pdf/.test(d.querySelector("#prChosen").textContent);
    dlg.close();
    return (ok && chosen) || JSON.stringify({ open: dlg.open, ok, chosen });
  });
  await tryIt("mail: manual reply/forward plus the Agent beside it; icon rail; gold sparks", async () => {
    w.setView("mail"); await sleep(150);
    const src = ev("String(window.mailOpen)");
    ev('appSky.draw(1000, { palette: "gold", dark: true }); appSky.draw(1100, { palette: "gold", dark: false }); appSky.draw(1200, { palette: "night" })');
    ev("S.sideRail = true; applyRail()"); const railOk = w.getComputedStyle(d.querySelector("#goHome")).fontSize === "0px" && d.querySelector("#sidebar").getBoundingClientRect().width < 90; ev("S.sideRail = false; applyRail()");
    if (!railOk) return "closed sidebar still shows labels";
    if (!d.querySelector("#mailPage .mail-ai textarea")) return "no Agent next to the mail";
    return !!d.querySelector("#mlNew") && !d.querySelector("#mlAsk") && !/AI next to it/.test(d.querySelector("#mailPage").textContent) || "AI parts still in Mail";
  });
  ev('setView("chat")');
  await tryIt("the version shows in the sidebar", () => /Version d{4}-dd-dd.d+/.test(d.querySelector("#appVer").textContent) || d.querySelector("#appVer").textContent);
  await tryIt("settings open", async () => { ev("openSettings()"); await sleep(100); const open = d.querySelector("#settings").open; d.querySelector("#settings").close(); return open; });
  await tryIt("markdown renders code blocks", () => { const f = "\\x60".repeat(3); return /class="code"/.test(w.md("**index.html**\\n" + f + "html\\n<p>hi</p>\\n" + f)); });
  await tryIt("maths and arrows render", () => { const h = ev('md("go $\\\\\\\\rightarrow$ now -> then :white_check_mark:")'); return /→/.test(h) && /✅/.test(h) || h; });
  await tryIt("code player bundles a project", () => /data:text\\/javascript/.test(w.bundleFiles([{ name: "index.html", code: "<script src=\\"a.js\\"></" + "script>" }, { name: "a.js", code: "console.log(1)" }], 0)));
  await tryIt("music builds a song and a MIDI file", async () => { const s = w.musicTest.buildSong({ title: "t", bpm: 120, bars: 2, tracks: [{ name: "p", instrument: "piano", loop: true, notes: "(C4/0.5 E4/0.5)x2 [C4 E4 G4]/2" }], drums: { kick: "x...", snare: "", clap: "", hat: "", openhat: "" } }); const b = await w.musicTest.midiFile(s).arrayBuffer(); return b.byteLength > 50 && new TextDecoder().decode(new Uint8Array(b).slice(0, 4)) === "MThd"; });
  await tryIt("monitor draws its cards", async () => { w.setView("monitor"); await sleep(150); return d.querySelectorAll("#monitorPage .home-card").length === 5 && !!d.querySelector("#mlFit button"); });
  await tryIt("list panel parses and adds steps", async () => { d.querySelector("#goList").click(); await sleep(80); const t = d.querySelector("#spList textarea"); if (d.querySelector("#sidePanel").hidden || d.querySelector("#sidePanel").dataset.tab !== "list") return "List tab not open in the side panel"; t.value = "image 3x: a red fox\\ntext: a story about it"; t.dispatchEvent(new Event("input")); t.dispatchEvent(new Event("blur")); await sleep(80); const st = ev("S.listDraft"); const into = d.querySelector("#lpInto") && d.querySelector("#lpTarget").textContent; d.querySelector("#goList").click(); if (!into) return "no Into choice"; return st.length === 2 && st[0].kind === "image" && st[0].times === 3 && st[1].kind === "text" && st[0].prompt === "a red fox" || JSON.stringify(st); });
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
