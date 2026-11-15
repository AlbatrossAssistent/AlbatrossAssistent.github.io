// The app's self-check: the same checks the developer smoke test runs (test/smoke.js, headless Chrome before every push), and
// the Windows app runs after every update on the user's PC (desktop/main.js), in a hidden window with a throwaway profile, so
// nothing of the user's chats or settings is touched. albatrossSelfTest(w) takes the app's window and returns { checks, errors }.
window.albatrossSelfTest = async function (w) {
  const d = w.document, ev = (s) => w.eval(s), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = { checks: [], errors: [] };
  const ok = (name, cond, info) => R.checks.push({ name, ok: !!cond, info: info == null ? "" : String(info).slice(0, 200) });
  const tryIt = async (name, fn) => { try { const v = await fn(); ok(name, v !== false, v === true ? "" : v); } catch (e) { ok(name, false, e.message); } };
  await tryIt("app started (setView, md, S exist)", () => typeof w.setView === "function" && typeof ev("md") === "function" && !!ev("S"));
  await tryIt("app version is set", () => /^\d{4}-\d\d-\d\d\.\d+$/.test(ev("APP_VERSION")) || ev("APP_VERSION"));
  for (const v of ["home", "chat", "notes", "mail", "hub", "monitor", "agent", "jarvis", "pc", "browser"]) {
    await tryIt("open page: " + v, async () => { w.setView(v); await sleep(120); return true; });
  }
  await tryIt("home has the chat (no Agent mode) and manual task shortcuts", () => {
    w.setView("home");
    return !!d.querySelector(".home-feature [data-go=chat]") && !d.querySelector("[data-go=agent]")
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
    // shapes land at random places: drag towards the side with room, so a shape resting against a wall can still move
    const dir = x > w.innerWidth / 2 ? -1 : 1;
    w.dispatchEvent(new w.PointerEvent("pointermove", { bubbles: true, clientX: x + 160 * dir, clientY: y - 60, pointerId: 7 }));
    ev("polygonField.advance(.6)");
    const [x2] = mid(tile), dragged = held && (x2 - x) * dir > 40;
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
  await tryIt("the version shows in the sidebar", () => /^Version \d{4}-\d\d-\d\d\.\d+$/.test(d.querySelector("#appVer").textContent) || "shows: " + d.querySelector("#appVer").textContent);
  await tryIt("tilt gravity is right whichever angle the browser reports", () => {
    const t = (beta, gamma, angle, land) => ev("polygonField").tilt(beta, gamma, angle, land).map((v) => Math.round(v * 100) / 100).join(",");
    const cases = [
      ["portrait upright", t(90, 0, 0, false), "0,1"],
      ["portrait, leaning back a little", t(45, 0, 0, false), "0,0.71"],
      ["tilted to the right, held flat", t(0, 30, 0, false), "0.5,0"],
      ["iOS-style: angle 90 in a tall window", t(90, 0, 90, false), "0,1"],
      ["angle 270 in a tall window", t(90, 0, 270, false), "0,1"],
      ["sideways, turned counter-clockwise", t(0, -90, 90, true), "0,1"],
      ["sideways, turned clockwise (-90)", t(0, 90, -90, true), "0,1"],
      ["angle 0 in a wide window", t(0, -90, 0, true), "0,1"],
    ];
    const bad = cases.filter(([, got, want]) => got !== want);
    return !bad.length || JSON.stringify(bad);
  });
  await tryIt("settings open", async () => { ev("openSettings()"); await sleep(100); const open = d.querySelector("#settings").open; d.querySelector("#settings").close(); return open; });
  await tryIt("markdown renders code blocks", () => { const f = "\x60".repeat(3); return /class="code"/.test(w.md("**index.html**\n" + f + "html\n<p>hi</p>\n" + f)); });
  await tryIt("maths and arrows render", () => { const h = ev('md("go $\\\\rightarrow$ now -> then :white_check_mark:")'); return /→/.test(h) && /✅/.test(h) || h; });
  await tryIt("code player bundles a project", () => /data:text\/javascript/.test(w.bundleFiles([{ name: "index.html", code: "<script src=\"a.js\"></" + "script>" }, { name: "a.js", code: "console.log(1)" }], 0)));
  await tryIt("music builds a song and a MIDI file", async () => { const s = w.musicTest.buildSong({ title: "t", bpm: 120, bars: 2, tracks: [{ name: "p", instrument: "piano", loop: true, notes: "(C4/0.5 E4/0.5)x2 [C4 E4 G4]/2" }], drums: { kick: "x...", snare: "", clap: "", hat: "", openhat: "" } }); const b = await w.musicTest.midiFile(s).arrayBuffer(); return b.byteLength > 50 && new TextDecoder().decode(new Uint8Array(b).slice(0, 4)) === "MThd"; });
  await tryIt("monitor draws its cards", async () => { w.setView("monitor"); await sleep(150); return d.querySelectorAll("#monitorPage .home-card").length === 5 && !!d.querySelector("#mlFit button"); });
  await tryIt("list panel parses and adds steps", async () => { d.querySelector("#goList").click(); await sleep(80); const t = d.querySelector("#spList textarea"); if (d.querySelector("#sidePanel").hidden || d.querySelector("#sidePanel").dataset.tab !== "list") return "List tab not open in the side panel"; t.value = "image 3x: a red fox\ntext: a story about it"; t.dispatchEvent(new Event("input")); t.dispatchEvent(new Event("blur")); await sleep(80); const st = ev("S.listDraft"); const into = d.querySelector("#lpInto") && d.querySelector("#lpTarget").textContent; d.querySelector("#goList").click(); if (!into) return "no Into choice"; return st.length === 2 && st[0].kind === "image" && st[0].times === 3 && st[1].kind === "text" && st[0].prompt === "a red fox" || JSON.stringify(st); });
  await tryIt("hub draws its tiles", async () => { w.setView("hub"); await sleep(150); return d.querySelectorAll("#hubPage .hub-tile").length > 0; });
  await tryIt("notes page draws", async () => { w.setView("notes"); await sleep(150); return !!d.querySelector("#notesPage .notes-grid"); });
  await tryIt("tool router word lists compile", () => Object.values(ev("TOOLISH")).every((re) => Object.prototype.toString.call(re) === "[object RegExp]"));   // another window's RegExp: no instanceof
  await tryIt("tool list for the AI", () => /Tools of the app/.test(ev("whatYouCanDo()")));
  await tryIt("presentation tools: design, slides, sources slide, check and fix", async () => {
    const r = await w.eval(`(async () => {
      const deck = { title: "", subtitle: "", slides: [], theme: "midnight", fonts: "modern", transition: "fade", animation: "entrance", animStyle: "rise" };
      const block = { type: "deck", active: true, deck, steps: [], progress: 0 };
      const ctx = { ensure: () => block, touch: () => {}, pool: new Map([["p1", { thumb: "x", title: "A fox", creator: "Ann", license: "CC0" }]]), seq: 1, checked: false, checks: 0, issues: 0, attach: [], vision: false };
      const run = (n, a) => runDeckTool(n, a, ctx), out = {};
      out.design = await run("deck_design", { title: "Foxes", subtitle: "A short tour", theme: "forest" });
      out.s1 = await run("deck_set_slide", { n: 1, layout: "image-right", title: "Meet the fox", bullets: ["Red fox lives almost everywhere", "Eats mice, fruit and insects", "Hunts at dusk"], photo: "p1", notes: "Start with the animal everybody knows from stories." });
      out.bad = await run("deck_set_slide", { n: 2, layout: "quote", title: "Words", quote: "x" });
      out.s2 = await run("deck_set_slide", { n: 2, layout: "stats", title: "Fox facts", stats: [{ value: "12 years", label: "wild lifespan" }, { value: "50 km/h", label: "top speed" }], notes: "Two numbers worth remembering." });
      out.s3 = await run("deck_set_slide", { n: 3, layout: "sources", title: "Sources", bullets: ["Wikipedia: https://en.wikipedia.org/wiki/Red_fox", "A fox by Ann (CC0)"] });
      out.photoBad = await run("deck_set_slide", { n: 4, layout: "bullets", title: "Oops", bullets: ["a"], photo: "p99" });
      out.check1 = await run("deck_check", {});
      out.fix = await run("deck_set_slide", { n: 3, layout: "sources", title: "Sources", bullets: ["Wikipedia: https://en.wikipedia.org/wiki/Red_fox", "Photo: A fox, Ann, CC0 (openverse.org)"] });
      out.one = await run("deck_check", { n: 3 });
      out.del = await run("deck_delete_slide", { n: 9 });
      const el = slideEl(deck, 3), shown = layoutOf(deck.slides[2]);
      out.dom = el.className; out.li = el.querySelectorAll("li").length; out.shown = shown; out.checks = ctx.checks; out.checked = ctx.checked; out.steps = block.steps.length; out.n = deck.slides.length;
      out.theme = deck.theme; out.title = deck.title; out.cover = !!deck.coverPhoto;
      return JSON.stringify(out);
    })()`);
    const o = JSON.parse(r), bad = [];
    if (!/Design set: forest/.test(o.design) || o.theme !== "forest" || o.title !== "Foxes") bad.push("design");
    if (!/saved \(image-right\)/.test(o.s1)) bad.push("slide 1: " + o.s1);
    if (!/^Error: a quote slide/.test(o.bad)) bad.push("fake quote not refused");
    if (!/saved \(sources\)/.test(o.s3) || o.shown !== "sources" || !/L-sources/.test(o.dom) || o.li !== 2) bad.push("sources slide: " + o.dom + " " + o.shown);
    if (!/^Error: unknown photo/.test(o.photoBad)) bad.push("unknown photo accepted");
    if (!/Fox facts/.test(o.check1) || !/PROBLEMS/.test(o.check1) || !/a source without an address/.test(o.check1)) bad.push("check didn't flag the bad source: " + o.check1.slice(0, 300));
    if (!/\n   ok/.test(o.one) || /PROBLEMS/.test(o.one)) bad.push("fixed slide still flagged: " + o.one);
    if (!/^Error: there is no slide 9/.test(o.del)) bad.push("delete of a missing slide");
    if (!o.checked || o.checks !== 1 || o.n !== 3 || o.steps < 6) bad.push("bookkeeping " + JSON.stringify({ c: o.checks, n: o.n, st: o.steps }));
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("the model's tools are well formed and independent", () => {
    const defs = ev("[...DECK_TOOLS, DECK_PICTURE_TOOL, ...CHAT_TOOLS.map(t => t.def)].map(t => JSON.stringify(t))").map(JSON.parse), names = defs.map(d => d.function.name);
    const bad = defs.filter(d => d.function.parameters?.type !== "object" || !d.function.description || JSON.stringify(d).length > 14000).map(d => d.function.name);
    if (new Set(names).size !== names.length) return "duplicate tool names: " + names.join(",");
    if (bad.length) return "malformed: " + bad.join(",");
    for (const n of ["make_chart", "estimate_chances", "notes_show", "notes_edit", "make_music", "deck_make_picture", "deck_set_slide"]) if (!names.includes(n)) return "missing tool " + n;
    const mus = defs.find(d => d.function.name === "make_music").function.parameters;
    return (mus.properties.style?.enum?.length >= 10 && mus.properties.progression && mus.properties.motif && mus.required.includes("structure")) || "make_music form incomplete";
  });
  await tryIt("chart, chances, notes and music tools make their cards", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const by = (n) => CHAT_TOOLS.find(t => t.name === n), out = {};
      const c = by("make_chart").run({ title: "Cats", type: "bar", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Naps", values: [3, 5, 4] }], source: "my numbers", unit: "" });
      out.chart = [c.block.type, c.block.chart.type, c.block.chart.labels.length, c.block.chart.series[0].values.join(",")];
      const e = by("estimate_chances").run({ question: "Will it rain?", kind: "yesno", outcomes: [{ label: "Yes", chance: 30, why: "dry season" }, { label: "No", chance: 90, why: "" }], factors: [{ text: "clouds", direction: "up", strength: 2 }], confidence: "medium" }, { text: "rain?" });
      out.chances = [e.block.type, e.block.chances.outcomes.map(x => x.chance).join(","), e.block.chances.factors.length];
      const m = by("make_music").run({ title: "Test tune", style: "lofi", key: "A minor", bpm: 80, progression: ["i", "iv", "VII", "III"], motif: "3/1 5/0.5 6/0.5 5/2", structure: [{ name: "A", bars: 8, energy: 2, melody: "A" }] });
      out.music = [m.block.type, m.block.song.tracks.map(t => t.name).join(","), m.block.song.beats];
      const mid = await musicTest.midiFile(m.block.song).arrayBuffer(); out.midi = mid.byteLength;
      const n1 = by("notes_edit").run({ changes: [{ action: "create", note: "Smoke list", kind: "checklist", items: ["milk", "eggs"] }] }), n2 = by("notes_edit").run({ changes: [{ action: "check", note: "Smoke list", kind: "checklist", items: ["milk"] }] });
      out.notes = [n1.block.ids.length, n2.block.ids.length, by("notes_show").run().out.includes("[x] milk")];
      by("notes_edit").run({ changes: [{ action: "delete_note", note: "Smoke list", kind: "checklist", items: [] }] });
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (o.chart.join() !== "chart,bar,3,3,5,4") bad.push("chart " + o.chart);
    if (o.chances[0] !== "chances" || o.chances[1] !== "25,75" || o.chances[2] !== 1) bad.push("chances " + o.chances);
    if (o.music[0] !== "music" || !/Melody/.test(o.music[1]) || !/Drums/.test(o.music[1]) || o.music[2] !== 9 * 4) bad.push("music " + o.music);
    if (!(o.midi > 400)) bad.push("midi " + o.midi);
    if (o.notes.join() !== "1,1,true") bad.push("notes " + o.notes);
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("song and sound-choice cards draw", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const out = {};
      const act = songCard({ type: "song", active: true, status: "Composing and singing… 5 of 50", completed: 5, total: 50 });
      out.active = [act.querySelector(".q").textContent, act.querySelector(".bar i").style.width];
      const done = songCard({ type: "song", active: false, tags: "pop, upbeat", lyrics: "[verse] la la", song: { url: "/song/20260101120000-pop.mp3", file: "20260101120000-pop.mp3", seconds: 60, took: 40 } });
      out.done = [done.querySelector("audio")?.getAttribute("src"), done.querySelector("pre").textContent, done.querySelector("a[download]")?.getAttribute("download"), done.querySelector("small").textContent];
      out.err = songCard({ type: "song", active: false, error: "no GPU" }).textContent;
      const song = musicTest.composeSong({ title: "card", style: "pop", key: "C major", bpm: 100, progression: ["I","V","vi","IV"], motif: "3/1 5/1 6/1 5/1", structure: [{ name: "A", bars: 4, energy: 2, melody: "A" }] });
      const card = musicCard({ type: "music", song }); document.body.appendChild(card); await new Promise(r => setTimeout(r, 400));
      out.sel = [...card.querySelectorAll('[data-a="engine"] option')].map(x => x.value).join(",");
      out.has = ["play", "midi", "wav", "compare"].map(a => !!card.querySelector('[data-a="' + a + '"]'));
      card.remove();
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (!/Composing/.test(o.active[0]) || o.active[1] !== "10%") bad.push("active song card " + o.active);
    if (!/\/song\/20260101120000-pop\.mp3$/.test(o.done[0]) || !/la la/.test(o.done[1]) || o.done[2] !== "20260101120000-pop.mp3" || !/60 s/.test(o.done[3])) bad.push("song card " + o.done);
    if (!/no GPU/.test(o.err)) bad.push("song error card");
    if (!/^classic/.test(o.sel)) bad.push("sound choices " + o.sel);
    if (o.has.join() !== "true,true,true,true") bad.push("music card parts " + o.has);
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("the song tool is offered with a proper form", () => {
    const t = ev("JSON.stringify(CHAT_TOOLS.find(t => t.name === 'make_song')?.def)");
    if (!t) return "make_song missing";
    const d = JSON.parse(t).function;
    return (d.parameters.required.includes("tags") && d.parameters.properties.lyrics && d.parameters.properties.seconds && /ACE-Step/.test(d.description)) || "form incomplete";
  });
  await tryIt("Settings → Tools → Music: song model and sound banks", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const orig = window.pcCall, out = {}, box = () => document.querySelector("#musicBox");
      document.body.insertAdjacentHTML("beforeend", '<div id="musicBox"></div>');
      const mk = (song, banks) => (window.pcCall = async (path) => path === "/agent/music/status" ? song : { banks });
      const bank = (id, extra) => ({ id, name: id === "musescore" ? "MuseScore General" : "GeneralUser GS", about: "x", license: "MIT", size: 39900972, installed: false, ...extra });
      mk({ installed: false, hasComfy: true, sizeBytes: 7699743341, download: { running: false } }, [bank("musescore"), bank("generaluser", { installed: true })]);
      await paintMusicSetup(); const a = [...box().querySelectorAll(".mem-item")];
      out.rows = a.length; out.song = a[0].textContent; out.songBtn = a[0].querySelector("button")?.textContent; out.b1 = a[1].querySelector("button")?.textContent; out.b2 = a[2].querySelector("button")?.textContent;
      mk({ installed: false, hasComfy: true, sizeBytes: 7699743341, download: { running: true, got: 3.85e9, total: 7.7e9 } }, [bank("musescore", { running: true, got: 1e7, total: 4e7 }), bank("generaluser")]);
      await paintMusicSetup(); out.running = box().textContent;
      mk({ installed: false, hasComfy: false, sizeBytes: 7699743341, download: { running: false } }, []);
      await paintMusicSetup(); out.noComfy = box().textContent + "|btn=" + box().querySelectorAll("button").length;
      mk({ installed: true, hasComfy: true, sizeBytes: 7699743341, download: { running: false } }, []);
      await paintMusicSetup(); out.installed = box().textContent + "|" + box().querySelector("button")?.textContent;
      window.pcCall = async () => { throw new Error("offline"); }; await paintMusicSetup(); out.offline = box().textContent;
      window.pcCall = orig; box().remove(); clearTimeout(musicPoll);
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (o.rows !== 3 || !/ACE-Step/.test(o.song) || !/^Download \(7\.\d GB\)$/.test(o.songBtn || "")) bad.push("rows " + JSON.stringify([o.rows, o.songBtn]));
    if (!/^Download \(\d+ MB\)$/.test(o.b1 || "") || o.b2 !== "Remove") bad.push("bank buttons " + [o.b1, o.b2]);
    if (!/Downloading… 50%/.test(o.running) || !/Downloading… 25%/.test(o.running)) bad.push("progress " + o.running.slice(0, 200));
    if (!/Needs the picture engine/.test(o.noComfy) || !/btn=0/.test(o.noComfy)) bad.push("no ComfyUI case " + o.noComfy.slice(-80));
    if (!/Installed/.test(o.installed) || !/Remove$/.test(o.installed)) bad.push("installed " + o.installed.slice(-60));
    if (!/Connect to your PC/.test(o.offline)) bad.push("offline " + o.offline);
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("Settings → Tools → Add-ons: sharper pictures, natural voice, better search", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const orig = window.pcCall, out = {}, box = () => document.querySelector("#addonsBox");
      const had = !!box(); if (!had) document.body.insertAdjacentHTML("beforeend", '<div id="addonsBox"></div>');
      const mk = (up, kk, sx) => (window.pcCall = async (path) => path.startsWith("/agent/upscale/") ? up : path.startsWith("/agent/kokoro/") ? kk : path.startsWith("/agent/searxng/") ? sx : { scans: true });
      const voices = [{ id: "af_heart", name: "Heart · American, woman" }, { id: "bm_george", name: "George · British, man" }];
      mk({ installed: false, hasComfy: true, sizeBytes: 67040989, download: {} }, { installed: false, sizeBytes: 560e6, install: {} }, { installed: false, sizeBytes: 60e6, install: {} });
      await paintAddons(); let rows = [...box().querySelectorAll(".mem-item")];
      out.rows = rows.length; out.btns = rows.map((r) => r.querySelector("button")?.textContent || "");
      out.text = box().textContent;
      mk({ installed: false, hasComfy: true, download: { running: true, got: 33e6, total: 67e6 } }, { installed: false, install: { running: true, step: "Downloading the voice model…", got: 140e6, total: 560e6 } }, { installed: false, install: { running: true, step: "Installing what it needs (a minute or two)…" } });
      await paintAddons(); out.running = box().textContent; clearTimeout(addonsPoll);
      mk({ installed: true, hasComfy: true, download: {} }, { installed: true, on: true, voice: "bm_george", voices, install: {} }, { installed: true, install: {} });
      await paintAddons(); out.ok = [...box().querySelectorAll(".mem-item[data-id] > button")].map((b) => b.textContent);
      out.voice = box().querySelector(".kk-voice")?.value; out.on = box().querySelector(".kk-on")?.checked; out.flags = [window.upscaleOk, window.searxOk];
      mk({ installed: false, hasComfy: false, download: {} }, { installed: false, install: { error: "Not enough free disk space" } }, { installed: false, install: {} });
      await paintAddons(); out.noComfy = box().querySelector('[data-id="upscale"]').textContent + "|btn=" + box().querySelectorAll('[data-id="upscale"] button').length; out.err = box().textContent;
      window.pcCall = async () => { throw new Error("offline"); }; await paintAddons(); out.offline = box().textContent;
      window.pcCall = orig; if (!had) box().remove(); else box().innerHTML = ""; window.upscaleOk = window.searxOk = false;
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (o.rows !== 4 || o.btns.slice(0, 3).join() !== "Download (64 MB),Download (534 MB),Download (57 MB)" || o.btns[3] !== "") bad.push("rows " + JSON.stringify([o.rows, o.btns]));
    if (!/Real-ESRGAN/.test(o.text) || !/Kokoro/.test(o.text) || !/SearXNG/.test(o.text) || !/built into Windows/.test(o.text)) bad.push("names " + o.text.slice(0, 120));
    if (!/Downloading… 49%/.test(o.running) || !/voice model… 25%/.test(o.running) || !/Installing what it needs/.test(o.running)) bad.push("progress " + o.running.slice(0, 300));
    if (o.ok.join() !== "Remove,Remove,Remove" || o.voice !== "bm_george" || o.on !== true || o.flags.join() !== "true,true") bad.push("installed " + JSON.stringify([o.ok, o.voice, o.on, o.flags]));
    if (!/Needs the picture engine/.test(o.noComfy) || !/btn=0/.test(o.noComfy) || !/Not enough free disk space/.test(o.err)) bad.push("no ComfyUI / error " + o.noComfy.slice(-60));
    if (!/Connect to your PC/.test(o.offline)) bad.push("offline " + o.offline);
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("pictures get a Sharper button once the sharpener is installed, and it swaps in the sharper picture", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const orig = window.pcCall, out = {}, px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const m = { role: "assistant", genImage: px, prompt: "a cat" };
      const d = botBubble(m, 0); document.body.appendChild(d);
      window.upscaleOk = false; fillBot(d, m, 0); out.before = !!d.querySelector('.actions [aria-label^="Make it sharper"]');
      window.upscaleOk = true; fillBot(d, m, 0); const b = d.querySelector('.actions [aria-label^="Make it sharper"]'); out.after = !!b;
      let sent = null; window.pcCall = async (path, body) => { sent = [path, body.scale, body.image === px]; return { image: px + "", width: 2048, height: 2048, pcFile: { rel: "Pictures/x-sharper-2x.png" } }; };
      const keepRender = window.renderMessages, keepSave = window.saveChats; window.renderMessages = () => {}; window.saveChats = () => {};
      await sharpen(m, b); out.sent = sent; out.sharper = m.sharper;
      fillBot(d, m, 0); out.again = !!d.querySelector('.actions [aria-label^="Make it sharper"]');
      window.renderMessages = keepRender; window.saveChats = keepSave; window.pcCall = orig; window.upscaleOk = false; d.remove();
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (o.before || !o.after) bad.push("button " + [o.before, o.after]);
    if (!o.sent || o.sent[0] !== "/agent/upscale/run" || o.sent[1] !== 2 || !o.sent[2]) bad.push("request " + JSON.stringify(o.sent));
    if (!o.sharper || o.sharper.width !== 2048 || o.sharper.file !== "Pictures/x-sharper-2x.png") bad.push("result " + JSON.stringify(o.sharper));
    if (o.again) bad.push("still offers Sharper on a sharpened picture");
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("web searches go to SearXNG on the PC first when it is installed", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const orig = window.pcCall, keepConn = connected, keepFetch = window.fetch, calls = [];
      window.pcCall = async (path, body) => { calls.push(path + ":" + body.query); return { results: [{ title: "t", url: "https://example.org/" }], via: "searxng" }; };
      window.fetch = async () => { calls.push("server"); return new Response("{}", { status: 500 }); };
      connected = true; window.searxOk = true;
      const j = await webTool("web_search", { query: "rtx 5070" });
      window.searxOk = false; calls.push("--");
      await webTool("web_search", { query: "rtx 5070" }).catch(() => {});
      connected = keepConn; window.pcCall = orig; window.fetch = keepFetch;
      return JSON.stringify({ via: j.via, calls });
    })()`));
    return (o.via === "searxng" && o.calls[0] === "/agent/search:rtx 5070" && o.calls[1] === "--" && o.calls.slice(2).includes("server")) || "calls " + JSON.stringify(o);
  });
  await tryIt("Input & Output: the page, Jarvis's devices, and sound following the chosen speakers", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const out = {}, S = window.AlbatrossSound, keepJ = window.jarvisCall, keepCfg = S.settings(), sent = [];
      // sound follows the chosen speakers: new Audio elements and AudioContexts are pointed at it
      const mp = HTMLMediaElement.prototype, keepSink = mp.setSinkId, sinks = [];
      mp.setSinkId = function (id) { sinks.push("el:" + id); return Promise.resolve(); };
      const base = Object.getPrototypeOf(window.AudioContext.prototype), keepCtxSink = base.setSinkId;
      base.setSinkId = function (id) { sinks.push("ctx:" + id); return Promise.resolve(); };
      S._set({ out: { id: "spk1", label: "Desk speakers" } });
      new Audio(); const ctx = new AudioContext(); ctx.close();
      S._set({}); new Audio();
      out.sinks = sinks; out.isAudio = new Audio() instanceof HTMLAudioElement;
      mp.setSinkId = keepSink; if (keepCtxSink) base.setSinkId = keepCtxSink; else delete base.setSinkId;
      // the page with Jarvis running
      window.jarvisCall = async (method, path, body) => {
        if (method === "POST") { sent.push(body); return { status: 200, j: {} }; }
        return { status: 200, j: { inputs: ["Mikrofon (USB Audio)", "Kopfhörer (Deine Airpods - Find My)"], outputs: ["Lautsprecher (Realtek)", "Kopfhörer (Deine Airpods - Find My)"], input: "", output: "Lautsprecher (Realtek)" } };
      };
      S._set({ in: { id: "m1", label: "Default - Mikrofon (USB Audio)" } });
      openSettings("sound"); document.querySelector('#settings .tabs [data-tab="sound"]').click();
      await new Promise((r) => setTimeout(r, 600));
      const box = document.querySelector("#soundBox");
      out.text = box.textContent; out.hasIn = !!box.querySelector("#sndIn"); out.hasOut = !!box.querySelector("#sndOut");
      out.jvOut = box.querySelector("#jvOut")?.value; out.jvInOpts = [...(box.querySelector("#jvIn")?.options || [])].map((x) => x.value);
      const jin = box.querySelector("#jvIn"); jin.value = "Kopfhörer (Deine Airpods - Find My)"; jin.dispatchEvent(new Event("change"));
      out.btNote = box.querySelector("#jvInNote").textContent;
      const same = box.querySelector("#jvSame"); out.sameShown = !same.hidden; same.click(); await new Promise((r) => setTimeout(r, 50));
      out.sent = sent;
      // Jarvis not running
      window.jarvisCall = async () => ({ status: 503, j: { offline: true, canStart: true } });
      await S.paint(); await new Promise((r) => setTimeout(r, 100));
      out.offline = box.querySelector("#sndJarvis").textContent;
      window.jarvisCall = keepJ; S._set(keepCfg); S.stopMeter(); document.querySelector("#settings").close();
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (o.sinks.join() !== "el:spk1,ctx:spk1" || !o.isAudio) bad.push("speakers hook " + JSON.stringify([o.sinks, o.isAudio]));
    if (!o.hasIn || !o.hasOut || !/Here, in Albatross/.test(o.text) || !/Jarvis on your PC/.test(o.text)) bad.push("page " + o.text.slice(0, 160));
    if (o.jvOut !== "Lautsprecher (Realtek)" || o.jvInOpts.join("|") !== "|Mikrofon (USB Audio)|Kopfhörer (Deine Airpods - Find My)") bad.push("jarvis lists " + JSON.stringify([o.jvOut, o.jvInOpts]));
    if (!/Bluetooth headset/.test(o.btNote)) bad.push("headset warning " + o.btNote);
    if (!o.sameShown || JSON.stringify(o.sent) !== JSON.stringify([{ input: "Kopfhörer (Deine Airpods - Find My)" }, { input: "Mikrofon (USB Audio)" }])) bad.push("sent " + JSON.stringify([o.sameShown, o.sent]));
    if (!/isn't running/.test(o.offline) || !/Start Jarvis/.test(o.offline)) bad.push("offline " + o.offline);
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("help: every tour step points at something that exists", async () => {
    const T = w.AlbatrossTour;
    if (!T || !T.TOPICS.length) return "no tours";
    const bad = await T.check();
    if (bad.length) return "missing: " + bad.join(" | ");
    // a tour really opens: spotlight and card appear above the page, Next moves on, Esc ends it
    await T.start("start"); await sleep(500);
    const root = d.querySelector("#tour"), card = root && root.querySelector(".tour-card");
    const shown = !!root && root.matches(":popover-open") && /1 of/.test(card.querySelector(".tour-step").textContent) && !!card.querySelector("h3").textContent;
    const hole = root.querySelector(".tour-hole").getBoundingClientRect();
    card.querySelector('[data-a="next"]').click(); await sleep(450);
    const moved = /2 of/.test(card.querySelector(".tour-step").textContent);
    T.stop();
    const closed = !root.matches(":popover-open");
    d.querySelector("#settings").close();
    return (shown && hole.width > 10 && moved && closed) || JSON.stringify({ shown, hole: hole.width, moved, closed });
  });
  await tryIt("help: the Settings tab lists the tours and What's this? explains a click", async () => {
    w.openSettings("help"); await sleep(150);
    const topics = d.querySelectorAll("#helpTopics .help-topic").length, tab = d.querySelector('#settings .tabs [data-tab="help"]').classList.contains("on");
    d.querySelector("#settings").close();
    w.AlbatrossTour.whatsThis(); await sleep(150);
    const root = d.querySelector("#tour"), rect = d.querySelector("#effortBtn").getBoundingClientRect();
    d.querySelector("#effortBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 }));
    await sleep(300);
    const said = root.querySelector("h3").textContent + " | " + root.querySelector("p").textContent;
    w.AlbatrossTour.stop();
    return (topics >= 6 && tab && /thinks/i.test(said)) || JSON.stringify({ topics, tab, said });
  });
  await tryIt("screen help: look, point, clear; the button and the Settings switch follow the Windows app", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const calls = [], out = {};
      // without the Windows app the button explains itself
      document.querySelector("#screenBtn").click(); await new Promise(r => setTimeout(r, 200)); out.noApp = document.querySelector("#toast").textContent;
      window.albatrossDesktop = {
        screenAvailable: async () => true,
        screenLook: async (opts) => { calls.push(["look", opts]); return { ok: true, title: "Demo app", proc: "demo", rect: {}, image: { b64: "QUJD", w: 10, h: 10 }, elements: [{ n: 1, kind: "button", name: "Save", src: "ui" }, { n: 2, kind: "text", name: "Welcome", src: "ocr" }], list: "1 button 'Save'; 2 text 'Welcome' (read from the screen)" }; },
        screenShow: async (items, s) => { calls.push(["show", items, s]); return { shown: items.length }; },
        screenClear: async () => { calls.push(["clear"]); return true; },
        healthPopup: async () => true, setHealthPopup: async (on) => { calls.push(["health", on]); return on; },
      };
      await refreshScreenOk(); out.ok = window.screenOk;
      const by = (n) => CHAT_TOOLS.find(t => t.name === n), reply = { blocks: [] }, images = [], ctx = { reply, redraw() {}, images };
      const look = await by("look_at_screen").run({}, ctx);
      const show = await by("show_on_screen").run({ items: [{ n: 1, label: "Click here to save" }], seconds: 12 }, ctx);
      const clear = await by("show_on_screen").run({ items: [] }, ctx);
      out.look = look.out; out.images = images.length; out.block = reply.blocks[0] && [reply.blocks[0].type, reply.blocks[0].title, reply.blocks[0].count];
      out.show = show.out; out.clear = clear.out; out.calls = calls.map((c) => c[0]).join(","); out.showArgs = JSON.stringify(calls[1].slice(1)); out.card = screenCard(reply.blocks[0]).textContent;
      openSettings("help"); await new Promise(r => setTimeout(r, 250)); await paintHealthToggle();
      const sw = document.querySelector("#healthPopupOn"); out.toggle = sw.checked + "/" + sw.disabled;
      sw.checked = false; sw.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 200)); out.toggled = JSON.stringify(calls.filter((c) => c[0] === "health"));
      document.querySelector("#settings").close();
      delete window.albatrossDesktop; await refreshScreenOk(); out.after = window.screenOk;
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (!/Windows/.test(o.noApp)) bad.push("button without the app said: " + o.noApp);
    if (o.ok !== true || o.after !== false) bad.push("availability " + o.ok + "/" + o.after);
    if (!/Demo app/.test(o.look) || !/1 button 'Save'/.test(o.look) || !/never invent/.test(o.look) || !/read from the screen/.test(o.look) || o.images !== 1) bad.push("look: " + o.look.slice(0, 120));
    if (!o.block || o.block[0] !== "screen" || o.block[2] !== 2 || !/Demo app/.test(o.card) || !/2 things/.test(o.card)) bad.push("card " + JSON.stringify(o.block) + " " + o.card);
    if (!/Pointing at 1 thing/.test(o.show) || !/12/.test(o.showArgs) || !/Click here to save/.test(o.showArgs)) bad.push("show: " + o.show + " " + o.showArgs);
    if (!/gone/.test(o.clear) || o.calls !== "look,show,clear") bad.push("clear/calls: " + o.clear + " " + o.calls);
    if (o.toggle !== "true/false" || !/false/.test(o.toggled)) bad.push("switch " + o.toggle + " " + o.toggled);
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("the screen tools have proper forms", () => {
    const names = ev("CHAT_TOOLS.map(t => t.name)");
    for (const n of ["look_at_screen", "show_on_screen"]) if (!names.includes(n)) return "missing " + n;
    const f = JSON.parse(ev("JSON.stringify(CHAT_TOOLS.find(t => t.name === 'show_on_screen').def)")).function.parameters;
    return (f.required.includes("items") && f.properties.items.items.properties.n && f.properties.items.items.required.includes("n")) || "show_on_screen form incomplete";
  });
  await tryIt("reasoning a model writes into its answer goes to the thinking block, never into the answer", () => {
    const sp = (x) => w.splitThinking(x), bad = [];
    const cases = [
      ["<think>plan the reply</think>Hello there", "plan the reply", "Hello there"],
      ["<think>still working it out", "still working it out", ""],
      ["The user wants a greeting.\n</think>\n\nHi!", "The user wants a greeting.", "Hi!"],
      ["<|channel|>analysis<|message|>check the sum<|end|><|start|>assistant<|channel|>final<|message|>391", "check the sum", "391"],
      ["Just a normal answer with x < y in it.", "", "Just a normal answer with x < y in it."],
    ];
    for (const [raw, think, answer] of cases) { const r = sp(raw); if (r.think !== think || r.answer !== answer) bad.push(JSON.stringify(raw).slice(0, 40) + " -> " + JSON.stringify(r)); }
    if (!sp("<think>a").open || sp("<think>a</think>b").open) bad.push("open flag");
    // streamed in small pieces, with the tags split across pieces: the answer may never show reasoning or half a tag
    for (const chunks of [["<thi", "nk>pla", "n the re", "ply</th", "ink>Hel", "lo"], ["<|chan", "nel|>analysis<|mes", "sage|>sum it", "<|end|><|start|>assistant<|channel|>final<|message|>39", "1"]]) {
      let acc = "";
      for (const ch of chunks) { acc += ch; const a = sp(acc).answer; if (/plan|sum it|<\/?t|<\|/.test(a)) { bad.push("leak while streaming: " + JSON.stringify(a)); break; } }
      const end = sp(acc); if (!/^(Hello|391)$/.test(end.answer)) bad.push("final answer " + JSON.stringify(end.answer));
    }
    // Max's review: OK or a remark keeps the answer; a real corrected answer replaces it
    const orig = "Here are three tips for sleeping better: keep the room cool and dark, go to bed at the same time every day, and put the phone away an hour before.";
    const rv = (x) => w.reviewResult(orig, x);
    if (rv("OK") !== orig || rv("OK.") !== orig) bad.push("plain OK");
    if (rv("I read the request again and checked every tip. Everything is correct and complete. OK") !== orig) bad.push("a remark replaced the answer");
    if (rv("Looks good.") !== orig) bad.push("a short remark replaced the answer");
    if (rv("<think>checking</think>OK") !== orig) bad.push("OK after thinking");
    const fixed = "Three tips for sleeping better: keep the bedroom cool (about 18 °C) and dark, keep the same bedtime every day, and stop screens an hour before bed.";
    if (rv(fixed) !== fixed) bad.push("a real correction was not taken");
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("the real chat path: leaked reasoning lands in the thinking block, and Max's review remark doesn't replace the answer", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const NL = String.fromCharCode(10), origApi = chatApi, origCaps = getCaps, origEffort = S.effort, origThink = S.think, out = {};
      const stream = (parts) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const p of parts) c.enqueue(e.encode(JSON.stringify(p) + NL)); c.close(); } }));
      const piece = (content) => ({ message: { role: "assistant", content } });
      let calls = 0, script = [];
      window.chatApi = async () => stream(script[calls++] || [piece("?"), { done: true }]);
      window.getCaps = async () => ["completion", "thinking"];
      setView("chat"); await new Promise(r => setTimeout(r, 150));
      const run = async (effort, scripts) => {
        S.effort = effort; S.think = true; calls = 0; script = scripts;
        current.messages.push({ role: "user", content: "Is pizza good?" });
        await chat("fake-model");
        const m = current.messages[current.messages.length - 1];
        const r = { content: m.content, thinking: (m.blocks || []).filter(b => b.type === "thinking").map(b => b.text).join(" / "), calls };
        current.messages.splice(-2, 2);
        return r;
      };
      out.leak = await run("medium", [[piece("<thi"), piece("nk>The user asks about pizza. I should "), piece("say yes.</th"), piece("ink>Pizza is "), piece("great."), { done: true, eval_count: 9, eval_duration: 1e9 }]]);
      out.lone = await run("medium", [[piece("Okay, the user wants to know about pizza." + NL), piece("</think>" + NL + NL + "Yes, pizza is good."), { done: true }]]);
      const answer = "Yes: pizza is good. A thin crust, ripe tomatoes, real mozzarella and a very hot oven make the difference between average and great.";
      out.review = await run("max", [[piece(answer), { done: true }], [piece("I read the question again and checked the answer: it is correct and complete. OK"), { done: true }]]);
      window.chatApi = origApi; window.getCaps = origCaps; S.effort = origEffort; S.think = origThink; saveChats();
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (o.leak.content !== "Pizza is great." || !/user asks about pizza/.test(o.leak.thinking)) bad.push("leak " + JSON.stringify(o.leak));
    if (o.lone.content !== "Yes, pizza is good." || !/wants to know about pizza/.test(o.lone.thinking)) bad.push("lone " + JSON.stringify(o.lone));
    if (o.review.calls !== 2 || !/^Yes: pizza is good\./.test(o.review.content)) bad.push("review " + JSON.stringify(o.review));
    return bad.length ? bad.join(" | ") : true;
  });
  await tryIt("a redstone circuit asked for in chat shows its diagram (no PC needed)", async () => {
    const o = JSON.parse(await w.eval(`(async () => {
      const NL = String.fromCharCode(10), origApi = chatApi, origCaps = getCaps, out = {};
      const stream = (parts) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const p of parts) c.enqueue(e.encode(JSON.stringify(p) + NL)); c.close(); } }));
      let calls = 0, sent = null;
      const script = [[{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "redstone_design", arguments: { circuit: "a xor b" } } }] } }, { done: true }],
        [{ message: { role: "assistant", content: "Here is your XOR gate." } }, { done: true }]];
      window.chatApi = async (body) => { if (!sent) sent = body; return stream(script[calls++] || [{ message: { role: "assistant", content: "?" } }, { done: true }]); };
      window.getCaps = async () => ["completion", "tools"];
      setView("chat"); await new Promise(r => setTimeout(r, 150));
      current.messages.push({ role: "user", content: "Make me a redstone XOR gate" });
      await chat("fake-model"); await new Promise(r => setTimeout(r, 200));
      const m = current.messages[current.messages.length - 1];
      out.offered = !!(sent && JSON.stringify(sent).includes("redstone_design"));
      out.block = (m.blocks || []).some(b => b.type === "redstone" && b.spec && b.spec.gates.length === 5);
      const vis = [...document.querySelectorAll(".rs-vis")].pop();
      out.shown = !!vis && !!vis.querySelector(".rs-3d canvas") && vis.querySelectorAll(".rs-3d tbody tr").length === 4 && vis.querySelectorAll(".lever").length === 2;
      if (vis) { vis.querySelector(".rs-3d tbody tr:nth-child(3)").click(); await new Promise(r => setTimeout(r, 3500)); out.lit = /Lamp is <b>ON/.test(vis.querySelector(".rs-3d .rs-status").innerHTML); }
      // every build must pass its own redstone simulation, wires crossing on bridges included
      out.builds = ["a and b", "a xor b", "(a and b) or not c", "a xor b xor c", "(a or b) and (c or d)"].map(e => { try { const L = redstoneLayout(redstonePlan({ circuit: e }).spec); return L.counts.torches > 0; } catch (x) { return e + ": " + x.message; } }).filter(x => x !== true);
      out.answer = m.content;
      current.messages.splice(-2, 2); window.chatApi = origApi; window.getCaps = origCaps; saveChats();
      return JSON.stringify(out);
    })()`));
    const bad = [];
    if (!o.offered) bad.push("the tool wasn't offered to the model");
    if (!o.block) bad.push("no redstone block in the answer");
    if (!o.shown) bad.push("the diagram isn't on the page");
    if (!o.lit) bad.push("switching lever a didn't light the lamp");
    if (o.builds && o.builds.length) bad.push("3D builds failed: " + o.builds.join("; "));
    return bad.length ? bad.join(" | ") + " " + JSON.stringify(o) : true;
  });
  await sleep(300);
  R.errors = (w.__errs || []).slice(0, 20);
  return R;
};
