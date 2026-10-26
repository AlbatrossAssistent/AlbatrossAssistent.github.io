"use strict";
// Notes: yellow sticky notes on a page of their own, with many kinds of lists (bullets, numbers, a/b/c, I/II/III, checklist,
// priorities, plain text). Pinned ones show on a yellow card when Albatross opens. The AI writes into them as a chat tool
// ("put milk on my shopping list"). They live in the settings (S.notes), so a signed-in account carries them to other devices.
// Uses the main page's helpers: $, esc, S, saveSettings, toast, setView, toolAnswer, current.
(() => {
const KINDS = [["bullets", "• Bullets"], ["numbers", "1. Numbered"], ["checklist", "☑ Checklist"], ["letters", "a) Letters"], ["roman", "I. Roman"], ["priority", "● Priority"], ["text", "¶ Text"]];
const PAPERS = ["yellow", "orange", "pink", "green", "blue"];
const notes = () => (S.notes = Array.isArray(S.notes) ? S.notes : []);
const nid = () => "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ROMAN = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
const roman = (n) => ROMAN.reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, "");
const letter = (i) => (i >= 26 ? letter(Math.floor(i / 26) - 1) : "") + String.fromCharCode(97 + (i % 26));
const PRIO = ["", "high", "medium", "low"];
function marker(kind, i, it) {
  if (kind === "numbers") return (i + 1) + ".";
  if (kind === "letters") return letter(i) + ")";
  if (kind === "roman") return roman(i + 1) + ".";
  if (kind === "checklist") return it.done ? "☑" : "☐";
  if (kind === "priority") return "●";
  return "•";
}
let saveTimer = 0;
const save = (n) => { if (n) n.updated = Date.now(); clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 350); };
const make = (title, kind, items, text) => ({ id: nid(), title: title || "", kind: kind || "bullets", items: (items || []).map((t) => (typeof t === "string" ? { t } : t)), text: text || "", paper: "yellow", pinned: false, updated: Date.now() });

// ---------- one note, editable (the Notes page) or as a small card (the chat, the opening card) ----------
function noteEl(n, { edit = true, onChange } = {}) {
  const el = document.createElement("article"); el.className = "note paper-" + (PAPERS.includes(n.paper) ? n.paper : "yellow") + (edit ? "" : " mini"); el.dataset.id = n.id;
  const changed = () => { save(n); onChange && onChange(); };
  const head = document.createElement("div"); head.className = "note-head";
  const title = document.createElement(edit ? "input" : "b"); title.className = "note-title";
  if (edit) { title.value = n.title; title.placeholder = "Title"; title.oninput = () => { n.title = title.value; changed(); }; } else title.textContent = n.title || "Note";
  head.appendChild(title);
  if (edit) {
    const kind = document.createElement("select"); kind.className = "note-kind"; kind.setAttribute("aria-label", "Kind of list");
    kind.innerHTML = KINDS.map(([k, l]) => `<option value="${k}"${k === n.kind ? " selected" : ""}>${l}</option>`).join("");
    kind.onchange = () => {
      const was = n.kind; n.kind = kind.value;
      if (n.kind === "text" && was !== "text") n.text = (n.text ? n.text + "\n" : "") + n.items.map((x) => x.t).filter(Boolean).join("\n");
      if (n.kind !== "text" && was === "text") { n.items = n.text.split("\n").map((t) => t.replace(/^\s*([-*•]|\d+[.)]|[a-z][.)]|[ivxlc]+\.|\[[ x]\])\s*/i, "").trim()).filter(Boolean).map((t) => ({ t })); n.text = ""; }
      changed(); redrawNote(el, n, onChange);
    };
    const pin = document.createElement("button"); pin.type = "button"; pin.className = "note-btn" + (n.pinned ? " on" : ""); pin.title = n.pinned ? "Pinned: shows when Albatross opens" : "Pin: show it when Albatross opens"; pin.setAttribute("aria-pressed", String(!!n.pinned));
    pin.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M9 4h6l-1 6 4 4H6l4-4zM12 14v6"/></svg>';
    pin.onclick = () => { n.pinned = !n.pinned; changed(); redrawNote(el, n, onChange); };
    const paper = document.createElement("button"); paper.type = "button"; paper.className = "note-btn"; paper.title = "Paper colour";
    paper.innerHTML = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>';
    paper.onclick = () => { n.paper = PAPERS[(PAPERS.indexOf(n.paper) + 1) % PAPERS.length]; changed(); redrawNote(el, n, onChange); };
    const del = document.createElement("button"); del.type = "button"; del.className = "note-btn"; del.title = "Delete this note";
    del.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
    del.onclick = () => {
      const list = notes(), i = list.indexOf(n); if (i < 0) return;
      list.splice(i, 1); saveSettings(); renderPage();
      toast("Note deleted", { action: "Undo", onAction: () => { notes().splice(i, 0, n); saveSettings(); renderPage(); } });
    };
    head.append(kind, pin, paper, del);
  } else if (n.pinned) head.insertAdjacentHTML("beforeend", '<svg class="i note-pinmark" viewBox="0 0 24 24" aria-label="pinned"><path d="M9 4h6l-1 6 4 4H6l4-4zM12 14v6"/></svg>');
  el.appendChild(head);

  if (n.kind === "text") {
    if (edit) {
      const ta = document.createElement("textarea"); ta.className = "note-text"; ta.value = n.text; ta.placeholder = "Write something…"; ta.rows = 3;
      const grow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
      ta.oninput = () => { n.text = ta.value; grow(); changed(); }; requestAnimationFrame(grow);
      el.appendChild(ta);
    } else { const p = document.createElement("p"); p.className = "note-text"; p.textContent = n.text || "(empty)"; el.appendChild(p); }
    return el;
  }
  const ol = document.createElement("ol"); ol.className = "note-items kind-" + n.kind;
  const rows = edit ? n.items.concat([]) : n.items;
  rows.forEach((it, i) => ol.appendChild(itemEl(n, it, i, edit, changed, el, onChange)));
  if (!edit && !n.items.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "(empty)"; ol.appendChild(li); }
  el.appendChild(ol);
  if (edit) {
    const add = document.createElement("button"); add.type = "button"; add.className = "note-add"; add.textContent = "+ Add a line";
    add.onclick = () => { n.items.push({ t: "" }); changed(); redrawNote(el, n, onChange); el.querySelector(".note-items li:last-child input")?.focus(); };
    el.appendChild(add);
  }
  return el;
}
function itemEl(n, it, i, edit, changed, el, onChange) {
  const li = document.createElement("li"); li.className = (it.done ? "done " : "") + (n.kind === "priority" ? "prio-" + (PRIO[it.p || 2]) : "");
  const mk = document.createElement(n.kind === "checklist" || n.kind === "priority" ? "button" : "span"); mk.className = "mk"; mk.textContent = marker(n.kind, i, it);
  if (mk.tagName === "BUTTON") {
    mk.type = "button";
    mk.title = n.kind === "checklist" ? (it.done ? "Done: click to undo" : "Click when done") : `Priority: ${PRIO[it.p || 2]} (click to change)`;
    mk.onclick = () => { if (n.kind === "checklist") it.done = !it.done; else it.p = ((it.p || 2) % 3) + 1; changed(); redrawNote(el, n, onChange); };
  }
  li.appendChild(mk);
  if (edit) {
    const inp = document.createElement("input"); inp.value = it.t; inp.placeholder = "…";
    inp.oninput = () => { it.t = inp.value; changed(); };
    inp.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); n.items.splice(i + 1, 0, { t: "" }); changed(); redrawNote(el, n, onChange); el.querySelectorAll(".note-items li input")[i + 1]?.focus(); }
      else if (e.key === "Backspace" && !inp.value && n.items.length > 1) { e.preventDefault(); n.items.splice(i, 1); changed(); redrawNote(el, n, onChange); const ins = el.querySelectorAll(".note-items li input"); ins[Math.max(0, i - 1)]?.focus(); }
      else if (e.key === "ArrowDown") el.querySelectorAll(".note-items li input")[i + 1]?.focus();
      else if (e.key === "ArrowUp") el.querySelectorAll(".note-items li input")[i - 1]?.focus();
    };
    li.appendChild(inp);
  } else { const s = document.createElement("span"); s.className = "tx"; s.textContent = it.t; li.appendChild(s); }
  return li;
}
function redrawNote(el, n, onChange) { const fresh = noteEl(n, { edit: !el.classList.contains("mini"), onChange }); el.replaceWith(fresh); return fresh; }

// ---------- the Notes page ----------
function renderPage() {
  const page = $("#notesPage"); if (!page) return;
  const list = notes().slice().sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  page.innerHTML = `<div class="home-inner notes-inner">
    <div class="home-hero notes-hero"><svg class="pc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M8 9h8M8 13h5"/></svg><h1>Notes</h1><p>Lists and thoughts, kept with your settings. Ask the AI too: “put milk on my shopping list”.</p></div>
    <div class="notes-bar"><button class="btn primary" id="noteNew" type="button">+ New note</button><span style="flex:1"></span>
      <label class="notes-open"><input type="checkbox" class="switch" id="notesOnOpen"> Show my notes full screen when Albatross opens</label></div>
    <div class="notes-grid"></div></div>`;
  const grid = page.querySelector(".notes-grid");
  if (!list.length) grid.innerHTML = '<div class="empty-note">No notes yet. Make one with “New note”, or ask the AI to write one.</div>';
  for (const n of list) grid.appendChild(noteEl(n));
  $("#noteNew").onclick = () => { const n = make("", "bullets", [""]); notes().unshift(n); saveSettings(); renderPage(); page.querySelector(".note .note-title")?.focus(); };
  const sw = $("#notesOnOpen"); sw.checked = S.notesOnOpen !== false; sw.onchange = () => { S.notesOnOpen = sw.checked; saveSettings(); };
}
window.notesOpen = renderPage;

// ---------- when Albatross opens: the notes fill the whole screen, on plain yellow, until you close them ----------
// The pinned notes, or all of them when none is pinned; you can write in them right there.
window.notesOnStart = function () {
  const list = notes(), show = list.some((n) => n.pinned) ? list.filter((n) => n.pinned) : list;
  if (S.notesOnOpen === false || !show.length) return;
  const full = document.createElement("div"); full.className = "notes-full"; full.setAttribute("role", "dialog"); full.setAttribute("aria-label", "Your notes");
  full.innerHTML = `<div class="nf-head"><h1>Your notes</h1><span style="flex:1"></span><button class="nf-btn" type="button" data-a="new">+ New note</button><button class="nf-btn" type="button" data-a="open">All notes</button><button class="nf-btn nf-go" type="button" data-a="x">Continue</button></div><div class="nf-grid"></div>`;
  const grid = full.querySelector(".nf-grid");
  const draw = () => { grid.innerHTML = ""; for (const n of (notes().some((x) => x.pinned) ? notes().filter((x) => x.pinned) : notes())) grid.appendChild(noteEl(n, { onChange: () => {} })); };
  draw();
  const close = () => { removeEventListener("keydown", key); full.classList.remove("in"); setTimeout(() => full.remove(), 450); if (document.body.classList.contains("notes-view")) renderPage(); };
  const key = (e) => { if (e.key === "Escape" && !e.target.closest("input, textarea, select")) close(); };
  addEventListener("keydown", key);
  full.querySelector('[data-a="x"]').onclick = close;
  full.querySelector('[data-a="open"]').onclick = () => { close(); setView("notes"); };
  full.querySelector('[data-a="new"]').onclick = () => { const n = make("", "bullets", [""]); n.pinned = true; notes().unshift(n); saveSettings(); draw(); grid.querySelector(".note .note-title")?.focus(); };
  document.body.appendChild(full); setTimeout(() => full.classList.add("in"), S.intro ? 3300 : 50);
};

// ---------- the chat tool: the AI reads and changes the notes ----------
function findNote(title) {
  const t = String(title || "").trim().toLowerCase(); if (!t) return null;
  const list = notes();
  return list.find((n) => n.title.trim().toLowerCase() === t) || list.find((n) => n.title.toLowerCase().includes(t) || (n.title && t.includes(n.title.toLowerCase()))) || null;
}
const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
window.runNotesTool = async function (model, text) {
  const block = { type: "notes", active: true, thinkLabel: "Looking at your notes…", ids: [] };
  await toolAnswer(model, text, block, async ({ ask, history, today }) => {
    const str = { type: "string" };
    const schema = { type: "object", properties: {
      changes: { type: "array", items: { type: "object", properties: {
        action: { type: "string", enum: ["create", "add", "check", "uncheck", "remove", "replace", "delete_note", "show"] },
        note: str, kind: { type: "string", enum: KINDS.map((k) => k[0]) }, items: { type: "array", items: str } }, required: ["action", "note", "kind", "items"] } },
      reply: str }, required: ["changes", "reply"] };
    const now = notes().map((n) => `- "${n.title || "(untitled)"}" (${n.kind}${n.pinned ? ", pinned" : ""}): ${n.kind === "text" ? JSON.stringify(n.text.slice(0, 400)) : n.items.map((x) => (n.kind === "checklist" ? (x.done ? "[x] " : "[ ] ") : "") + x.t).join("; ").slice(0, 600)}`).join("\n") || "(no notes yet)";
    const sys = `You keep the user's notes. Reply only with JSON. Today is ${today}.
"changes": what to do, in order. Each has "action", "note" (the note's title, exactly as it is for an existing note), "kind" and "items":
- create: a new note with that title, of that "kind" (bullets, numbers, checklist, letters, roman, priority, or text) and "items" as its lines (for text: the paragraphs). Shopping lists and to-dos are "checklist", steps are "numbers", ranked things "priority".
- add: add "items" to an existing note (create it as a checklist if it doesn't exist yet).
- check / uncheck: tick off or un-tick the lines in "items" (the text of each line). remove: delete those lines. replace: the note's lines become "items".
- delete_note: delete the whole note (only when the user clearly asks). show: just show that note.
For an existing note "kind" can stay as it is. Asking what is on a note is "show". Never invent notes that don't exist except with create or add.
"reply": a short answer to the user in their language, saying what you did (or what is on the note).
The notes now:
${now}`;
    const user = [history && `The conversation so far:\n${history}`, `Request: ${text}`].filter(Boolean).join("\n\n");
    const r = await ask([{ role: "system", content: sys }, { role: "user", content: user }], schema);
    const touched = [];
    for (const c of (Array.isArray(r.changes) ? r.changes : []).slice(0, 10)) {
      const items = (Array.isArray(c.items) ? c.items : []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 60);
      const kind = KINDS.some((k) => k[0] === c.kind) ? c.kind : "checklist";
      let n = findNote(c.note);
      if (c.action === "create" || (c.action === "add" && !n)) {
        n = make(String(c.note || "Note").trim().slice(0, 80), kind, kind === "text" ? [] : items, kind === "text" ? items.join("\n") : "");
        notes().unshift(n);
      } else if (!n) continue;
      else if (c.action === "add") { if (n.kind === "text") n.text = (n.text ? n.text + "\n" : "") + items.join("\n"); else n.items.push(...items.map((t) => ({ t }))); }
      else if (c.action === "check" || c.action === "uncheck") { for (const t of items) { const it = n.items.find((x) => sameText(x.t, t)) || n.items.find((x) => x.t.toLowerCase().includes(t.toLowerCase())); if (it) it.done = c.action === "check"; } }
      else if (c.action === "remove") n.items = n.items.filter((x) => !items.some((t) => sameText(x.t, t) || x.t.toLowerCase().includes(t.toLowerCase())));
      else if (c.action === "replace") { if (n.kind === "text") n.text = items.join("\n"); else n.items = items.map((t) => ({ t })); }
      else if (c.action === "delete_note") { notes().splice(notes().indexOf(n), 1); continue; }
      n.updated = Date.now();
      if (!touched.includes(n.id)) touched.push(n.id);
    }
    block.ids = touched; saveSettings();
    if (document.body.classList.contains("notes-view")) renderPage();
    return String(r.reply || "").trim() || (touched.length ? "Done." : "I couldn't find that note.");
  });
};
// the notes the tool touched, as small cards inside the answer (they show the notes as they are now)
window.notesCard = function (b) {
  const w = document.createElement("div"); w.className = "tool-block notes-card";
  if (b.active) { w.innerHTML = '<div class="search-bar active"><span class="spin"></span><span class="q"></span></div>'; w.querySelector(".q").textContent = b.status || b.thinkLabel; return w; }
  if (b.error) { w.innerHTML = '<div class="tool-err"></div>'; w.firstChild.textContent = "Couldn't change the notes: " + b.error; return w; }
  const list = (b.ids || []).map((id) => notes().find((n) => n.id === id)).filter(Boolean);
  for (const n of list) { const el = noteEl(n, { edit: false }); el.onclick = (e) => { if (!e.target.closest(".mk")) setView("notes"); }; el.title = "Open in Notes"; w.appendChild(el); }
  return w;
};
})();
