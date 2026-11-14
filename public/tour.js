"use strict";
// Help: guided tours and "What's this?". Settings → Help lists the topics; picking one opens the right page and points at each part
// in turn (a spotlight and a short card: Next, Back, Skip, or the arrow keys). "What's this?" explains whatever you click.
// The layer is a popover, so it sits above Settings too (a modal dialog would otherwise cover it).
// Every step names a real element; AlbatrossTour.check() walks all of them and reports the ones that are gone (the smoke test runs it).
(() => {
const $ = (s, r = document) => r.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (v) => `.check:has(${v})`;   // a settings row, found by the switch inside it

// go: "view:<name>" opens that page, "settings:<tab>" opens that Settings tab. before/after: small actions (open a menu, close it).
const TOPICS = [
  { id: "start", name: "Quick tour", about: "The main parts of Albatross, in about a minute.", steps: [
    { go: "view:home", t: "#sidebar", title: "Your chats and tools", text: "Your chats are listed here, newest first. The arrow at the top folds this bar into a thin strip." },
    { t: "#newChat", title: "A fresh chat", text: "Starts a new conversation. Ctrl+Shift+O does the same from anywhere." },
    { t: "#sideNav", title: "Pages", text: "Home. Jarvis, the orb that works your desktop. Notes. Mail. Hub. Monitor, how your PC is doing. Host, your PC and who may connect. List, a to-do list the AI can run for you." },
    { go: "view:chat", t: "#model", title: "Which AI answers", text: "Pick the model. One that can use tools can search the web, build slides, make charts and music, and work on your PC; one with vision can look at pictures." },
    { t: "#prompt", title: "Say what you want", text: "Type here. Enter sends, Shift+Enter starts a new line. You don't pick tools: the AI chooses them when your request needs one." },
    { t: "#effortBtn", title: "How hard it thinks", text: "Low answers at once. Max plans the job, checks its work and asks you when it needs a decision. The next tour explains each level." },
    { t: "#webBtn", title: "Web search", text: "Lets the AI look things up online for this message." },
    { t: "#imgBtn", title: "Make a picture", text: "Turns your next message into a picture, drawn on your PC." },
    { t: "#attachBtn", title: "Attach", text: "Add a picture, or a file for the AI to investigate." },
    { t: "#screenBtn", title: "Help with my screen", text: "The AI looks at the app you were just using, tells you what it sees, and points at the parts that matter with a glowing frame on your screen." },
    { t: "#openSettings", title: "Settings", text: "Everything is adjustable here. The Help tab brings you back to these tours." },
  ] },
  { id: "effort", name: "How hard the AI thinks", about: "Low, Medium, High and Max, and what Max does differently.", steps: [
    { go: "view:chat", t: "#effortBtn", title: "The thinking level", text: "Click it to choose. The level applies to everything the AI does, including slides and songs." },
    { t: "#effortMenu", before: () => { if ($("#effortMenu").hidden) $("#effortBtn").click(); }, after: () => { if (!$("#effortMenu").hidden) $("#effortBtn").click(); }, title: "Four levels",
      text: "Low: quick answers, no thinking. Medium: thinks a little (the default). High: thinks carefully and checks its work. Max: slowest and most thorough. It writes a plan you can watch, does each step with its tools, checks the result, asks you when a real decision matters, and reviews its answer before it finishes." },
  ] },
  { id: "tools", name: "Tools the AI can use", about: "What each switch does, and how to turn the ones you don't want off.", steps: [
    { go: "settings:tools", t: has("#webSearch"), title: "Web search", text: "The AI can look things up online. Also the globe next to the message box." },
    { t: has('[data-tool="slides"]'), title: "Slides", text: "Ask for a presentation and the AI plans it, looks things up, picks photos, writes each slide, checks them and can add a sources slide. You see the plan and the deck grow." },
    { t: "#deckPreset", title: "Your slide look", text: "Fix a design, fonts or animation for every new presentation, or leave it to the AI." },
    { t: has('[data-tool="graph"]'), title: "Graphs", text: "Draws a chart from your numbers or real data." },
    { t: has('[data-tool="chances"]'), title: "Chances & predictions", text: "Estimates how likely something is and how a number may develop." },
    { t: has('[data-tool="music"]'), title: "Music", text: "Composes a piece. The AI decides the style, key, chords and melody idea; Albatross writes the notes so they stay in key. Play it, change the sounds, download MIDI or WAV." },
    { t: has('[data-tool="song"]'), title: "AI songs", text: "Makes a real song, with singing, from style tags and lyrics. It runs on your PC and needs the download below." },
    { t: has('[data-tool="notes"]'), title: "Notes", text: "“Put milk on my shopping list”: the AI writes into your notes." },
    { t: "#docsBox", title: "Documents", text: "Pick folders on your PC; the AI reads them there and answers from your own files, naming the file." },
    { t: "#pcToolsBox", title: "Work on your PC", text: "Lets the chat use your files, mail, browser and printer, and write and run programs. Sending mail and printing always ask you first." },
  ] },
  { id: "music", name: "Music, sounds and songs", about: "Better instrument sounds, comparing them, and AI songs.", steps: [
    { go: "settings:tools", t: "#musicBox", title: "Download once, use always", text: "Better sound banks (MuseScore General, GeneralUser GS) and the AI song model download here, to your PC, only when you ask. A download that stops carries on where it left off." },
    { t: has('[data-tool="music"]'), title: "Compose", text: "Ask for “a calm lo-fi beat”. The result is a card with a piano roll and a Play button." },
    { t: null, title: "On a music card", text: "The Sound menu picks the instrument sounds: classic recordings, or a bank you downloaded (with a recorded drum kit). Compare sounds plays the first seconds with each one in turn so you can hear the difference. Click a track name to mute it." },
    { t: has('[data-tool="song"]'), title: "Real songs", text: "“A summer pop song about the sea”: the AI writes lyrics and style tags and the song model sings it. It takes a minute or two and is saved on your PC." },
  ] },
  { id: "screen", name: "Help with my screen", about: "Let the AI look at your screen and point at what to do.", steps: [
    { go: "view:chat", t: "#screenBtn", title: "One click", text: "Albatross looks at the app you were using before you came here (not at itself), reads what is on it, and answers: what it is, and what you can do." },
    { t: null, title: "Or just ask", text: "“What's on my screen?”, “Where do I click to export this?”, “Help me fill in this form.” The AI points at things with a glowing frame and a short label on your real screen. The frames fade by themselves, or use the tray icon's “Clear highlights”." },
    { t: null, title: "What it can read", text: "Buttons, links and fields that the app exposes to Windows, and, when an app exposes nothing (many games and web apps), the text on the screen itself. With a vision model it also looks at the picture." },
  ] },
  { id: "jarvis", name: "Jarvis", about: "The orb that works your desktop.", steps: [
    { go: "view:jarvis", t: "#jvOrb", title: "The orb", text: "Jarvis lives on your desktop: it hears you, answers, and can open apps and click for you." },
    { t: "#jvInput", title: "Tell it what to do", text: "It lists what is really clickable in the front window (buttons, links, fields, or text it reads off the screen), picks one by number and clicks that exact spot." },
    { t: "#jvStop", title: "Stop", text: "Stops everything it is doing right now." },
  ] },
  { id: "host", name: "Your PC and connections", about: "The host, starting at boot, and connecting other devices.", steps: [
    { go: "view:pc", t: "#pcPage", title: "The host", text: "The host is the part of Albatross that runs on your PC: it talks to your models, files and mail, and answers your phone and other devices. This page shows whether it is running, who may connect, whether it starts when the PC starts, and lets you turn the PC on, put it to sleep or shut it down." },
    { t: "#pcTabs", title: "Switch between the views", text: "Your PC, its status and the connections. Connect Albatross to your PC first (Settings → Connection) and the cards for power and guests appear." },
  ] },
  { id: "warnings", name: "Slowdown warnings", about: "The pop-up that appears in front of your apps.", steps: [
    { go: "settings:help", t: "#healthRow", title: "A warning in front of everything", text: "When something slows Albatross down or stops it (graphics memory full, the AI model spilling onto the CPU, Ollama not answering, low disk space), a small card appears in the corner of your screen, in front of your other apps. It offers a fix when there is one, and you can snooze it or turn it off here." },
  ] },
];
const HELP = TOPICS.flatMap((t) => t.steps.filter((s) => s.t).map((s) => ({ sel: s.t, title: s.title, text: s.text })));

let root = null, state = null, whats = null;
function ensure() {
  if (root) return root;
  root = document.createElement("div"); root.id = "tour"; root.setAttribute("popover", "manual");
  root.innerHTML = '<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-live="polite"><div class="tour-step"></div><h3></h3><p></p><div class="tour-btns"><button class="btn small" type="button" data-a="skip">Skip</button><span style="flex:1"></span><button class="btn small" type="button" data-a="back">Back</button><button class="btn small primary" type="button" data-a="next">Next</button></div></div>';
  document.body.appendChild(root);
  // the buttons' clicks stay inside the tour: the page closes its menus on any click outside them, which would shut the one a step has just opened
  root.querySelector('[data-a="skip"]').onclick = (e) => { e.stopPropagation(); stop(); };
  root.querySelector('[data-a="back"]').onclick = (e) => { e.stopPropagation(); step(state.i - 1); };
  root.querySelector('[data-a="next"]').onclick = (e) => { e.stopPropagation(); step(state.i + 1); };
  addEventListener("keydown", (e) => {
    if (!state) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); step(state.i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); step(state.i - 1); }
  }, true);
  addEventListener("resize", () => { if (state && state.el) place(null, null, state.el); });
  // anything that scrolls (the Settings pane, the page) takes the spotlight with it
  addEventListener("scroll", () => { if (state && state.el) requestAnimationFrame(() => state && state.el && place(null, null, state.el)); }, true);
  return root;
}
function top() { const r = ensure(); try { if (r.matches(":popover-open")) r.hidePopover(); r.showPopover(); } catch {} }   // re-shown, so it is above a dialog opened since
async function go(spec) {
  const dlg = $("#settings");
  if (!spec) return;
  if (spec.startsWith("settings:")) { if (!dlg.open) openSettings(spec.slice(9)); else $(`#settings .tabs [data-tab="${spec.slice(9)}"]`)?.click(); }
  else { if (dlg.open) dlg.close(); if (spec.startsWith("view:")) setView(spec.slice(5)); }
  await wait(180);
}
const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
async function find(sel) {
  if (!sel) return null;
  for (let i = 0; i < 12; i++) { const el = $(sel); if (visible(el)) return el; await wait(50); }
  return null;
}
// found, scrolled into view, and really on top where it is (not behind a dialog, not folded away): else the step has nothing to point at
function reachable(el) {
  const b = el.getBoundingClientRect(), x = Math.min(innerWidth - 2, Math.max(2, b.left + b.width / 2)), y = Math.min(innerHeight - 2, Math.max(2, b.top + b.height / 2));
  if (root) root.classList.add("probing");   // the tour's own layer ignores the pointer while we ask what is under that spot
  const hit = document.elementFromPoint(x, y); if (root) root.classList.remove("probing");
  return !!hit && (el.contains(hit) || hit.contains(el));
}
async function locate(sel) {
  const el = await find(sel);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  await wait(60);
  return reachable(el) ? el : null;
}
function place(hole, card, target) {
  const r = root, h = r.querySelector(".tour-hole"), c = r.querySelector(".tour-card"), vw = innerWidth, vh = innerHeight, pad = 8, cw = Math.min(340, vw - 24);
  c.style.width = cw + "px";
  if (!target) { h.style.opacity = "0"; c.style.left = Math.max(12, (vw - cw) / 2) + "px"; c.style.top = Math.max(12, vh / 2 - c.offsetHeight / 2) + "px"; return; }
  const b = target.getBoundingClientRect();
  h.style.opacity = "1"; h.style.left = b.left - pad + "px"; h.style.top = b.top - pad + "px"; h.style.width = b.width + pad * 2 + "px"; h.style.height = b.height + pad * 2 + "px";
  const ch = c.offsetHeight, room = { right: vw - b.right, left: b.left, bottom: vh - b.bottom, top: b.top };
  let x, y;
  if (room.right >= cw + 24) { x = b.right + pad + 12; y = b.top + b.height / 2 - ch / 2; }
  else if (room.left >= cw + 24) { x = b.left - pad - 12 - cw; y = b.top + b.height / 2 - ch / 2; }
  else if (room.bottom >= ch + 24) { x = b.left + b.width / 2 - cw / 2; y = b.bottom + pad + 12; }
  else { x = b.left + b.width / 2 - cw / 2; y = b.top - pad - 12 - ch; }
  c.style.left = Math.min(vw - cw - 12, Math.max(12, x)) + "px"; c.style.top = Math.min(vh - ch - 12, Math.max(12, y)) + "px";
}
async function step(i) {
  const s = state;
  if (!s) return;
  if (i < 0) i = 0;
  if (i >= s.topic.steps.length) return stop();
  const prev = s.topic.steps[s.i]; if (prev && prev.after && i !== s.i) { try { prev.after(); } catch {} }
  s.i = i; const st = s.topic.steps[i];
  if (st.go) await go(st.go);
  if (st.before) { try { st.before(); } catch {} await wait(120); }
  const el = await locate(st.t);   // scrolled into view instantly (not smooth: the spotlight is measured right after)
  if (!state || state.i !== i) return;
  state.el = el;
  top();
  const c = root.querySelector(".tour-card");
  c.querySelector(".tour-step").textContent = `${s.topic.name} · ${i + 1} of ${s.topic.steps.length}`;
  c.querySelector("h3").textContent = st.title; c.querySelector("p").textContent = st.text;
  root.querySelector('[data-a="back"]').hidden = i === 0;
  root.querySelector('[data-a="next"]').textContent = i === s.topic.steps.length - 1 ? "Done" : "Next";
  root.dataset.mode = "tour";
  await wait(30); place(null, null, el);
  c.querySelector('[data-a="next"]')?.focus?.();
}
async function start(id) {
  const topic = TOPICS.find((t) => t.id === id) || TOPICS[0];
  stop(); ensure();
  const dlg = $("#settings"); if (dlg.open && !String(topic.steps[0].go || "").startsWith("settings:")) dlg.close();
  state = { topic, i: -1 };
  await step(0);
}
function stop() {
  if (state) { const st = state.topic.steps[state.i]; if (st && st.after) { try { st.after(); } catch {} } }
  state = null; whats = null;
  if (root) { try { if (root.matches(":popover-open")) root.hidePopover(); } catch {} root.dataset.mode = ""; }
}
// "What's this?": click anything, read what it does
function helpFor(el) {
  for (const h of HELP) { try { if (el.closest(h.sel)) return h; } catch {} }
  const own = el.closest("[title],[aria-label]");
  const text = own && (own.getAttribute("title") || own.getAttribute("aria-label"));
  return text ? { title: (el.closest("button,a,label,summary") || el).textContent.trim().slice(0, 40) || "This", text } : null;
}
function whatsThis() {
  stop(); ensure();
  const dlg = $("#settings"); if (dlg.open) dlg.close();
  whats = { on: true }; top();
  root.dataset.mode = "whats";
  const c = root.querySelector(".tour-card"), h = root.querySelector(".tour-hole");
  c.querySelector(".tour-step").textContent = "What's this?"; c.querySelector("h3").textContent = "Click anything"; c.querySelector("p").textContent = "Click any part of Albatross and it says what it does. Esc to stop.";
  root.querySelector('[data-a="back"]').hidden = true; root.querySelector('[data-a="next"]').textContent = "Done";
  h.style.opacity = "0"; c.style.left = "50%"; c.style.top = "20px"; c.style.transform = "translateX(-50%)";
  const stopW = () => { document.removeEventListener("click", onClick, true); document.removeEventListener("keydown", onKey, true); c.style.transform = ""; stop(); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopW(); } };
  const onClick = (e) => {
    if (e.target.closest(".tour-card")) { if (e.target.closest("[data-a]")) stopW(); return; }
    e.preventDefault(); e.stopPropagation();
    root.style.pointerEvents = "none"; const under = document.elementFromPoint(e.clientX, e.clientY); root.style.pointerEvents = "";
    const el = under && under !== root ? under : null, info = el && helpFor(el);
    const target = el && (info ? el.closest(HELP.find((x) => x.title === info.title)?.sel || "*") || el : el.closest("button,a,label,summary,input,select") || el);
    c.querySelector("h3").textContent = info ? info.title : "No help for this yet"; c.querySelector("p").textContent = info ? info.text : "Try a button, a menu or a switch.";
    c.style.transform = "";
    if (target && visible(target)) { place(null, null, target); } else { h.style.opacity = "0"; }
  };
  document.addEventListener("click", onClick, true); document.addEventListener("keydown", onKey, true);
}
// walks every step and reports the ones whose element is missing: so a tour can't quietly rot
async function check() {
  const bad = [];
  for (const t of TOPICS) for (const [i, s] of t.steps.entries()) {
    if (s.go) await go(s.go);
    if (s.before) { try { s.before(); } catch {} await wait(100); }
    if (s.t) { const el = await locate(s.t); if (!el) bad.push(`${t.id} #${i + 1} (${s.title}): ${s.t}`); }
    if (s.after) { try { s.after(); } catch {} }
  }
  const dlg = $("#settings"); if (dlg.open) dlg.close();
  return bad;
}
// Settings → Help
function paintHelp() {
  const box = $("#helpTopics"); if (!box) return;
  box.innerHTML = "";
  for (const t of TOPICS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "help-topic";
    b.innerHTML = "<b></b><small></small><span>Show me ›</span>"; b.querySelector("b").textContent = t.name; b.querySelector("small").textContent = t.about;
    b.onclick = () => { const d = $("#settings"); const needsSettings = String(t.steps[0].go || "").startsWith("settings:"); if (d.open && !needsSettings) d.close(); start(t.id); };
    box.appendChild(b);
  }
  const w = $("#helpWhats"); if (w) w.onclick = () => whatsThis();
}
window.AlbatrossTour = { start, stop, whatsThis, check, paintHelp, TOPICS };
document.addEventListener("DOMContentLoaded", paintHelp);
if (document.readyState !== "loading") paintHelp();
})();
