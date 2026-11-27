// Shortcuts: things this PC does by itself, a few steps in a row (open a program or a website, media keys, volume, brightness,
// lock, sleep, shut down, call a link, say something out loud, tell Jarvis, wait), started by
//   - a time on chosen weekdays, with public holidays counted in, skipped, or as the only days (holidays.js)
//   - a date, once or every year
//   - arriving at or leaving a place: a phone reports where it is while Albatross is open on it, or a phone automation (iPhone
//     Shortcuts, Tasker…) opens the place's link in the background
//   - Alexa, through your own Alexa skill: "Alexa, ask Albatross Home to start movie night"
//   - its own link, from anything that can open a web address (a phone automation, a Stream Deck, IFTTT…)
//   - Run now on the website
// They run here, in the host (it runs from boot), so no browser has to be open. Everything is kept in shortcuts.json.
//
// The links and Alexa come in through the Albatross server (Alexa and phone automations can't do the end-to-end encryption the
// website does): server.js passes /hook/<this PC's code>/<rest> here as a "hook" message. A link carries nothing but a secret key
// (made here, only in this PC's links) and which shortcut or place: the server never sees what a shortcut does. A wrong key is
// refused; New links on the website makes a new key, and the old links stop working.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { execFile } = require("child_process");
const holidays = require("./holidays");

const FILE = path.join(process.env.ALBATROSS_DATA || __dirname, "shortcuts.json");
const STEPS = ["app", "url", "key", "volume", "bright", "lock", "sleep", "shutdown", "link", "say", "notify", "jarvis", "shortcut", "wait"];
const KEYS = ["playpause", "next", "prev", "mute", "volup", "voldown"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(6).toString("hex");
const newKey = () => crypto.randomBytes(18).toString("base64url");
const okId = (x) => typeof x === "string" && /^[a-z0-9]{6,24}$/i.test(x);      // (a missing id must not become "undefined")
const okTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));
const okDate = (d) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(d));
const text = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

let deps = { note() {}, hookBase: () => "", jarvis: async () => [503, { error: "Jarvis isn't set up" }], sleepNow: async () => {}, desk: async () => { throw new Error("No desktop helper"); } };
let db = load();

function load() {
  let j = {}; try { j = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  const d = {
    items: Array.isArray(j.items) ? j.items.map(clean).filter(Boolean) : [],
    places: Array.isArray(j.places) ? j.places.map(cleanPlace).filter(Boolean) : [],
    holidays: cleanHolidays(j.holidays || {}),
    key: typeof j.key === "string" && j.key.length >= 20 ? j.key : newKey(),
    alexa: { app: typeof j.alexa?.app === "string" ? j.alexa.app : "" },
    fired: j.fired && typeof j.fired === "object" ? j.fired : {},       // "<id>|<trigger>" -> the day it last ran
    where: j.where && typeof j.where === "object" ? j.where : {},       // device -> { in: { placeId: true/false } }
  };
  for (const it of d.items) { const old = (j.items || []).find((x) => x && x.id === it.id); if (old && old.last) it.last = old.last; }
  return d;
}
let saveT = 0;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); } catch (e) { deps.note("Shortcuts couldn't be saved: " + e.message, "error"); } }, 200);
}

// ---------- what the website sends is checked here ----------
function cleanWhen(w) {
  if (!w || typeof w !== "object") return null;
  if (w.t === "time" && okTime(w.at)) {
    const days = [...new Set((Array.isArray(w.days) ? w.days : [0, 1, 2, 3, 4, 5, 6]).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
    return { t: "time", at: w.at, days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], hol: ["skip", "only"].includes(w.hol) ? w.hol : "also" };
  }
  if (w.t === "date" && okDate(w.date) && okTime(w.at)) return { t: "date", date: w.date, at: w.at, yearly: !!w.yearly };
  if (w.t === "place" && okId(w.place)) return { t: "place", place: w.place, on: w.on === "leave" ? "leave" : "arrive" };
  // sunrise or sunset at a place (your first place if none is picked), up to 3 hours before or after
  if (w.t === "sun") {
    const days = [...new Set((Array.isArray(w.days) ? w.days : [0, 1, 2, 3, 4, 5, 6]).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
    return { t: "sun", ev: w.ev === "sunrise" ? "sunrise" : "sunset", off: Math.max(-180, Math.min(180, Math.round(Number(w.off) || 0))), place: okId(w.place) ? w.place : "", days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], hol: ["skip", "only"].includes(w.hol) ? w.hol : "also" };
  }
  if (w.t === "start") return { t: "start" };
  // every so many minutes, if wanted only between two times
  if (w.t === "every") return { t: "every", mins: Math.max(5, Math.min(1440, Math.round(Number(w.mins) || 60))), from: okTime(w.from) ? w.from : "", to: okTime(w.to) ? w.to : "" };
  return null;
}
// "only if": between two times, and/or somebody (or nobody) at a place
function cleanOnly(c) {
  if (!c || typeof c !== "object") return null;
  if (c.c === "between" && okTime(c.from) && okTime(c.to)) return { c: "between", from: c.from, to: c.to };
  if (c.c === "place" && okId(c.place)) return { c: "place", place: c.place, who: c.who === "nobody" ? "nobody" : "someone" };
  return null;
}
function cleanStep(s) {
  if (!s || !STEPS.includes(s.kind)) return null;
  return { kind: s.kind, arg: text(s.arg, 2000) };
}
function clean(it) {
  if (!it || typeof it !== "object") return null;
  return {
    id: okId(it.id) ? it.id : newId(),
    name: text(it.name, 60) || "Shortcut",
    on: it.on !== false, alexa: it.alexa !== false,
    when: (Array.isArray(it.when) ? it.when : []).slice(0, 12).map(cleanWhen).filter(Boolean),
    steps: (Array.isArray(it.steps) ? it.steps : []).slice(0, 30).map(cleanStep).filter(Boolean),
    only: (Array.isArray(it.only) ? it.only : []).slice(0, 6).map(cleanOnly).filter(Boolean),
  };
}
function cleanPlace(p) {
  if (!p) return null;
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { id: okId(p.id) ? p.id : newId(), name: text(p.name, 40) || "Place", lat, lon, r: Math.max(50, Math.min(5000, Math.round(Number(p.r) || 150))) };
}
function cleanHolidays(h) {
  return {
    country: /^[A-Z]{2}$/.test(String(h.country || "").toUpperCase()) ? String(h.country).toUpperCase() : "DE",
    region: /^[A-Z0-9]{1,3}$/.test(String(h.region || "").toUpperCase()) ? String(h.region).toUpperCase() : "",
    extra: (Array.isArray(h.extra) ? h.extra : []).slice(0, 60).filter((x) => x && okDate(x.from) && (!x.to || okDate(x.to)))
      .map((x) => ({ from: x.from, to: x.to && x.to >= x.from ? x.to : "", name: text(x.name, 40) })),
  };
}

// ---------- doing the steps ----------
// "30" is seconds; "30s", "5m", "1h" too (at most an hour)
const duration = (a) => { const m = /^(\d+(?:[.,]\d+)?)\s*(s|sec|m|min|h)?$/i.exec(String(a).trim()); if (!m) return 1; const n = Number(m[1].replace(",", ".")), u = (m[2] || "s")[0].toLowerCase(); return Math.min(3600, n * (u === "h" ? 3600 : u === "m" ? 60 : 1)); };
const level = (a) => Math.max(0, Math.min(100, Math.round(Number(String(a).replace("%", "")) || 0)));
// "https://…" is opened (GET); "POST https://… {json}" sends that body. Any address, also in your home network (a smart plug's
// own link): only you can put a link into a shortcut.
async function callLink(a) {
  const m = /^(?:(GET|POST|PUT)\s+)?(https?:\/\/\S+)(?:\s+([\s\S]+))?$/i.exec(a.trim());
  if (!m) throw new Error("A link has to start with http:// or https://");
  const method = (m[1] || (m[3] ? "POST" : "GET")).toUpperCase(), body = m[3] || undefined;
  const r = await fetch(m[2], { method, body, headers: body ? { "Content-Type": /^\s*[{[]/.test(body) ? "application/json" : "text/plain" } : {}, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`The link answered ${r.status}`);
}
let appsCache = null, appsAt = 0;
async function step(s, depth) {
  const a = String(s.arg || "").trim();
  switch (s.kind) {
    case "wait": return sleep(duration(a) * 1000);
    case "app": {
      if (!appsCache || Date.now() - appsAt > 10 * 60e3) { appsCache = (await deps.desk("apps")).apps || []; appsAt = Date.now(); }
      const want = a.toLowerCase(), hit = appsCache.find((x) => x.name.toLowerCase() === want) || appsCache.find((x) => x.name.toLowerCase().startsWith(want)) || appsCache.find((x) => x.name.toLowerCase().includes(want));
      if (!hit) throw new Error(`No program called "${a}" in the Start menu`);
      return deps.desk("launch", hit.id);
    }
    case "url": return deps.desk("url", /^https?:\/\//i.test(a) ? a : "https://" + a);
    case "key": if (!KEYS.includes(a)) throw new Error(`"${a}" isn't a media key (${KEYS.join(", ")})`); return deps.desk("key", a);
    case "volume": return deps.desk("volume", { level: level(a) });
    case "bright": return deps.desk("bright", { level: level(a) });
    case "lock": return deps.desk("lock");
    case "say": return deps.desk("say", a);
    case "notify": return deps.desk("notify", a);
    // another shortcut, as a step (at most 3 inside each other, and never itself)
    case "shortcut": {
      const other = db.items.find((x) => x.id === a); if (!other) throw new Error("The shortcut to run is gone");
      if (depth >= 3) throw new Error("Too many shortcuts inside each other");
      for (const t of other.steps) await step(t, depth + 1);
      return;
    }
    case "link": return callLink(a);
    case "jarvis": { const [st, j] = await deps.jarvis(a); if (st !== 200) throw new Error((j && j.error) || "Jarvis didn't take that"); return; }
    case "sleep": await sleep(1500); return deps.sleepNow();
    case "shutdown":
      if (process.platform !== "win32") throw new Error("Shutting down is only set up for Windows");
      execFile("shutdown", ["/s", "/t", "60", "/c", "Albatross shortcut: shutting down in a minute. To stop it, run: shutdown /a"], { windowsHide: true }, () => {});
      return;
  }
  throw new Error(`Unknown step "${s.kind}"`);
}
const running = new Set();
// minutes since midnight; "between" also works across midnight (22:00 to 06:00)
const mm = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const inWindow = (from, to, now = new Date()) => { const n = now.getHours() * 60 + now.getMinutes(), a = mm(from), b = mm(to); return a <= b ? n >= a && n < b : n >= a || n < b; };
// is any device at that place now (from a report within the last 12 hours)?
const someoneAt = (pid) => Object.values(db.where).some((d) => d && d.in && d.in[pid] && Date.now() - (d.at || 0) < 12 * 3600e3);
function allowed(it) {
  for (const c of it.only || []) {
    if (c.c === "between" && !inWindow(c.from, c.to)) return false;
    if (c.c === "place" && someoneAt(c.place) !== (c.who === "someone")) return false;
  }
  return true;
}
// auto: started by a time, a place or the PC starting: then the "only if" rules count (by hand, Alexa or a link: always)
async function run(it, via, auto) {
  if (!it) return { ok: false, error: "No such shortcut" };
  if (auto && !allowed(it)) { deps.note(`Shortcut “${it.name}” skipped (${via}): its “only if” didn't fit`); return { ok: false, error: "skipped" }; }
  if (running.has(it.id)) return { ok: false, error: "It's already running" };
  running.add(it.id);
  deps.note(`Shortcut “${it.name}” started (${via})`);
  let error = "";
  try { for (const s of it.steps) await step(s, 0); }
  catch (e) { error = (e && e.message) || String(e); deps.note(`Shortcut “${it.name}” stopped: ${error}`, "error"); }
  finally { running.delete(it.id); }
  const cur = db.items.find((x) => x.id === it.id);
  if (cur) { cur.last = { at: Date.now(), via, ok: !error, error }; save(); }
  return { ok: !error, error };
}

// ---------- the clock: times and dates ----------
// up to 3 minutes late still counts (a busy or just-woken PC), never twice on the same day
function due(w, now, today) {
  if (w.t === "date") return w.yearly ? today.slice(5) === w.date.slice(5) : today === w.date;
  const hol = holidays.on(today, db.holidays);
  if (!w.days.includes(now.getDay())) return false;
  if (w.hol === "skip") return !hol;
  if (w.hol === "only") return !!hol;
  return true;
}
const whenKey = (it, w) => `${it.id}|${w.t}|${w.at || w.ev + w.off}|${w.date || w.place || ""}`;
// sunrise and sunset (the sunrise equation; good to a minute or two), as Dates for that day at that place
function sunTimes(day, lat, lon) {
  const r = Math.PI / 180, J = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 12) / 864e5 + 2440587.5;
  const n = Math.round(J - 2451545.0 + 0.0008), Js = n - lon / 360, M = (357.5291 + 0.98560028 * Js) % 360;
  const C = 1.9148 * Math.sin(M * r) + 0.02 * Math.sin(2 * M * r) + 0.0003 * Math.sin(3 * M * r), L = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * r) - 0.0069 * Math.sin(2 * L * r), d = Math.asin(Math.sin(L * r) * Math.sin(23.4397 * r));
  const cw = (Math.sin(-0.833 * r) - Math.sin(lat * r) * Math.sin(d)) / (Math.cos(lat * r) * Math.cos(d));
  if (cw < -1 || cw > 1) return null;                       // midnight sun or polar night
  const w0 = Math.acos(cw) / r, at = (j) => new Date((j - 2440587.5) * 864e5);
  return { sunrise: at(Jt - w0 / 360), sunset: at(Jt + w0 / 360) };
}
function sunAt(w, now) {
  const p = db.places.find((x) => x.id === w.place) || db.places[0]; if (!p) return null;
  const t = sunTimes(now, p.lat, p.lon); if (!t) return null;
  const d = new Date(t[w.ev].getTime() + w.off * 60e3);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const everyLast = new Map();
function tick(now = new Date()) {
  const today = holidays.ymd(now), mins = now.getHours() * 60 + now.getMinutes();
  for (const it of db.items) {
    if (!it.on) continue;
    for (const w of it.when) {
      if (w.t === "every") {
        const k = whenKey(it, w), last = everyLast.get(k);
        if (last == null) { everyLast.set(k, now.getTime()); continue; }             // the first one a full interval after start
        if (now - last < w.mins * 60e3 || (w.from && w.to && !inWindow(w.from, w.to, now))) continue;
        everyLast.set(k, now.getTime()); run(it, `every ${w.mins} min`, true); continue;
      }
      if (w.t !== "time" && w.t !== "date" && w.t !== "sun") continue;
      const at = w.t === "sun" ? sunAt(w, now) : w.at; if (!at) continue;
      const [h, m] = at.split(":").map(Number), late = mins - (h * 60 + m);
      if (late < 0 || late > 3 || !due(w, now, today)) continue;
      const k = whenKey(it, w); if (db.fired[k] === today) continue;
      db.fired[k] = today; save();
      run(it, w.t === "date" ? `${w.date} ${w.at}` : w.t === "sun" ? `${w.ev} ${at}` : `${w.at}`, true);
    }
  }
}

// ---------- places ----------
const meters = (a, b, c, d) => { const R = 6371e3, r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const lastPlaceRun = new Map();       // "<place>|<arrive|leave>" -> when (two phones arriving together run it once)
function placeEvent(pid, ev, via) {
  const p = db.places.find((x) => x.id === pid); if (!p) return [];
  const k = pid + "|" + ev; if (Date.now() - (lastPlaceRun.get(k) || 0) < 5 * 60e3) return [];
  lastPlaceRun.set(k, Date.now());
  const hit = db.items.filter((it) => it.on && it.when.some((w) => w.t === "place" && w.place === pid && w.on === ev));
  deps.note(`${ev === "arrive" ? "Arrived at" : "Left"} ${p.name} (${via})${hit.length ? "" : ": no shortcut for that"}`);
  for (const it of hit) run(it, `${ev === "arrive" ? "arrived at" : "left"} ${p.name}`, true);
  return hit.map((x) => x.name);
}
// a device says where it is: inside a place's circle, or more than its accuracy (at least 50 m) outside it; in between nothing
// changes, so standing at the edge doesn't go back and forth. The first report only learns where the device is.
function where(dev, lat, lon, acc) {
  dev = text(dev, 40) || "device";
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || !(acc < 500)) return { ok: false, error: "Not accurate enough" };
  const d = db.where[dev] || (db.where[dev] = { in: {} });
  const ran = [];
  for (const p of db.places) {
    const dist = meters(lat, lon, p.lat, p.lon), was = d.in[p.id];
    const now = dist <= p.r ? true : dist > p.r + Math.max(50, acc) ? false : was;
    if (now === undefined) continue;
    d.in[p.id] = now;
    if (was !== undefined && was !== now) ran.push(...placeEvent(p.id, now ? "arrive" : "leave", "this device's location"));
  }
  d.at = Date.now(); save();
  return { ok: true, inside: db.places.filter((p) => d.in[p.id]).map((p) => p.name), ran };
}

// ---------- Alexa ----------
// The words heard after "start" are matched to a shortcut's name: the same, one inside the other, mostly the same words, or a few
// letters off (Alexa's spelling of what it heard).
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9 ]+/g, " ")
  .replace(/\b(the|my|a|shortcut|den|die|das|der|mein|meine|meinen|kurzbefehl)\b/g, " ").replace(/\s+/g, " ").trim();
function lev(a, b) { const m = [...Array(b.length + 1).keys()]; for (let i = 1; i <= a.length; i++) { let p = m[0]; m[0] = i; for (let j = 1; j <= b.length; j++) { const t = m[j]; m[j] = Math.min(m[j] + 1, m[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return m[b.length]; }
function find(heard, list) {
  const h = norm(heard); if (!h) return null;
  let best = null, score = 0;
  for (const it of list) {
    const n = norm(it.name); if (!n) continue;
    const hw = new Set(h.split(" ")), nw = n.split(" "), both = nw.filter((w) => hw.has(w)).length;
    const s = n === h ? 100 : (n.includes(h) || h.includes(n)) ? 80 : Math.max(both / Math.max(hw.size, nw.length) * 70, (1 - lev(n, h) / Math.max(n.length, h.length)) * 75);
    if (s > score) { score = s; best = it; }
  }
  return score >= 50 ? best : null;
}
function alexa(raw) {
  let j = {}; try { j = JSON.parse(raw || "{}"); } catch {}
  const req = j.request || {}, de = /^de/i.test(String(req.locale || ""));
  const app = String(j.context?.System?.application?.applicationId || j.session?.application?.applicationId || "");
  const say = (t, end = true) => ({ version: "1.0", response: { outputSpeech: { type: "PlainText", text: t }, ...(end ? {} : { reprompt: { outputSpeech: { type: "PlainText", text: de ? "Welchen Kurzbefehl?" : "Which shortcut?" } } }), shouldEndSession: end } });
  // an old request sent again, or another skill than the one that first used this link: refused
  const ts = Date.parse(String(req.timestamp || ""));
  if (!ts || Math.abs(Date.now() - ts) > 150e3) return say(de ? "Diese Anfrage ist zu alt." : "That request is too old.");
  if (!app) return say(de ? "Das kam nicht von Alexa." : "That didn't come from Alexa.");
  if (db.alexa.app && db.alexa.app !== app) return say(de ? "Dieser Skill gehört nicht zu diesem PC." : "This skill doesn't belong to this PC.");
  if (!db.alexa.app) { db.alexa.app = app; save(); deps.note("Alexa: your skill is now linked to this PC"); }
  if (req.type === "SessionEndedRequest") return { version: "1.0", response: {} };
  const list = db.items.filter((x) => x.on && x.alexa), names = list.map((x) => x.name), some = names.slice(0, 6).join(", ");
  const intent = String(req.intent?.name || "");
  if (/^AMAZON\.(Stop|Cancel|NavigateHome)Intent$/.test(intent)) return say(de ? "Okay." : "Okay.");
  if (intent === "RunShortcutIntent") {
    const heard = text(req.intent?.slots?.shortcut?.value, 100), it = find(heard, list);
    if (!it) return say(names.length ? (de ? `Ich kenne keinen Kurzbefehl „${heard}“. Du hast: ${some}.` : `I don't know a shortcut called ${heard}. You have: ${some}.`) : (de ? "Du hast noch keine Kurzbefehle für Alexa." : "You don't have any shortcuts for Alexa yet."));
    run(it, "Alexa");
    return say(de ? `Okay, ${it.name}.` : `Okay, ${it.name}.`);
  }
  if (!names.length) return say(de ? "Du hast noch keine Kurzbefehle für Alexa. Lege sie in Albatross unter Shortcuts an." : "You don't have any shortcuts for Alexa yet. Make them in Albatross, under Shortcuts.");
  return say(de ? `Sag zum Beispiel: starte ${names[0]}. Du hast: ${some}.` : `Say for example: start ${names[0]}. You have: ${some}.`, false);
}

// ---------- links: /hook/<code>/<key>/s/<id>, …/place/<id>/<arrive|leave>, …/alexa ----------
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function hook(rest, method, body) {
  const [key, kind, a, b] = String(rest || "").split("?")[0].split("/").filter(Boolean);
  if (!key || !same(key, db.key)) return [403, { error: "This link isn't valid (anymore)." }];
  if (kind === "alexa") return [200, alexa(body)];
  if (kind === "s") {
    const it = db.items.find((x) => x.id === a);
    if (!it) return [404, { error: "That shortcut is gone." }];
    if (!it.on) return [409, { error: `“${it.name}” is switched off.` }];
    if (running.has(it.id)) return [409, { error: `“${it.name}” is running already.` }];
    run(it, "its link");
    return [200, { ok: true, started: it.name }];
  }
  if (kind === "place") {
    if (!db.places.some((p) => p.id === a)) return [404, { error: "That place is gone." }];
    return [200, { ok: true, started: placeEvent(a, b === "leave" ? "leave" : "arrive", "a link") }];
  }
  return [404, { error: "Unknown link." }];
}

// ---------- the website: GET and POST /pc/shortcuts ----------
function view() {
  const base = deps.hookBase() + db.key;
  return {
    items: db.items.map((it) => ({ ...it, running: running.has(it.id), link: `${base}/s/${it.id}` })),
    places: db.places.map((p) => ({ ...p, arrive: `${base}/place/${p.id}/arrive`, leave: `${base}/place/${p.id}/leave` })),
    holidays: { ...db.holidays, regions: holidays.regions(db.holidays.country), today: holidays.on(holidays.ymd(new Date()), db.holidays), next: holidays.upcoming(db.holidays, 8) },
    alexa: { endpoint: `${base}/alexa`, linked: !!db.alexa.app },
    sun: db.places[0] ? (() => { const t = sunTimes(new Date(), db.places[0].lat, db.places[0].lon); return t ? { place: db.places[0].name, sunrise: t.sunrise.toTimeString().slice(0, 5), sunset: t.sunset.toTimeString().slice(0, 5) } : null; })() : null,
    now: new Date().toString().slice(0, 21), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
async function handle(method, body) {
  if (method === "GET") return [200, view()];
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  const a = j.action;
  if (a === "save") {
    const it = clean(j.item); if (!it) return [400, { error: "Nothing to save" }];
    const i = db.items.findIndex((x) => x.id === it.id);
    if (i >= 0) { it.last = db.items[i].last; db.items[i] = it; } else db.items.push(it);
    save(); return [200, view()];
  }
  if (a === "toggle") { const it = db.items.find((x) => x.id === j.id); if (it) { it.on = !!j.on; save(); } return [200, view()]; }
  if (a === "delete") { db.items = db.items.filter((x) => x.id !== j.id); save(); return [200, view()]; }
  if (a === "run") {
    const it = db.items.find((x) => x.id === j.id); if (!it) return [404, { error: "That shortcut is gone." }];
    const r = await run(it, "Run now"); if (!r.ok) return [500, { error: r.error }];
    return [200, view()];
  }
  if (a === "places") {
    db.places = (Array.isArray(j.places) ? j.places : []).slice(0, 30).map(cleanPlace).filter(Boolean);
    for (const d of Object.values(db.where)) for (const k of Object.keys(d.in || {})) if (!db.places.some((p) => p.id === k)) delete d.in[k];
    save(); return [200, view()];
  }
  if (a === "holidays") { db.holidays = cleanHolidays(j.holidays || {}); save(); await holidays.prepare(db.holidays); return [200, view()]; }
  if (a === "where") return [200, where(j.device, Number(j.lat), Number(j.lon), Number(j.acc))];
  if (a === "newkey") { db.key = newKey(); save(); deps.note("Shortcuts: new links made, the old ones stopped working"); return [200, view()]; }
  if (a === "alexa-unlink") { db.alexa.app = ""; save(); return [200, view()]; }
  return [400, { error: "Unknown shortcuts request" }];
}

function start(d) {
  deps = { ...deps, ...d };
  holidays.prepare(db.holidays).catch(() => {});
  // the clock, every 15 seconds; the holiday lists once a day; days that are long past are forgotten
  setInterval(() => { try { tick(); } catch (e) { deps.note("Shortcuts: " + e.message, "error"); } }, 15000).unref();
  setInterval(() => {
    holidays.prepare(db.holidays).catch(() => {});
    const today = holidays.ymd(new Date()); for (const [k, v] of Object.entries(db.fired)) if (v < today) delete db.fired[k];
    save();
  }, 6 * 3600e3).unref();
  if (!fs.existsSync(FILE)) save();
  // "when the PC starts": a minute after the host started (the desktop and the network are ready by then)
  setTimeout(() => { for (const it of db.items) if (it.on && it.when.some((w) => w.t === "start")) run(it, "the PC started", true); }, 60e3).unref();
}

module.exports = { start, handle, hook, tick, where, find, alexa, sunTimes, allowed, _db: () => db, _set: (x) => { db = x; } };
