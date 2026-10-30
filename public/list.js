"use strict";
// The List in the sidebar: several requests written at once, run on the PC one after the other (host/list.js), e.g.
// "picture: a red fox" 3 times, then "text: write a story about the fox". It keeps going when this page is closed. The results go
// into the chat that is open (or a new one, if picked), on the PC, and show up here as they come. Typing "image 3x: a fox" or
// "text: …" sets the kind and the count by itself, and pasting several such lines makes several steps. {previous} in a prompt is
// the last text answer. While a list writes into a chat, that chat only takes the PC's copy (window.listBusy, see syncChats).
// Uses the main page's helpers: $, $$, S, saveSettings, toast, pcCall, connected, models, chats, current, pickImageModel,
// buildOptions, effortNow, syncChats, syncOn, pushChat, openChat, saveChats, renderSidebar, applyRail.
(() => {
let runs = [], pollT = 0, lastSaved = {}, targetT = 0;
window.listBusy = new Set();     // chats a list on the PC is writing into right now
const draft = () => { if (!Array.isArray(S.listDraft) || !S.listDraft.length) S.listDraft = [{ kind: "image", prompt: "", times: 1, model: "" }]; return S.listDraft; };
const textModels = () => models.filter((m) => (m.kind === "text" || m.kind === "vision") && !m.cloud);
const picModels = () => models.filter((m) => m.kind === "image");
function textModel() { const l = textModels(); return (l.find((m) => m.name === S.model) || l[0])?.name || ""; }
// where the results go: the open chat, unless "a new chat" is picked (or the open one can't be on the PC)
function target() {
  if (S.listInto === "new" || !current) return null;
  if (current.deviceOnly || (typeof syncOn === "function" && !syncOn())) return null;
  return current;
}
function showTarget() {
  const el = $("#lpTarget"); if (!el) return;
  const t = target();
  el.textContent = S.listInto === "new" ? "Starts a new chat" : t ? "“" + (t.messages.length ? t.title : "New chat") + "”"
    : current && current.deviceOnly ? "This chat is only on this device: a new chat on the PC" : !current ? "No chat open: a new chat" : "Chats aren't kept on the PC: a new chat";
}

// "image 3x: a fox", "picture ×2 - …", "text: …", "3x image: …" -> { kind, times, prompt }
const PREFIX = /^\s*(?:(\d{1,2})\s*[x×]\s*)?(image|picture|pic|img|bild|draw|text|chat|ask|frage)\b\s*(?:(?:[x×]\s*(\d{1,2})|(\d{1,2})\s*[x×]|(\d{1,2})\s*times?))?\s*[:\-–]\s*([\s\S]*)$/i;
function parse(line) {
  const m = PREFIX.exec(line); if (!m) return null;
  const kind = /^(text|chat|ask|frage)$/i.test(m[2]) ? "text" : "image";
  const times = Number(m[1] || m[3] || m[4] || m[5]) || 1;
  return { kind, times: Math.min(20, Math.max(1, times)), prompt: m[6].trim() };
}

function panel() { return $("#listPanel"); }
function open(on) {
  const p = panel(); if (!p) return;
  if (on === undefined) on = p.hidden;
  if (on && S.sideRail) { S.sideRail = false; saveSettings(); applyRail(); }
  p.hidden = !on; $("#goList").classList.toggle("on", on);
  clearInterval(targetT);
  if (on) { draw(); poll(); targetT = setInterval(showTarget, 1000); const t = p.querySelector("textarea"); if (t && !t.value) t.focus(); }
}

function draw() {
  const p = panel(); if (!p || p.hidden) return;
  const steps = draft();
  p.innerHTML = `<div class="lp-head"><b>List</b><small>Runs on your PC, one after another</small><button class="icon-btn lp-close" type="button" aria-label="Close the list" title="Close">×</button></div>
    <div class="lp-into"><span>Into</span><select id="lpInto" aria-label="Where the results go"><option value="current">the open chat</option><option value="new">a new chat</option></select><small id="lpTarget"></small></div>
    <div class="lp-steps"></div>
    <div class="lp-add"><button class="btn small" type="button" data-add="image">+ Picture</button><button class="btn small" type="button" data-add="text">+ Text</button></div>
    <div class="lp-run"><button class="btn small primary" type="button" id="lpRun">Run on PC</button><button class="btn small" type="button" id="lpClear">Clear</button></div>
    <small class="lp-hint">Tip: type “image 3x: a red fox” or “text: …”. {previous} puts in the last text answer.</small>
    <div class="lp-runs"></div>`;
  const box = p.querySelector(".lp-steps");
  steps.forEach((s, i) => box.appendChild(stepEl(s, i)));
  p.querySelector(".lp-close").onclick = () => open(false);
  for (const b of p.querySelectorAll("[data-add]")) b.onclick = () => { draft().push({ kind: b.dataset.add, prompt: "", times: 1, model: "" }); saveSettings(); draw(); const t = [...p.querySelectorAll("textarea")].pop(); if (t) t.focus(); };
  $("#lpRun").onclick = run;
  $("#lpInto").value = S.listInto === "new" ? "new" : "current";
  $("#lpInto").onchange = (e) => { S.listInto = e.target.value; saveSettings(); showTarget(); };
  showTarget();
  $("#lpClear").onclick = () => { S.listDraft = []; saveSettings(); draw(); };
  drawRuns();
}
function stepEl(s, i) {
  const steps = draft();
  const d = document.createElement("div"); d.className = "lp-step k-" + s.kind;
  const list = s.kind === "image" ? picModels() : textModels();
  const def = s.kind === "image" ? pickImageModel() : textModel();
  d.innerHTML = `<div class="lp-top"><span class="lp-n">${i + 1}</span>
      <div class="seg lp-kind"><button type="button" data-k="image">Picture</button><button type="button" data-k="text">Text</button></div>
      <label class="lp-times" title="How many times">×<input type="number" min="1" max="20" aria-label="How many times"></label>
      <span class="lp-tools"><button type="button" class="lp-mv" data-d="-1" aria-label="Move up" title="Move up"${i ? "" : " disabled"}>↑</button><button type="button" class="lp-mv" data-d="1" aria-label="Move down" title="Move down"${i < steps.length - 1 ? "" : " disabled"}>↓</button><button type="button" class="lp-x" aria-label="Remove" title="Remove">×</button></span></div>
    <textarea rows="2" placeholder="${s.kind === "image" ? "What to draw…" : "What to ask or write…"}"></textarea>
    <select class="lp-model" aria-label="Model"><option value="">${def ? "Default · " + def : "Default model"}</option></select>`;
  for (const b of d.querySelectorAll(".lp-kind button")) { b.classList.toggle("on", b.dataset.k === s.kind); b.onclick = () => { s.kind = b.dataset.k; s.model = ""; saveSettings(); draw(); }; }
  const sel = d.querySelector(".lp-model");
  for (const m of list) { const o = document.createElement("option"); o.value = m.name; o.textContent = m.name; sel.appendChild(o); }
  sel.value = list.some((m) => m.name === s.model) ? s.model : "";
  sel.onchange = () => { s.model = sel.value; saveSettings(); };
  const tm = d.querySelector(".lp-times input"); tm.value = s.times;
  tm.onchange = () => { s.times = Math.min(20, Math.max(1, Math.round(Number(tm.value) || 1))); tm.value = s.times; saveSettings(); };
  const ta = d.querySelector("textarea"); ta.value = s.prompt;
  ta.oninput = () => { s.prompt = ta.value; saveSettings(); };
  // "image 3x: …" sets the kind and count; several such lines pasted at once become several steps
  ta.onblur = () => {
    const lines = ta.value.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map(parse);
    if (lines.length > 1 && parsed.every(Boolean)) {
      steps.splice(steps.indexOf(s), 1, ...parsed.map((x) => ({ ...x, model: "" }))); saveSettings(); draw(); return;
    }
    const one = parse(ta.value);
    if (one && one.prompt) { s.kind = one.kind; s.times = one.times; s.prompt = one.prompt; if (!(s.kind === "image" ? picModels() : textModels()).some((m) => m.name === s.model)) s.model = ""; saveSettings(); draw(); }
  };
  for (const b of d.querySelectorAll(".lp-mv")) b.onclick = () => { const j = i + Number(b.dataset.d); [steps[i], steps[j]] = [steps[j], steps[i]]; saveSettings(); draw(); };
  d.querySelector(".lp-x").onclick = () => { steps.splice(i, 1); saveSettings(); draw(); };
  return d;
}

async function run() {
  if (document.activeElement && document.activeElement.tagName === "TEXTAREA") document.activeElement.blur();   // finish "image 3x: …"
  const steps = draft().filter((s) => s.prompt.trim());
  if (!steps.length) return toast("Write at least one request first");
  if (!connected) return toast("Connect to your PC first");
  const tm = textModel();
  if (steps.some((s) => s.kind === "image") && !picModels().length) return toast("The PC has no picture model");
  if (steps.some((s) => s.kind === "text") && !tm && steps.some((s) => s.kind === "text" && !s.model)) return toast("The PC has no chat model");
  const [w, h] = (S.img.size || "1024x1024").split("x").map(Number);
  const opt = typeof buildOptions === "function" ? buildOptions(tm) : {};
  const body = {
    action: "start", steps: steps.map((s) => ({ kind: s.kind, prompt: s.prompt.trim(), times: s.times, model: s.model })),
    imageModel: pickImageModel(), textModel: tm,
    image: { width: w, height: h, steps: S.img.steps ? Number(S.img.steps) : 0, seed: S.img.seed === "" ? "" : Number(S.img.seed), keepMinutes: S.img.keep || 10, style: S.img.style || "" },
    text: { think: typeof effortNow === "function" ? effortNow() !== "low" : S.think !== false, options: opt, system: S.defaultSystem || "", keepAlive: S.keepAlive === "" ? undefined : /^-?\d+$/.test(S.keepAlive) ? Number(S.keepAlive) : S.keepAlive },
  };
  const into = target();
  if (into && window.listBusy.has(into.id)) return toast("A list is already writing into this chat: wait for it or stop it");
  $("#lpRun").disabled = true;
  try {
    // the PC must have this chat as it is now, so the results are added to it (and nothing written here gets lost)
    if (into) { body.chatId = into.id; body.title = into.messages.length ? into.title : ""; await pushChat(into); }
    const r = await pcCall("/pc/list", body);
    if (into) window.listBusy.add(into.id);
    const n = steps.reduce((t, s) => t + s.times, 0);
    toast(`The list runs on your PC: ${n} request${n > 1 ? "s" : ""}, into ${into ? "this chat" : "a new chat"}. You can close this page; it keeps going.`);
    if (!into && r.chatId) lastSaved[r.id] = 0;
    poll();
  } catch (e) { toast("Couldn't start the list: " + e.message); }
  finally { const b = $("#lpRun"); if (b) b.disabled = false; }
}

// ---------- lists on the PC: progress, stop, open the chat ----------
async function poll() {
  clearTimeout(pollT);
  if (!connected || document.hidden) { pollT = setTimeout(poll, 8000); return; }
  try { runs = (await pcCall("/pc/list", null, "GET")).lists || []; } catch { runs = []; }
  let fresh = false;
  for (const r of runs) { if (r.saved && lastSaved[r.id] !== r.saved) { if (lastSaved[r.id] !== undefined) fresh = true; lastSaved[r.id] = r.saved; } }
  const was = window.listBusy;
  window.listBusy = new Set(runs.filter((r) => !r.finished).map((r) => r.chatId));
  if ([...was].some((id) => !window.listBusy.has(id))) fresh = true;      // one just finished: take its last results
  if (fresh && typeof syncChats === "function") syncChats();             // a new picture or answer in the list's chat
  drawRuns();
  const busy = runs.some((r) => !r.finished);
  const p = panel();
  if (busy || (p && !p.hidden)) pollT = setTimeout(poll, busy ? 2500 : 10000);
}
const STATUS = { waiting: "Waiting", running: "Running", done: "Done", stopped: "Stopped", failed: "Failed", "finished with errors": "Done, with errors" };
function drawRuns() {
  const p = panel(); const box = p && p.querySelector(".lp-runs"); if (!box) return;
  $("#goList").classList.toggle("busy", runs.some((r) => !r.finished));
  box.innerHTML = runs.length ? "<h4>On the PC</h4>" : "";
  for (const r of runs.slice(0, 8)) {
    const d = document.createElement("div"); d.className = "lp-runc " + (r.finished ? "fin" : "live");
    const s = r.steps[r.step] || r.steps[0];
    const now = r.status === "running" && s ? `Step ${r.step + 1} of ${r.steps.length} · ${s.kind === "image" ? "picture" : "answer"} ${r.rep + 1} of ${s.times}${r.progress ? " · " + r.progress : ""}${r.pct != null ? " " + r.pct + "%" : ""}` : "";
    const pct = r.total ? ((r.done + (r.status === "running" && r.pct != null ? r.pct / 100 : 0)) / r.total) * 100 : 0;
    d.innerHTML = `<div class="lp-rh"><b></b><span class="lp-st"></span></div><small class="lp-now"></small><div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="lp-rb">${r.finished ? "" : '<button class="btn small" type="button" data-a="stop">Stop</button>'}<button class="btn small" type="button" data-a="open">Open chat</button>${r.finished ? '<button class="btn small" type="button" data-a="again">Edit again</button><button class="icon-btn" type="button" data-a="remove" aria-label="Remove from this list" title="Remove">×</button>' : ""}</div>`;
    d.querySelector("b").textContent = r.title;
    d.querySelector(".lp-st").textContent = `${STATUS[r.status] || r.status} · ${r.done}/${r.total}`;
    d.querySelector(".lp-now").textContent = now || (r.error ? r.error : r.steps.map((x) => `${x.kind === "image" ? "🖼" : "💬"} ${x.times > 1 ? x.times + "× " : ""}${x.prompt.slice(0, 40)}`).join(" → "));
    for (const b of d.querySelectorAll("[data-a]")) b.onclick = () => runAction(r, b.dataset.a);
    box.appendChild(d);
  }
}
async function runAction(r, a) {
  try {
    if (a === "stop") { await pcCall("/pc/list", { action: "stop", id: r.id }); poll(); }
    if (a === "remove") { await pcCall("/pc/list", { action: "remove", id: r.id }); poll(); }
    if (a === "again") { S.listDraft = r.steps.map((s) => ({ kind: s.kind, prompt: s.prompt, times: s.times, model: s.model })); saveSettings(); draw(); }
    if (a === "open") {
      if (typeof syncChats === "function") await syncChats();
      let c = chats.find((x) => x.id === r.chatId);
      if (!c) { const g = (await pcCall("/chats/get", { id: r.chatId })).chat; chats.unshift(g); c = g; saveChats(); renderSidebar(); }
      openChat(c);
    }
  } catch (e) { toast(e.message); }
}

$("#goList").onclick = () => open();
window.listRefresh = () => { if (connected) poll(); };
// see lists that are still running on the PC after a reload
setTimeout(() => { if (connected) poll(); }, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && runs.some((r) => !r.finished)) poll(); });
})();
