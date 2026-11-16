// "My tools": people make their own tools for the AI, right in the sidebar, and add them in.
//   Kept in chrome.storage.local ("tools"). The chat gets each tool's name, description and inputs (sendTools); when the AI uses one,
//   the chat asks for it by name and the background script runs it (background.js runCustomTool). The code never goes to the chat.
//   A tool is one of two kinds:
//     page:   the body of an async function that runs on the page you're on (inputs in "args", "return" the answer)
//     prompt: a text with {{input}} gaps that goes back to the AI to follow
// Shares APP_ORIGIN, ask, frame, appReady, refresh and toolsOpen with sidepanel.js (loaded first).

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const PARAM_TYPES = ["string", "number", "boolean"];
const loadTools = async () => (await chrome.storage.local.get({ tools: [] })).tools.filter(Boolean);
const saveTools = (tools) => chrome.storage.local.set({ tools });
const slug = (s) => { let n = String(s || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 38); if (n && !/^[a-z]/.test(n)) n = "t_" + n; return n; };

// anything that comes in (the form, an imported file) goes through here: the same shape, the same limits
function cleanTool(x) {
  if (!x || typeof x !== "object") return null;
  const name = slug(x.name), description = String(x.description || "").trim().slice(0, 600), code = String(x.code || "").slice(0, 20000);
  if (!name || !description || !code.trim()) return null;
  const seen = new Set(), params = [];
  for (const p of (Array.isArray(x.params) ? x.params : []).slice(0, 10)) {
    if (!p || typeof p !== "object") continue;
    const pn = String(p.name || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_$&").slice(0, 31);
    if (!pn || seen.has(pn)) continue;
    seen.add(pn);
    params.push({ name: pn, type: PARAM_TYPES.includes(p.type) ? p.type : "string", description: String(p.description || "").slice(0, 200), required: !!p.required });
  }
  return { name, description, kind: x.kind === "prompt" ? "prompt" : "page", params, code };
}

// ---------- to the chat ----------
async function sendTools() {
  if (!frame.contentWindow || !appReady) return;
  const tools = (await loadTools()).map(({ name, description, kind, params }) => ({ name, description, kind, params }));
  try { frame.contentWindow.postMessage({ type: "albatross-tools", tools }, APP_ORIGIN); } catch {}
}
chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tools) sendTools(); });
// the AI used a tool: run it in the background script and send the answer back (only the chat frame of this panel may ask)
addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow || e.origin !== APP_ORIGIN || !e.data || e.data.type !== "albatross-tool-call") return;
  const { id, name, args } = e.data;
  const answer = (o) => { try { frame.contentWindow.postMessage({ type: "albatross-tool-result", id, ...o }, APP_ORIGIN); } catch {} };
  try {
    const r = await ask({ customTool: { name: String(name || ""), args } });
    answer(r && !r.error ? { ok: true, result: r.result } : { ok: false, error: (r && r.error) || "The tool didn't answer." });
  } catch (err) { answer({ ok: false, error: String((err && err.message) || err) }); }
});

// ---------- examples to start from ----------
const EXAMPLES = [
  { label: "List the links on the page", tool: { name: "list_links", kind: "page", description: "Lists the links on the page the user is looking at (text and address).",
    params: [{ name: "limit", type: "number", description: "How many links at most (default 30)", required: false }],
    code: "const links = [...document.querySelectorAll('a[href]')].slice(0, Number(args.limit) || 30);\nreturn links.map((a) => (a.innerText.trim() || a.title || '(no text)') + ' -> ' + a.href).join('\\n');" } },
  { label: "Read the text I selected", tool: { name: "selected_text", kind: "page", description: "Gets the text the user has selected on the page.", params: [],
    code: "return String(getSelection()) || '(nothing is selected on the page)';" } },
  { label: "Highlight a word on the page", tool: { name: "highlight_word", kind: "page", description: "Highlights every place a word appears on the page in yellow.",
    params: [{ name: "word", type: "string", description: "The word to highlight", required: true }],
    code: "const word = String(args.word || '').toLowerCase();\nif (!word) return 'No word was given.';\nconst walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), hits = [];\nwhile (walker.nextNode()) {\n  const t = walker.currentNode;\n  if (t.parentElement && !/^(SCRIPT|STYLE|MARK)$/.test(t.parentElement.tagName) && t.nodeValue.toLowerCase().includes(word)) hits.push(t);\n}\nfor (const t of hits) {\n  const i = t.nodeValue.toLowerCase().indexOf(word), r = document.createRange();\n  r.setStart(t, i); r.setEnd(t, i + word.length);\n  r.surroundContents(document.createElement('mark'));\n}\nreturn 'Highlighted ' + hits.length + ' place' + (hits.length === 1 ? '' : 's') + '.';" } },
  { label: "A text to follow: code review", tool: { name: "review_code", kind: "prompt", description: "A checklist for reviewing code the user shows you. Use it when they ask for a code review.",
    params: [{ name: "code", type: "string", description: "The code to review", required: true }],
    code: "Review this code. Check for: 1) bugs, 2) unclear names, 3) cases it doesn't handle. Answer with a short list, the most important first, and say what to change.\n\n{{code}}" } },
];

// ---------- the screens ----------
let editing = null;          // the name of the tool being changed ("" = a new one)
let pendingImport = null;
const showList = () => { $("#tListView").hidden = false; $("#tEdit").hidden = true; drawList(); };
function openTools() {
  toolsOpen = true; frame.hidden = true; $("#pair").hidden = true; $("#down").hidden = true; $("#more").hidden = true; $("#moreBtn").setAttribute("aria-expanded", "false");
  $("#tools").hidden = false; showList();
}
function closeTools() { toolsOpen = false; $("#tools").hidden = true; pendingImport = null; refresh(); }
$("#myTools").onclick = openTools;
$("#tDone").onclick = closeTools;

async function drawList() {
  const tools = await loadTools(), box = $("#tList");
  box.replaceChildren();
  $("#tReview").hidden = !pendingImport; $("#tListErr").textContent = "";
  if (!tools.length) box.append(el("div", "hint", "You haven't made a tool yet. Press New tool, and start from an example if you like."));
  for (const t of tools) {
    const c = el("div", "card"), head = el("div", "row");
    const name = el("b", "", "my_" + t.name); name.style.flex = "1";
    const edit = el("button", "", "Edit"); edit.onclick = () => openEditor(t);
    head.append(name, el("span", "tag", t.kind === "prompt" ? "text" : "page"), edit);
    c.append(head, el("div", "d", t.description));
    if (t.params && t.params.length) c.append(el("div", "d", "Inputs: " + t.params.map((p) => p.name + (p.required ? "*" : "")).join(", ")));
    box.append(c);
  }
}

// the form
function inRow(p = {}) {
  const r = el("div", "inrow"), name = el("input"), type = el("select"), del = el("button", "icon", "×"), desc = el("input", "desc"), reqL = el("label", "req"), req = el("input");
  name.placeholder = "name"; name.value = p.name || ""; name.spellcheck = false; name.maxLength = 31; name.className = "pn";
  for (const t of PARAM_TYPES) { const o = el("option", "", t === "string" ? "text" : t === "number" ? "number" : "yes / no"); o.value = t; type.append(o); }
  type.value = p.type || "string"; type.className = "pt";
  desc.placeholder = "what the AI should put here"; desc.value = p.description || ""; desc.maxLength = 200; desc.className = "desc pd";
  req.type = "checkbox"; req.checked = !!p.required; req.className = "pr"; reqL.append(req, document.createTextNode(" needed"));
  del.title = "Remove this input"; del.type = "button"; del.onclick = () => r.remove();
  r.append(name, type, del, desc, reqL);
  return r;
}
const readIns = () => [...$("#tIns").children].map((r) => ({ name: r.querySelector(".pn").value.trim(), type: r.querySelector(".pt").value, description: r.querySelector(".pd").value.trim(), required: r.querySelector(".pr").checked })).filter((p) => p.name);
function kindHints() {
  const page = $("#tKind").value === "page";
  $("#tCodeLabel").textContent = page ? "Code" : "Text";
  $("#tCodeHint").textContent = page
    ? "The body of an async function. The inputs are in args (args.limit). Use return to give the AI its answer, as text or JSON. It runs on the page you're on (turn on Follow my tab), can read and change it, and stops after 30 seconds."
    : "The text goes back to the AI to follow. Put {{name}} where an input should go.";
  $("#tCode").placeholder = page ? "return document.title;" : "Summarize {{topic}} in three bullets.";
}
function fillForm(t) {
  $("#tName").value = t.name || ""; $("#tDesc").value = t.description || ""; $("#tKind").value = t.kind || "page"; $("#tCode").value = t.code || "";
  $("#tIns").replaceChildren(...(t.params || []).map(inRow)); kindHints(); nameHint();
}
function nameHint() { const n = slug($("#tName").value); $("#tNameHint").textContent = n ? "The AI sees it as my_" + n : "Letters, numbers and _ only."; }
function openEditor(t) {
  editing = t ? t.name : "";
  $("#tListView").hidden = true; $("#tEdit").hidden = false; $("#tErr").textContent = ""; $("#tTestOut").hidden = true; $("#tTestArgs").value = "";
  $("#tDelete").hidden = !t; $("#tExample").value = "";
  fillForm(t || { kind: "page", params: [] });
}
function readForm() { return cleanTool({ name: $("#tName").value, description: $("#tDesc").value, kind: $("#tKind").value, code: $("#tCode").value, params: readIns() }); }

for (const [i, ex] of EXAMPLES.entries()) { const o = el("option", "", ex.label); o.value = String(i); $("#tExample").append(o); }
$("#tExample").onchange = () => { const ex = EXAMPLES[Number($("#tExample").value)]; if (ex) fillForm(structuredClone(ex.tool)); };
$("#tName").oninput = nameHint;
$("#tKind").onchange = kindHints;
$("#tNew").onclick = () => openEditor(null);
$("#tAddIn").onclick = () => { if ($("#tIns").children.length < 10) $("#tIns").append(inRow()); };
$("#tCancel").onclick = showList;
// Tab in the code box indents, instead of leaving it
$("#tCode").onkeydown = (e) => {
  if (e.key !== "Tab" || e.shiftKey) return;
  e.preventDefault(); const a = e.target, s = a.selectionStart; a.value = a.value.slice(0, s) + "  " + a.value.slice(a.selectionEnd); a.selectionStart = a.selectionEnd = s + 2;
};

$("#tSave").onclick = async () => {
  const t = readForm(), err = $("#tErr");
  if (!slug($("#tName").value)) { err.textContent = "Give the tool a name."; return; }
  if (!t) { err.textContent = !$("#tDesc").value.trim() ? "Say what the tool does: the AI reads it to know when to use it." : "The tool has no " + ($("#tKind").value === "page" ? "code" : "text") + " yet."; return; }
  const tools = await loadTools();
  if (tools.some((x) => x.name === t.name && x.name !== editing)) { err.textContent = "You already have a tool called " + t.name + "."; return; }
  const i = tools.findIndex((x) => x.name === editing);
  if (i >= 0) tools[i] = t; else if (tools.length >= 40) { err.textContent = "That's the most tools you can have (40)."; return; } else tools.push(t);
  await saveTools(tools);
  showList();
};
$("#tDelete").onclick = async () => {
  if (!editing || !confirm("Delete the tool my_" + editing + "?")) return;
  await saveTools((await loadTools()).filter((x) => x.name !== editing));
  showList();
};
$("#tTest").onclick = async () => {
  const t = readForm(), out = $("#tTestOut"), err = $("#tErr");
  err.textContent = ""; if (!t) { err.textContent = "Fill in the name, what it does and the " + ($("#tKind").value === "page" ? "code" : "text") + " first."; return; }
  let args = {};
  const raw = $("#tTestArgs").value.trim();
  if (raw) { try { args = JSON.parse(raw); } catch { err.textContent = "The test input isn't valid JSON, like {\"limit\": 10}."; return; } }
  out.hidden = false; out.className = "out"; out.textContent = "Running…"; $("#tTest").disabled = true;
  try {
    const r = await ask({ customTool: { name: t.name, args, draft: t } });
    out.className = "out" + (r && r.error ? " bad" : ""); out.textContent = (r && (r.error || r.result)) || "(nothing)";
  } catch (e) { out.className = "out bad"; out.textContent = String((e && e.message) || e); }
  $("#tTest").disabled = false;
};

// ---------- export and import ----------
$("#tExport").onclick = async () => {
  const tools = await loadTools();
  if (!tools.length) { $("#tListErr").textContent = "There is nothing to export yet."; return; }
  const a = el("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify({ albatrossTools: 1, tools }, null, 2)], { type: "application/json" })); a.download = "albatross-tools.json";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
$("#tImport").onclick = () => { $("#tFile").value = ""; $("#tFile").click(); };
$("#tFile").onchange = async () => {
  const f = $("#tFile").files[0]; if (!f) return;
  $("#tListErr").textContent = "";
  try {
    if (f.size > 2000000) throw new Error("big");
    const d = JSON.parse(await f.text());
    const list = (Array.isArray(d) ? d : d && Array.isArray(d.tools) ? d.tools : []).slice(0, 40).map(cleanTool).filter(Boolean);
    if (!list.length) { $("#tListErr").textContent = "No tools found in that file."; return; }
    pendingImport = list; await drawListReview();
  } catch { $("#tListErr").textContent = "That file isn't a list of tools."; }
};
async function drawListReview() {
  const have = new Set((await loadTools()).map((t) => t.name)), box = $("#tReviewList");
  $("#tReview").hidden = false; box.replaceChildren();
  $("#tReviewTitle").textContent = "Add " + pendingImport.length + " tool" + (pendingImport.length === 1 ? "" : "s") + "?";
  for (const t of pendingImport) {
    const d = el("details"), s = el("summary", "", "my_" + t.name + " (" + (t.kind === "prompt" ? "text" : "page code") + ")" + (have.has(t.name) ? " · replaces yours" : ""));
    d.append(s, el("div", "d", t.description), el("pre", "out", t.code)); box.append(d);
  }
}
$("#tReviewNo").onclick = () => { pendingImport = null; $("#tReview").hidden = true; };
$("#tReviewAdd").onclick = async () => {
  if (!pendingImport) return;
  const tools = await loadTools();
  for (const t of pendingImport) { const i = tools.findIndex((x) => x.name === t.name); if (i >= 0) tools[i] = t; else if (tools.length < 40) tools.push(t); }
  pendingImport = null; await saveTools(tools); drawList();
};
