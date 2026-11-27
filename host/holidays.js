// Public holidays for shortcuts ("not on holidays", "only on holidays"). Germany's are worked out here (every state, no internet
// needed). Other countries come from Nager.Date (date.nager.at, a free public-holiday service that needs no key): asked once per
// country and year, then kept in holidays-<country>-<year>.json. Only the country and the year are sent.
// Your own days off (a vacation, a bridge day) count as holidays too.
//   cfg = { country: "DE", region: "BY" (or ""), extra: [{ from: "2026-12-23", to: "2027-01-02", name: "Vacation" }] }
const fs = require("fs"), path = require("path");
const DIR = process.env.ALBATROSS_DATA || __dirname;

const DE_STATES = { BW: "Baden-Württemberg", BY: "Bayern", BE: "Berlin", BB: "Brandenburg", HB: "Bremen", HH: "Hamburg", HE: "Hessen",
  MV: "Mecklenburg-Vorpommern", NI: "Niedersachsen", NW: "Nordrhein-Westfalen", RP: "Rheinland-Pfalz", SL: "Saarland", SN: "Sachsen",
  ST: "Sachsen-Anhalt", SH: "Schleswig-Holstein", TH: "Thüringen" };

const iso = (d) => d.toISOString().slice(0, 10);
const plus = (d, n) => new Date(d.getTime() + n * 864e5);
// Easter Sunday (the Gregorian computus)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return new Date(Date.UTC(y, Math.floor(n / 31) - 1, (n % 31) + 1));
}
// Germany: [date, name, the states that have it (null: everywhere)]
function germany(y) {
  const E = easter(y), f = (md) => `${y}-${md}`;
  const nov23 = new Date(Date.UTC(y, 10, 23)), bettag = plus(nov23, -((nov23.getUTCDay() - 3 + 7) % 7 || 7));     // the Wednesday before 23 November
  return [
    [f("01-01"), "Neujahr", null], [f("01-06"), "Heilige Drei Könige", ["BW", "BY", "ST"]], [f("03-08"), "Internationaler Frauentag", ["BE", "MV"]],
    [iso(plus(E, -2)), "Karfreitag", null], [iso(E), "Ostersonntag", ["BB"]], [iso(plus(E, 1)), "Ostermontag", null], [f("05-01"), "Tag der Arbeit", null],
    [iso(plus(E, 39)), "Christi Himmelfahrt", null], [iso(plus(E, 49)), "Pfingstsonntag", ["BB"]], [iso(plus(E, 50)), "Pfingstmontag", null],
    [iso(plus(E, 60)), "Fronleichnam", ["BW", "BY", "HE", "NW", "RP", "SL"]], [f("08-15"), "Mariä Himmelfahrt", ["SL"]], [f("09-20"), "Weltkindertag", ["TH"]],
    [f("10-03"), "Tag der Deutschen Einheit", null], [f("10-31"), "Reformationstag", ["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"]],
    [f("11-01"), "Allerheiligen", ["BW", "BY", "NW", "RP", "SL"]], [iso(bettag), "Buß- und Bettag", ["SN"]],
    [f("12-25"), "1. Weihnachtstag", null], [f("12-26"), "2. Weihnachtstag", null],
  ].map(([date, name, regions]) => ({ date, name, regions }));
}

const cache = new Map();          // "DE-2026" -> [{ date, name, regions }]
const asking = new Map();
const country = (cfg) => (/^[A-Z]{2}$/.test(String(cfg && cfg.country || "").toUpperCase()) ? String(cfg.country).toUpperCase() : "DE");
function yearList(c, y) {
  if (c === "DE") { if (!cache.has("DE-" + y)) cache.set("DE-" + y, germany(y)); return cache.get("DE-" + y); }
  const k = c + "-" + y;
  if (cache.has(k)) return cache.get(k);
  try { const l = JSON.parse(fs.readFileSync(path.join(DIR, `holidays-${k}.json`), "utf8")); if (Array.isArray(l)) { cache.set(k, l); return l; } } catch {}
  fetchYear(c, y).catch(() => {});
  return null;                    // not known yet: no holiday (it's there within seconds, while online)
}
function fetchYear(c, y) {
  const k = c + "-" + y;
  if (asking.has(k)) return asking.get(k);
  const p = (async () => {
    const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/${c}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("the holiday service answered " + r.status);
    const l = (await r.json()).filter((h) => !Array.isArray(h.types) || h.types.includes("Public"))
      .map((h) => ({ date: String(h.date), name: String(h.localName || h.name || "Holiday"), regions: h.global === false && Array.isArray(h.counties) ? h.counties.map((x) => String(x).split("-").pop()) : null }));
    cache.set(k, l);
    try { fs.writeFileSync(path.join(DIR, `holidays-${k}.json`), JSON.stringify(l)); } catch {}
    return l;
  })().finally(() => setTimeout(() => asking.delete(k), 10 * 60e3));      // a failed one is tried again after 10 minutes
  asking.set(k, p);
  return p;
}
// this year's and next year's, so a check never waits (called at start and once a day)
async function prepare(cfg) {
  const c = country(cfg), y = new Date().getFullYear();
  for (const yy of [y, y + 1]) if (c !== "DE" && !yearList(c, yy)) await fetchYear(c, yy).catch(() => {});
}
// the holiday on that day (YYYY-MM-DD, local), or "" if it's a normal day; your own days off count
function on(date, cfg) {
  const extra = ((cfg && cfg.extra) || []).find((x) => x && x.from <= date && date <= (x.to || x.from));
  if (extra) return extra.name || "Day off";
  const c = country(cfg), region = String(cfg && cfg.region || "").toUpperCase();
  const h = (yearList(c, Number(date.slice(0, 4))) || []).find((x) => x.date === date && (!x.regions || (region && x.regions.includes(region))));
  return h ? h.name : "";
}
// the next n holidays from today (for the page), your own days off included
function upcoming(cfg, n = 6) {
  const today = ymd(new Date()), y = Number(today.slice(0, 4)), c = country(cfg), region = String(cfg && cfg.region || "").toUpperCase();
  const all = [...(yearList(c, y) || []), ...(yearList(c, y + 1) || [])].filter((x) => x.date >= today && (!x.regions || (region && x.regions.includes(region))));
  for (const x of (cfg && cfg.extra) || []) if (x && (x.to || x.from) >= today) all.push({ date: x.from < today ? today : x.from, to: x.to || "", name: x.name || "Day off", own: true });
  return all.sort((a, b) => a.date.localeCompare(b.date)).slice(0, n);
}
// a local date as YYYY-MM-DD (not UTC: just after midnight it's already tomorrow here)
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const regions = (c) => (String(c || "").toUpperCase() === "DE" ? DE_STATES : null);

module.exports = { on, upcoming, prepare, regions, ymd, easter, germany };
