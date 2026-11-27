"use strict";
// Shortcuts: things your PC does by itself. host/shortcuts.js runs them (from boot, with no browser open); this page makes and
// changes them: when (a time on chosen days, with or without holidays; a date; arriving at or leaving a place; Alexa; its own
// link) and what (steps like the Hub's routines). Also here: holidays and your own days off, your places, the Alexa skill's setup.
// With "Report where this device is" on, a device tells the PC where it is while Albatross is open on it (after moving 30 m, or
// every 5 minutes), and the PC runs a place's shortcuts when the device arrives or leaves.
// Uses the main page's helpers: $, esc, toast, pcCall, connected, guestMode.
(() => {
const SC = { data: null, open: false, secs: new Set(), lang: "" };
const page = () => $("#shortcutsPage");
const DAYS = [[1, "Mo"], [2, "Tu"], [3, "We"], [4, "Th"], [5, "Fr"], [6, "Sa"], [0, "Su"]];
const DAYNAME = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };
// [label, placeholder]
const STEP = {
  app: ["Open a program", "Spotify"], url: ["Open a website", "https://…"], key: ["Media key", ""], volume: ["Set the volume (%)", "30"],
  bright: ["Set the brightness (%)", "70"], say: ["Say out loud", "Good morning!"], link: ["Call a link", "https://… (Voice Monkey for Alexa, a smart plug…)"],
  jarvis: ["Tell Jarvis", "open my mail"], wait: ["Wait", "10s, 5m or 1h"], lock: ["Lock the PC", ""], sleep: ["Put the PC to sleep", ""], shutdown: ["Shut the PC down", ""],
};
const NOARG = new Set(["lock", "sleep", "shutdown"]);
const KEYS = { playpause: "Play / pause", next: "Next track", prev: "Previous track", mute: "Mute", volup: "Volume up", voldown: "Volume down" };
const COUNTRIES = { DE: "Germany", AT: "Austria", CH: "Switzerland", NL: "Netherlands", BE: "Belgium", LU: "Luxembourg", FR: "France", IT: "Italy", ES: "Spain",
  PT: "Portugal", GB: "United Kingdom", IE: "Ireland", DK: "Denmark", SE: "Sweden", NO: "Norway", FI: "Finland", PL: "Poland", CZ: "Czechia", US: "United States", CA: "Canada", AU: "Australia" };
const call = (body) => pcCall("/pc/shortcuts", body);
const fetchAll = () => pcCall("/pc/shortcuts", null, "GET");
const copy = (t) => (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("Copied"), () => { window.prompt("Copy this:", t); });

// ---------- words ----------
function daysText(days) {
  const s = [...days].sort().join("");
  return s === "0123456" ? "Every day" : s === "12345" ? "Weekdays" : s === "06" ? "Weekends" : DAYS.filter(([d]) => days.includes(d)).map(([d]) => DAYNAME[d]).join(", ");
}
const fmtDay = (d, year) => new Date(d + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
function whenWords(w) {
  if (w.t === "time") return `${daysText(w.days)} at ${w.at}${w.hol === "skip" ? ", not on holidays" : w.hol === "only" ? ", only on holidays" : ""}`;
  if (w.t === "date") return `${w.yearly ? "Every " + fmtDay(w.date, false) : fmtDay(w.date, true)} at ${w.at}`;
  const p = SC.data.places.find((x) => x.id === w.place);
  return (w.on === "arrive" ? "Arriving at " : "Leaving ") + (p ? p.name : "a deleted place");
}
function stepWords(s) {
  const a = s.arg || "";
  return { app: "Open " + a, url: "Open " + a.replace(/^https?:\/\/(www\.)?/, "").split("/")[0], key: KEYS[a] || a, volume: "Volume " + a + "%", bright: "Brightness " + a + "%",
    say: "Say “" + (a.length > 40 ? a.slice(0, 40) + "…" : a) + "”", link: "Call " + (a.replace(/^(GET|POST|PUT)\s+/i, "").replace(/^https?:\/\/(www\.)?/, "").split(/[/?]/)[0]),
    jarvis: "Jarvis: " + a, wait: "Wait " + a, lock: "Lock", sleep: "Sleep", shutdown: "Shut down" }[s.kind] || s.kind;
}
function ago(t) {
  const d = new Date(t), now = new Date(), hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return "today " + hm;
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "long" }) + " " + hm;
  return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hm;
}

// ---------- the page ----------
async function load() {
  if (!page()) return;
  if (!SC.data) page().innerHTML = `<div class="sc-wrap"><div class="sc-head"><h1>Shortcuts</h1></div><div class="empty-note">Loading your shortcuts from the PC…</div></div>`;
  try { SC.data = await fetchAll(); }
  catch (e) {
    page().innerHTML = `<div class="sc-wrap"><div class="sc-head"><h1>Shortcuts</h1></div><div class="empty-note">${esc(/Unknown PC request|404/.test(e.message) ? "The Albatross on your PC is too old for shortcuts: update it (the app updates by itself; a host started by hand needs a restart)." : e.message)}</div></div>`;
    return;
  }
  render();
}
function render() {
  const d = SC.data; if (!d || !page()) return;
  page().innerHTML = `<div class="sc-wrap">
    <div class="sc-head"><h1>Shortcuts</h1><span class="sc-sp"></span><button class="btn small primary" data-a="new" type="button">New shortcut</button></div>
    <p class="sc-sub">Your PC does these by itself: at a time, on a date, when you arrive somewhere or leave, or when you ask Alexa. They run on the PC, so nothing has to stay open here. The PC's time: ${esc(d.now)}.</p>
    <div class="sc-list">${d.items.length ? d.items.map(card).join("") : `<div class="empty-note">No shortcuts yet. <b>New shortcut</b> starts with an example: weekdays at 7:00, not on holidays, the PC says “Good morning!”. Add steps like opening the news or setting the volume.</div>`}</div>
    ${holSec(d)}${placeSec(d)}${alexaSec(d)}${linkSec()}
  </div>`;
  page().querySelectorAll("details[data-sec]").forEach((el) => { if (SC.secs.has(el.dataset.sec)) el.open = true; el.ontoggle = () => (el.open ? SC.secs.add(el.dataset.sec) : SC.secs.delete(el.dataset.sec)); });
  paintWhere();
}
const card = (it) => `<article class="sc-card${it.on ? "" : " off"}" data-id="${esc(it.id)}">
  <div class="sc-top"><input type="checkbox" class="switch" data-a="toggle" ${it.on ? "checked" : ""} aria-label="${esc(it.name)} on"><b class="sc-name">${esc(it.name)}</b><span class="sc-sp"></span>
    <button class="btn small" data-a="run" type="button" ${it.running ? "disabled" : ""}>${it.running ? "Running…" : "Run now"}</button><button class="btn small ghost" data-a="edit" type="button">Edit</button></div>
  <div class="sc-when">${[...it.when.map(whenWords), ...(it.alexa ? ["Alexa"] : [])].map((x) => `<span class="sc-chip">${esc(x)}</span>`).join("") || '<span class="sc-chip dim">Only by hand or its link</span>'}</div>
  <div class="sc-steps">${esc(it.steps.map(stepWords).join("  →  ") || "No steps yet")}</div>
  ${it.last ? `<div class="sc-last ${it.last.ok ? "" : "bad"}">${esc((it.last.ok ? "Ran " : "Stopped ") + ago(it.last.at) + " (" + it.last.via + ")" + (it.last.ok ? "" : ": " + it.last.error))}</div>` : ""}
</article>`;

function holSec(d) {
  const h = d.holidays, regs = h.regions;
  const opt = (k, n, cur) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>${esc(n)}</option>`;
  return `<details class="sc-sec" data-sec="hol"><summary>Holidays and days off <small>${esc(COUNTRIES[h.country] || h.country)}${h.region ? " · " + esc((regs && regs[h.region]) || h.region) : ""}${h.today ? " · today: " + esc(h.today) : ""}</small></summary>
    <div class="sc-secb">
      <p class="sc-tip">For shortcuts set to “not on holidays” or “only on holidays”.${h.country === "DE" ? " Pick your state: some holidays are only in some states." : ""}</p>
      <div class="row">
        <div class="field"><label>Country</label><select class="hub-in" data-h="country">${Object.entries(COUNTRIES).map(([k, n]) => opt(k, n, h.country)).join("")}${COUNTRIES[h.country] ? "" : opt(h.country, h.country, h.country)}</select></div>
        <div class="field"><label>${regs ? "State" : "Region (optional, e.g. BE)"}</label>${regs ? `<select class="hub-in" data-h="region">${opt("", "Only the nationwide holidays", h.region)}${Object.entries(regs).map(([k, n]) => opt(k, n, h.region)).join("")}</select>` : `<input class="hub-in" data-h="region" value="${esc(h.region)}" maxlength="3" autocomplete="off">`}</div>
      </div>
      <p class="sc-tip"><b>Coming up:</b> ${h.next.length ? h.next.map((x) => esc(fmtDay(x.date, true) + " " + x.name + (x.to ? " (to " + fmtDay(x.to, true) + ")" : ""))).join(" · ") : "nothing known yet (other countries' holidays need the PC to be online once)"}</p>
      <h4>Your own days off</h4>
      <p class="sc-tip">A vacation or a bridge day counts as a holiday, so “not on holidays” skips it too.</p>
      <div class="sc-extra">${h.extra.map(extraRow).join("")}</div>
      <div class="sc-adds"><button class="btn small" data-a="extra-add" type="button">+ Day off</button><span class="sc-sp"></span><button class="btn small primary" data-a="hol-save" type="button">Save holidays</button></div>
    </div></details>`;
}
const extraRow = (x) => `<div class="sc-x-row"><input type="date" class="hub-in" data-e="from" value="${esc(x.from || "")}" aria-label="From"><span>to</span><input type="date" class="hub-in" data-e="to" value="${esc(x.to || "")}" aria-label="To (optional)"><input class="hub-in" data-e="name" value="${esc(x.name || "")}" placeholder="Vacation" maxlength="40" aria-label="Name"><button class="sc-x" data-a="extra-del" type="button" aria-label="Remove">×</button></div>`;

function placeSec(d) {
  const radius = (p) => [100, 150, 300, 500, 1000, 2000].map((r) => `<option value="${r}" ${r === p.r ? "selected" : ""}>${r < 1000 ? r + " m" : r / 1000 + " km"}</option>`).join("");
  return `<details class="sc-sec" data-sec="places"><summary>Places <small>${d.places.length ? esc(d.places.map((p) => p.name).join(", ")) : "none yet"}</small></summary><div class="sc-secb">
    <p class="sc-tip">A place is a circle around a spot. A shortcut can run when one of your devices arrives there or leaves.</p>
    ${d.places.map((p) => `<div class="sc-place" data-pid="${esc(p.id)}"><input class="hub-in" data-p="name" value="${esc(p.name)}" maxlength="40" aria-label="Name"><select class="hub-in" data-p="r" aria-label="Size">${radius(p)}</select><small>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</small><span class="sc-sp"></span><button class="btn small" data-copy="${esc(p.arrive)}" type="button">Arrive link</button><button class="btn small" data-copy="${esc(p.leave)}" type="button">Leave link</button><button class="sc-x" data-a="place-del" type="button" aria-label="Remove">×</button></div>`).join("")}
    <div class="sc-adds"><input class="hub-in" id="scNewPlace" placeholder="${d.places.length ? "Name, e.g. Work" : "Name, e.g. Home"}" maxlength="40" autocomplete="off"><button class="btn small" data-a="place-here" type="button">+ Add where I am now</button></div>
    <h4>How the PC knows where you are</h4>
    <label class="sc-check"><input type="checkbox" class="switch" data-a="where" ${whereOn() ? "checked" : ""}> Report where this device is while Albatross is open on it</label>
    <p class="sc-tip" id="scWhere"></p>
    <p class="sc-tip">For the background (Albatross closed), let the phone open a place's link by itself. <b>iPhone:</b> the Shortcuts app → Automation → New Automation → Arrive (or Leave) → pick the place → Run Immediately → action “Get Contents of URL” → paste the Arrive (or Leave) link. <b>Android:</b> an automation app such as MacroDroid or Tasker: a location trigger with an HTTP request (GET) to the link.</p>
  </div></details>`;
}

// the Alexa skill's interaction model: one intent with everything after "start" as the shortcut's name
function model(en) {
  return JSON.stringify({ interactionModel: { languageModel: { invocationName: en ? "albatross home" : "albatros zuhause", intents: [
    { name: "RunShortcutIntent", slots: [{ name: "shortcut", type: "AMAZON.SearchQuery" }],
      samples: en ? ["start {shortcut}", "run {shortcut}", "do {shortcut}", "activate {shortcut}", "start the shortcut {shortcut}", "run my shortcut {shortcut}"]
        : ["starte {shortcut}", "starte den kurzbefehl {shortcut}", "führe {shortcut} aus", "mach {shortcut}", "aktiviere {shortcut}", "{shortcut} starten"] },
    { name: "AMAZON.HelpIntent", samples: [] }, { name: "AMAZON.StopIntent", samples: [] }, { name: "AMAZON.CancelIntent", samples: [] },
    { name: "AMAZON.NavigateHomeIntent", samples: [] }, { name: "AMAZON.FallbackIntent", samples: [] },
  ], types: [] } } }, null, 2);
}
function alexaSec(d) {
  const en = (SC.lang || (/^de/i.test(navigator.language || "") ? "de" : "en")) === "en";
  const ex = (d.items.find((x) => x.alexa && x.on) || {}).name || (en ? "Good morning" : "Guten Morgen");
  return `<details class="sc-sec" data-sec="alexa"><summary>Alexa <small>${d.alexa.linked ? "your skill is linked" : "not set up yet"}</small></summary><div class="sc-secb">
    <p class="sc-tip">Your own Alexa skill, only for your Amazon account (free, nothing gets published). Then ${en ? `“Alexa, ask Albatross Home to start ${esc(ex)}”` : `„Alexa, sag Albatros Zuhause, starte ${esc(ex)}“`} runs that shortcut, and Alexa routines can start shortcuts too. Shortcuts with “Alexa can start it” are the ones it knows.</p>
    <div class="seg sc-lang" role="group" aria-label="Your Echo's language"><button type="button" data-lang="en" class="${en ? "on" : ""}">English Echo</button><button type="button" data-lang="de" class="${en ? "" : "on"}">German Echo</button></div>
    <ol class="sc-ol">
      <li>Open the <a href="https://developer.amazon.com/alexa/console/ask" target="_blank" rel="noopener">Alexa Developer Console</a> with the Amazon account your Echo uses, and press <b>Create Skill</b>: name <b>Albatross</b>, language <b>${en ? "English (the one your Echo uses)" : "German"}</b>, experience <b>Other → Custom</b>, hosting <b>Provision your own</b>, then <b>Start from Scratch</b>.</li>
      <li>On the left, <b>Interaction Model → JSON Editor</b>: replace everything with this, then <b>Save</b>. <button class="btn small" data-copy-model="${en ? "en" : "de"}" type="button">Copy</button><details><summary>Show it</summary><pre>${esc(model(en))}</pre></details></li>
      <li>On the left, <b>Endpoint → HTTPS</b>. Paste this into <b>Default Region</b> <button class="btn small" data-copy="${esc(d.alexa.endpoint)}" type="button">Copy endpoint</button> and pick <b>“My development endpoint has a certificate from a trusted certificate authority”</b>. <b>Save</b>, then <b>Build skill</b> at the top.</li>
      <li>In the <b>Test</b> tab, set “Skill testing is enabled in” to <b>Development</b>.</li>
      <li>Say ${en ? `<b>“Alexa, ask Albatross Home to start ${esc(ex)}”</b>, or “Alexa, open Albatross Home” and then the name` : `<b>„Alexa, sag Albatros Zuhause, starte ${esc(ex)}“</b>, oder „Alexa, öffne Albatros Zuhause“ und dann den Namen`}. In an Alexa routine, add the action <b>Customised</b> and type that sentence.</li>
    </ol>
    <p class="sc-tip">The first request links the skill to this PC; any other skill is refused after that. The endpoint has your secret key in it, so keep it to yourself.${d.alexa.linked ? ' <button class="btn small" data-a="alexa-unlink" type="button">Unlink the skill</button> (before setting up a new one)' : ""}</p>
    <p class="sc-tip">The other way round, so Alexa says something or runs an Alexa routine: a <b>Call a link</b> step with a link from <a href="https://voicemonkey.io" target="_blank" rel="noopener">Voice Monkey</a>.</p>
  </div></details>`;
}
const linkSec = () => `<details class="sc-sec" data-sec="links"><summary>Links</summary><div class="sc-secb">
  <p class="sc-tip">Each shortcut has its own link (<b>Copy link</b> when you edit it), and each place has one for arriving and one for leaving. Opening a link runs it, from anything that can open a web address: a phone automation, a Stream Deck, IFTTT. Links reach your PC through the Albatross server with a secret key in them, so treat them like a password.</p>
  <div class="sc-adds"><button class="btn small" data-a="newkey" type="button">Make new links</button><small class="sc-tip">All old links stop working, the Alexa endpoint too.</small></div>
</div></details>`;

// ---------- clicks on the page ----------
document.addEventListener("click", async (e) => {
  const pg = page(); if (!pg || !pg.contains(e.target) || !SC.data) return;
  const b = e.target.closest("button, input[type=checkbox]"); if (!b) return;
  const cardEl = b.closest(".sc-card"), it = cardEl && SC.data.items.find((x) => x.id === cardEl.dataset.id);
  const a = b.dataset.a;
  try {
    if (b.dataset.copy) return copy(b.dataset.copy);
    if (b.dataset.copyModel) return copy(model(b.dataset.copyModel === "en"));
    if (b.dataset.lang) { SC.lang = b.dataset.lang; return render(); }
    if (a === "new") return editor(null);
    if (a === "edit" && it) return editor(it);
    if (a === "toggle" && it) { SC.data = await call({ action: "toggle", id: it.id, on: b.checked }); return render(); }
    if (a === "run" && it) {
      b.disabled = true; b.textContent = "Running…";
      try { SC.data = await call({ action: "run", id: it.id }); toast(`“${it.name}” done`); } catch (err) { toast(`“${it.name}” stopped: ${err.message}`); SC.data = await fetchAll().catch(() => SC.data); }
      return render();
    }
    if (a === "extra-add") { pg.querySelector(".sc-extra").insertAdjacentHTML("beforeend", extraRow({})); return; }
    if (a === "extra-del") { b.closest(".sc-x-row").remove(); return; }
    if (a === "hol-save") return saveHolidays();
    if (a === "place-del") { const pid = b.closest(".sc-place").dataset.pid; return savePlaces(SC.data.places.filter((p) => p.id !== pid)); }
    if (a === "place-here") return addPlaceHere(b);
    if (a === "where") { try { localStorage.setItem("burrow.scWhere", b.checked ? "1" : "0"); } catch {} if (b.checked) { lastSent = null; whereStart(true); } else { whereStop(); whereText = ""; } return paintWhere(); }
    if (a === "alexa-unlink") { SC.data = await call({ action: "alexa-unlink" }); toast("Unlinked: the next skill that asks is linked instead"); return render(); }
    if (a === "newkey") {
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again: old links stop"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Make new links"; }, 4000); return; }
      SC.data = await call({ action: "newkey" }); toast("New links made. Put them where the old ones were (Alexa: the endpoint)."); return render();
    }
  } catch (err) { toast(err.message); }
});
document.addEventListener("change", async (e) => {
  const pg = page(); if (!pg || !pg.contains(e.target) || !SC.data) return;
  if (e.target.dataset.h === "country") { await saveHolidays(); return; }
  const row = e.target.closest(".sc-place");
  if (row && e.target.dataset.p) {
    const list = SC.data.places.map((p) => (p.id !== row.dataset.pid ? p : { ...p, name: row.querySelector('[data-p="name"]').value.trim() || p.name, r: Number(row.querySelector('[data-p="r"]').value) }));
    await savePlaces(list);
  }
});
async function saveHolidays() {
  const pg = page(), extra = [...pg.querySelectorAll(".sc-x-row")].map((r) => ({ from: r.querySelector('[data-e="from"]').value, to: r.querySelector('[data-e="to"]').value, name: r.querySelector('[data-e="name"]').value.trim() })).filter((x) => x.from);
  const country = pg.querySelector('[data-h="country"]').value, regionEl = pg.querySelector('[data-h="region"]');
  const region = country === SC.data.holidays.country && regionEl ? regionEl.value.trim() : "";
  try { SC.data = await call({ action: "holidays", holidays: { country, region, extra } }); toast("Holidays saved on your PC"); render(); } catch (err) { toast(err.message); }
}
async function savePlaces(list) {
  try { SC.data = await call({ action: "places", places: list.map(({ id, name, lat, lon, r }) => ({ id, name, lat, lon, r })) }); render(); } catch (err) { toast(err.message); }
}
function addPlaceHere(b) {
  if (!navigator.geolocation) return toast("This browser can't tell where it is");
  const name = ($("#scNewPlace").value || "").trim() || (SC.data.places.length ? "Place " + (SC.data.places.length + 1) : "Home");
  b.disabled = true; b.textContent = "Finding where you are…";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    await savePlaces([...SC.data.places, { name, lat, lon, r: accuracy > 120 ? Math.min(1000, Math.ceil(accuracy / 50) * 50) : 150 }]);
    toast(`${name} added${accuracy > 120 ? ` (this device only knew it to about ${Math.round(accuracy)} m, so the circle is bigger)` : ""}`);
  }, (err) => { b.disabled = false; b.textContent = "+ Add where I am now"; toast("Couldn't get the location: " + err.message); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

// ---------- the editor ----------
function editor(it) {
  const d = it ? JSON.parse(JSON.stringify(it)) : { name: "", on: true, alexa: true, when: [{ t: "time", at: "07:00", days: [1, 2, 3, 4, 5], hol: "skip" }], steps: [{ kind: "say", arg: "Good morning!" }] };
  const box = document.createElement("div"); box.className = "hub-ask sc-ed";
  box.innerHTML = `<div class="hub-ask-card sc-ed-card" role="dialog" aria-modal="true" aria-label="${it ? "Edit shortcut" : "New shortcut"}">
    <h3>${it ? "Edit shortcut" : "New shortcut"}</h3>
    <input class="hub-in" data-f="name" placeholder="Name, e.g. Good morning (Alexa listens for it)" maxlength="60" autocomplete="off">
    <h4>When</h4><div class="sc-whens"></div>
    <div class="sc-adds"><button class="btn small" data-add="time" type="button">+ Time</button><button class="btn small" data-add="date" type="button">+ Date</button><button class="btn small" data-add="place" type="button">+ Place</button></div>
    <label class="sc-check"><input type="checkbox" data-f="alexa"> Alexa can start it by its name</label>
    ${it ? `<div class="sc-linkrow"><span class="sc-tip">Its own link runs it from anywhere.</span><button class="btn small" data-copy="${esc(it.link)}" type="button">Copy link</button></div>` : ""}
    <h4>Do</h4><div class="sc-stepl"></div>
    <div class="sc-adds"><button class="btn small" data-add="step" type="button">+ Step</button></div>
    <div class="row sc-ed-foot">${it ? '<button class="btn small danger" data-ed="del" type="button">Delete</button>' : ""}<span style="flex:1"></span><button class="btn small" data-ed="no" type="button">Cancel</button><button class="btn small primary" data-ed="ok" type="button">Save</button></div>
  </div>`;
  const $$ = (s) => box.querySelector(s);
  $$('[data-f="name"]').value = d.name; $$('[data-f="alexa"]').checked = d.alexa !== false;
  const places = SC.data.places;
  function drawWhen() {
    $$(".sc-whens").innerHTML = d.when.map((w, i) => {
      const x = `<button class="sc-x" data-wdel="${i}" type="button" aria-label="Remove">×</button>`;
      if (w.t === "time") return `<div class="sc-w" data-i="${i}"><input type="time" class="hub-in" data-k="at" value="${esc(w.at)}" aria-label="Time"><div class="sc-days" role="group" aria-label="Days">${DAYS.map(([n, l]) => `<button type="button" data-day="${n}" aria-pressed="${w.days.includes(n)}">${l}</button>`).join("")}</div><select class="hub-in" data-k="hol" aria-label="Holidays"><option value="also">also on holidays</option><option value="skip">not on holidays</option><option value="only">only on holidays</option></select>${x}</div>`;
      if (w.t === "date") return `<div class="sc-w" data-i="${i}"><input type="date" class="hub-in" data-k="date" value="${esc(w.date || "")}" aria-label="Date"><input type="time" class="hub-in" data-k="at" value="${esc(w.at)}" aria-label="Time"><label class="sc-check"><input type="checkbox" data-k="yearly" ${w.yearly ? "checked" : ""}> every year</label>${x}</div>`;
      if (!places.length) return `<div class="sc-w" data-i="${i}"><span class="sc-tip">Add a place first: <b>Places</b> on the Shortcuts page.</span>${x}</div>`;
      return `<div class="sc-w" data-i="${i}"><select class="hub-in" data-k="on" aria-label="Arrive or leave"><option value="arrive">Arriving at</option><option value="leave">Leaving</option></select><select class="hub-in" data-k="place" aria-label="Place">${places.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>${x}</div>`;
    }).join("") || '<p class="sc-tip">No time or place: it only runs by hand, from Alexa or from its link.</p>';
    box.querySelectorAll(".sc-w").forEach((row) => {
      const w = d.when[row.dataset.i];
      row.querySelectorAll("select[data-k]").forEach((s) => { s.value = w[s.dataset.k] || s.options[0].value; w[s.dataset.k] = s.value; });
    });
  }
  function drawSteps() {
    $$(".sc-stepl").innerHTML = d.steps.map((s, i) => `<div class="sc-s" data-i="${i}"><select class="hub-in" data-k="kind" aria-label="What">${Object.entries(STEP).map(([k, [l]]) => `<option value="${k}" ${k === s.kind ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>${
      NOARG.has(s.kind) ? '<span class="sc-sp"></span>' : s.kind === "key" ? `<select class="hub-in" data-k="arg" aria-label="Key">${Object.entries(KEYS).map(([k, l]) => `<option value="${k}" ${k === s.arg ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>` : `<input class="hub-in" data-k="arg" value="${esc(s.arg || "")}" placeholder="${esc(STEP[s.kind][1])}" autocomplete="off" aria-label="${esc(STEP[s.kind][0])}">`
    }<button class="sc-mv" data-up="${i}" type="button" aria-label="Up" ${i ? "" : "disabled"}>↑</button><button class="sc-mv" data-down="${i}" type="button" aria-label="Down" ${i < d.steps.length - 1 ? "" : "disabled"}>↓</button><button class="sc-x" data-sdel="${i}" type="button" aria-label="Remove">×</button></div>`).join("") || '<p class="sc-tip">No steps yet.</p>';
    box.querySelectorAll('.sc-s select[data-k="arg"]').forEach((s) => { d.steps[s.closest(".sc-s").dataset.i].arg = s.value; });
  }
  drawWhen(); drawSteps();
  box.addEventListener("input", (e) => {
    const t = e.target, k = t.dataset.k, w = t.closest(".sc-w"), s = t.closest(".sc-s");
    if (w && k) d.when[w.dataset.i][k] = t.type === "checkbox" ? t.checked : t.value;
    if (s && k === "kind") { const st = d.steps[s.dataset.i]; st.kind = t.value; st.arg = t.value === "key" ? "playpause" : ""; drawSteps(); return; }
    if (s && k === "arg") d.steps[s.dataset.i].arg = t.value;
  });
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) { if (e.target === box) close(); return; }
    if (b.dataset.copy) return copy(b.dataset.copy);
    if (b.dataset.day != null) { const w = d.when[b.closest(".sc-w").dataset.i], n = Number(b.dataset.day); w.days = w.days.includes(n) ? w.days.filter((x) => x !== n) : [...w.days, n]; b.setAttribute("aria-pressed", String(w.days.includes(n))); return; }
    if (b.dataset.wdel != null) { d.when.splice(Number(b.dataset.wdel), 1); return drawWhen(); }
    if (b.dataset.sdel != null) { d.steps.splice(Number(b.dataset.sdel), 1); return drawSteps(); }
    if (b.dataset.up != null) { const i = Number(b.dataset.up); [d.steps[i - 1], d.steps[i]] = [d.steps[i], d.steps[i - 1]]; return drawSteps(); }
    if (b.dataset.down != null) { const i = Number(b.dataset.down); [d.steps[i + 1], d.steps[i]] = [d.steps[i], d.steps[i + 1]]; return drawSteps(); }
    const add = b.dataset.add;
    if (add === "time") { d.when.push({ t: "time", at: "08:00", days: [0, 1, 2, 3, 4, 5, 6], hol: "also" }); return drawWhen(); }
    if (add === "date") { const t = new Date(Date.now() + 864e5); d.when.push({ t: "date", date: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`, at: "09:00", yearly: false }); return drawWhen(); }
    if (add === "place") { d.when.push({ t: "place", place: places[0] ? places[0].id : "", on: "arrive" }); return drawWhen(); }
    if (add === "step") { d.steps.push({ kind: "app", arg: "" }); drawSteps(); box.querySelector(".sc-s:last-child select").focus(); return; }
    if (b.dataset.ed === "no") return close();
    if (b.dataset.ed === "del") {
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to delete"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; }, 4000); return; }
      try { SC.data = await call({ action: "delete", id: it.id }); close(); render(); toast(`“${it.name}” deleted`); } catch (err) { toast(err.message); }
      return;
    }
    if (b.dataset.ed === "ok") {
      d.name = $$('[data-f="name"]').value.trim(); d.alexa = $$('[data-f="alexa"]').checked;
      d.steps = d.steps.filter((s) => NOARG.has(s.kind) || String(s.arg || "").trim());
      d.when = d.when.filter((w) => w.t !== "place" || w.place);
      if (!d.name) { toast("Give it a name"); $$('[data-f="name"]').focus(); return; }
      if (!d.steps.length) { toast("Add at least one step (and fill it in)"); drawSteps(); return; }
      if (d.when.some((w) => w.t === "time" && !w.days.length)) { toast("Pick at least one day for each time"); return; }
      if (d.when.some((w) => w.t === "date" && !w.date)) { toast("Pick a date"); return; }
      b.disabled = true;
      try { SC.data = await call({ action: "save", item: d }); close(); render(); toast(`“${d.name}” saved on your PC`); } catch (err) { b.disabled = false; toast(err.message); }
    }
  });
  document.body.appendChild(box);
  setTimeout(() => $$('[data-f="name"]').focus(), 30);
}

// ---------- this device's location, while Albatross is open on it ----------
const whereOn = () => { try { return localStorage.getItem("burrow.scWhere") === "1"; } catch { return false; } };
let watchId = null, lastSent = null, whereText = "";
function devId() { try { let v = localStorage.getItem("burrow.scDev"); if (!v) { v = Math.random().toString(36).slice(2, 12); localStorage.setItem("burrow.scDev", v); } return v; } catch { return "device"; } }
const meters = (a, b) => { const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742e3 * Math.asin(Math.sqrt(x)); };
function paintWhere() {
  const el = $("#scWhere"); if (!el) return;
  el.textContent = !whereOn() ? "Off on this device." : !navigator.geolocation ? "This browser can't tell where it is." : whereText || "Waiting for this device's location…";
}
function whereStart(now) {
  if (watchId != null || !whereOn() || !navigator.geolocation || document.hidden) return;
  if (typeof connected === "undefined" || !connected || (typeof guestMode !== "undefined" && guestMode)) return;
  watchId = navigator.geolocation.watchPosition(onPos, (err) => { whereText = "Location: " + err.message; paintWhere(); if (err.code === 1) whereStop(); }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 });
  if (now) paintWhere();
}
function whereStop() { if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId); watchId = null; }
async function onPos(pos) {
  const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords, t = Date.now();
  if (lastSent && (t - lastSent.t < 20000 || (meters(lastSent, { lat, lon }) < 30 && t - lastSent.t < 5 * 60e3))) return;
  lastSent = { lat, lon, t };
  try {
    const r = await call({ action: "where", device: devId(), lat, lon, acc });
    whereText = r.ok ? (r.inside.length ? "Now at: " + r.inside.join(", ") : "Not at any of your places") + (r.ran.length ? " · started " + r.ran.join(", ") : "") + " (" + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ")" : "Not accurate enough yet (" + Math.round(acc) + " m)";
    if (r.ran && r.ran.length) toast("Started: " + r.ran.join(", "));
  } catch (err) { whereText = err.message; lastSent = null; }
  paintWhere();
}
// started once the main page is ready, again whenever the page comes back, and checked every minute (connected may change)
setTimeout(() => whereStart(), 4000);
setInterval(() => whereStart(), 60e3);
document.addEventListener("visibilitychange", () => { if (document.hidden) whereStop(); else whereStart(); });

window.shortcutsOpen = () => { SC.open = true; load(); };
window.shortcutsClose = () => { SC.open = false; };
})();
