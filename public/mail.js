"use strict";
// The Mail tab, by hand: your mail accounts (several), inbox and sent mail, one message open, and Reply / Reply all / Forward.
// Everything is written by you and only goes out when you press Send. (The AI Agent has its own mail tools.)
// Mail is read and sent by the host on the PC (host/mail.js); passwords stay there, protected by Windows.
// Uses the main page's helpers: $, esc, toast, pcCall.
(() => {
const M = { accounts: [], account: "", folder: "inbox", page: 0, list: [], total: 0, open: null, busy: false, ctrl: null, loaded: false };
const PRESETS = { "gmail.com": ["imap.gmail.com", "smtp.gmail.com"], "googlemail.com": ["imap.gmail.com", "smtp.gmail.com"], "outlook.com": ["outlook.office365.com", "smtp-mail.outlook.com"], "hotmail.com": ["outlook.office365.com", "smtp-mail.outlook.com"], "live.com": ["outlook.office365.com", "smtp-mail.outlook.com"],
  "yahoo.com": ["imap.mail.yahoo.com", "smtp.mail.yahoo.com"], "icloud.com": ["imap.mail.me.com", "smtp.mail.me.com"], "me.com": ["imap.mail.me.com", "smtp.mail.me.com"], "gmx.de": ["imap.gmx.net", "mail.gmx.net"], "gmx.net": ["imap.gmx.net", "mail.gmx.net"], "web.de": ["imap.web.de", "smtp.web.de"], "t-online.de": ["secureimap.t-online.de", "securesmtp.t-online.de"], "posteo.de": ["posteo.de", "posteo.de"], "mailbox.org": ["imap.mailbox.org", "smtp.mailbox.org"] };
const PAGE = 25;
const nameOf = (from) => { const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from || ""); return m && m[1].trim() ? m[1].trim() : (m ? m[2] : String(from || "").trim()); };
const addrOf = (from) => { const m = /<([^>]+)>/.exec(from || ""); return (m ? m[1] : String(from || "")).trim(); };
const when = (d) => { const t = new Date(d); if (isNaN(t)) return ""; const now = new Date(); return t.toDateString() === now.toDateString() ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t.getFullYear() === now.getFullYear() ? t.toLocaleDateString([], { day: "numeric", month: "short" }) : t.toLocaleDateString(); };

function shell() {
  const page = $("#mailPage");
  page.innerHTML = `<div class="mail-wrap">
    <div class="mail-bar">
      <select id="mlAccount" aria-label="Mail account"></select>
      <div class="seg" id="mlFolder" role="tablist"><button data-f="inbox" type="button" class="on">Inbox</button><button data-f="sent" type="button">Sent</button></div>
      <button class="icon-btn" id="mlRefresh" type="button" title="Look for new mail" aria-label="Refresh"><svg class="i" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>
      <span style="flex:1"></span>
      <button class="btn small" id="mlAiBtn" type="button" title="The Agent can read, write and send mail for you">Agent</button>
      <button class="btn small" id="mlAccounts" type="button">Accounts</button>
      <button class="btn small primary" id="mlNew" type="button">New mail</button>
    </div>
    <div class="mail-panes">
      <div class="mail-list" id="mlList" aria-label="Messages"></div>
      <div class="mail-read" id="mlRead"><div class="empty-note">Pick a message on the left to read it.</div></div>
    </div></div><div class="mail-ai" id="mlAi"></div>`;
  // next to your mail: the Agent, which can read, write and send mail by itself (sending waits for your OK); it knows which mail is open
  if (window.agentPanel) window.agentPanel($("#mlAi"), {
    title: "Mail Agent", sub: "Reads, sorts and answers mail for you. You see every mail before it's sent.",
    placeholder: M.open ? "e.g. Answer this and say Friday works" : "e.g. Write to anna@example.com that I'm late",
    ideas: ["Answer the open mail politely", "Sum up my unread mail", "Which mails need an answer from me?"],
    context: () => {
      const a = `Mail account: ${M.account || "(main)"} · folder: ${M.folder}`;
      if (!M.open) return a + "\nNo mail is open right now.";
      const j = M.open;
      return [a, `The open mail (id ${j.id}):`, "From: " + j.from, "To: " + j.to + (j.cc ? "\nCc: " + j.cc : ""), "Date: " + j.date, "Subject: " + j.subject, "", (j.text || "").slice(0, 5000)].join("\n");
    },
  });
  $("#mlAiBtn").onclick = () => $("#mailPage").classList.toggle("ai-open");
  $("#mlAccount").onchange = () => { M.account = $("#mlAccount").value; M.page = 0; M.open = null; loadList(); };
  page.querySelectorAll("#mlFolder button").forEach((b) => (b.onclick = () => { M.folder = b.dataset.f; M.page = 0; M.open = null; page.querySelectorAll("#mlFolder button").forEach((x) => x.classList.toggle("on", x === b)); loadList(); }));
  $("#mlRefresh").onclick = () => { M.page = 0; loadList(); };
  $("#mlAccounts").onclick = () => showAccounts();
  $("#mlNew").onclick = () => compose({});
}
async function loadAccounts() {
  try { const j = await pcCall("/agent/mail/status", {}); M.accounts = j.accounts || []; }
  catch (e) { M.accounts = []; $("#mlList").innerHTML = `<div class="empty-note">Mail needs your PC: ${esc(e.message)}</div>`; return false; }
  if (!M.accounts.some((a) => a.user === M.account)) M.account = (M.accounts[0] || {}).user || "";
  $("#mlAccount").innerHTML = M.accounts.map((a) => `<option value="${esc(a.user)}">${esc(a.user)}${a.main ? " (main)" : ""}</option>`).join("") || '<option value="">No account yet</option>';
  $("#mlAccount").value = M.account;
  return true;
}
async function loadList(more) {
  const box = $("#mlList");
  if (!M.accounts.length) { box.innerHTML = '<div class="empty-note">No mail account yet.</div>'; showAccounts(); return; }
  if (!more) box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const j = await pcCall("/agent/mail/list", { account: M.account, folder: M.folder, count: PAGE, page: M.page });
    M.list = more ? M.list.concat(j.messages) : j.messages; M.total = j.total;
  } catch (e) { box.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; return; }
  drawList();
}
function drawList() {
  const box = $("#mlList"); box.innerHTML = "";
  if (!M.list.length) { box.innerHTML = `<div class="empty-note">${M.folder === "sent" ? "No sent mail." : "The inbox is empty."}</div>`; return; }
  for (const m of M.list) {
    const b = document.createElement("button"); b.type = "button"; b.className = "ml-item" + (m.unread ? " unread" : "") + (M.open && M.open.id === m.id ? " on" : "");
    b.innerHTML = '<span class="who"></span><span class="when"></span><span class="subj"></span>';
    b.querySelector(".who").textContent = M.folder === "sent" ? "To: " + nameOf(m.to) : nameOf(m.from);
    b.querySelector(".when").textContent = when(m.date);
    b.querySelector(".subj").textContent = m.subject || "(no subject)";
    b.onclick = () => openMsg(m);
    box.appendChild(b);
  }
  if (M.list.length < M.total) {
    const more = document.createElement("button"); more.type = "button"; more.className = "btn small ml-more"; more.textContent = `Older mail (${M.total - M.list.length} more)`;
    more.onclick = () => { M.page++; more.disabled = true; more.textContent = "Loading…"; loadList(true); };
    box.appendChild(more);
  }
}
async function openMsg(m) {
  const read = $("#mlRead"); $("#mailPage").classList.add("reading");
  read.innerHTML = '<div class="empty-note">Opening…</div>';
  let j; try { j = await pcCall("/agent/mail/read", { account: M.account, folder: M.folder, id: m.id, seen: true }); }
  catch (e) { read.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; return; }
  m.unread = false; M.open = j; drawList();
  read.innerHTML = `<button class="btn small ml-back" type="button">‹ Back</button>
    <div class="ml-head"><h2></h2><div class="ml-meta"><b class="from"></b><span class="to"></span><span class="date"></span></div></div>
    <div class="ml-acts">
      <button class="btn small primary" data-a="reply" type="button">Reply</button>
      <button class="btn small" data-a="all" type="button">Reply all</button>
      <button class="btn small" data-a="fwd" type="button">Forward</button>
    </div>
    <div class="ml-body"></div>`;
  read.querySelector("h2").textContent = j.subject || "(no subject)";
  read.querySelector(".from").textContent = j.from; read.querySelector(".to").textContent = "to " + j.to + (j.cc ? ", cc " + j.cc : ""); read.querySelector(".date").textContent = new Date(j.date).toLocaleString();
  read.querySelector(".ml-body").textContent = j.text || "(no text)";
  read.querySelector(".ml-back").onclick = () => $("#mailPage").classList.remove("reading");
  read.querySelector('[data-a="reply"]').onclick = () => reply(j, false);
  read.querySelector('[data-a="all"]').onclick = () => reply(j, true);
  read.querySelector('[data-a="fwd"]').onclick = () => forward(j);
}

// ---------- answering: the text is yours; the original is quoted below it ----------
const emails = (s) => (String(s || "").match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map((x) => x.toLowerCase());
const quote = (j) => `\n\n\nOn ${new Date(j.date).toLocaleString()}, ${j.from} wrote:\n` + (j.text || "").split("\n").map((l) => "> " + l).join("\n");
function reply(j, all) {
  const mine = new Set(M.accounts.map((a) => a.user.toLowerCase()));
  const sender = addrOf(j.from).toLowerCase();
  let to = [sender];
  if (all) to = [...new Set([sender, ...emails(j.to), ...emails(j.cc)])].filter((a) => !mine.has(a));
  if (M.folder === "sent") to = all ? [...new Set([...emails(j.to), ...emails(j.cc)])] : emails(j.to);   // answering your own sent mail: write to its recipients
  compose({ to: to.join(", "), subject: /^re:/i.test(j.subject) ? j.subject : "Re: " + (j.subject || ""), body: quote(j), inReplyTo: j.messageId, title: all ? "Reply all" : "Reply" });
}
function forward(j) {
  const head = `\n\n\n---------- Forwarded message ----------\nFrom: ${j.from}\nDate: ${new Date(j.date).toLocaleString()}\nSubject: ${j.subject || ""}\nTo: ${j.to}${j.cc ? "\nCc: " + j.cc : ""}\n\n`;
  compose({ subject: /^fwd?:/i.test(j.subject) ? j.subject : "Fwd: " + (j.subject || ""), body: head + (j.text || ""), title: "Forward" });
}

// ---------- writing: a reply or a new mail; it is only sent when the user presses Send ----------
function compose({ to = "", subject = "", body = "", inReplyTo = "", title = "New mail" }) {
  document.querySelector(".ml-compose")?.remove();
  const c = document.createElement("div"); c.className = "ml-compose"; c.setAttribute("role", "dialog"); c.setAttribute("aria-label", title);
  c.innerHTML = `<div class="mc-head"><b></b><span style="flex:1"></span><button class="icon-btn" type="button" data-a="x" aria-label="Close">✕</button></div>
    <label class="mc-row"><span>From</span><select data-f="from"></select></label>
    <label class="mc-row"><span>To</span><input data-f="to" type="email" multiple placeholder="name@example.com, …" autocomplete="off"></label>
    <label class="mc-row"><span>Subject</span><input data-f="subject" autocomplete="off"></label>
    <textarea data-f="body" rows="12" placeholder="Write your message…"></textarea>
    <div class="mc-foot"><span class="mc-status"></span><span style="flex:1"></span><button class="btn small" type="button" data-a="x">Discard</button><button class="btn small primary" type="button" data-a="send">Send</button></div>`;
  c.querySelector(".mc-head b").textContent = title;
  const f = (k) => c.querySelector(`[data-f="${k}"]`);
  f("from").innerHTML = M.accounts.filter((a) => a.canSend).map((a) => `<option value="${esc(a.user)}">${esc(a.user)}</option>`).join("");
  f("from").value = M.accounts.some((a) => a.user === M.account && a.canSend) ? M.account : f("from").value;
  f("to").value = to; f("subject").value = subject; f("body").value = body;
  const status = (t) => (c.querySelector(".mc-status").textContent = t || "");
  const close = () => c.remove();
  c.querySelectorAll('[data-a="x"]').forEach((b) => (b.onclick = close));
  c.querySelector('[data-a="send"]').onclick = async (e) => {
    const btn = e.target, toV = f("to").value.trim(), sub = f("subject").value.trim(), text = f("body").value;
    if (!f("from").value) return status("None of your accounts can send mail (no outgoing server).");
    if (!toV) return f("to").focus();
    if (!text.trim()) return f("body").focus();
    btn.disabled = true; status("Sending…");
    try {
      const r = await pcCall("/agent/mail/send", { account: f("from").value, to: toV, subject: sub, text, inReplyTo: inReplyTo || undefined });
      toast(`Sent to ${r.to.join(", ")}` + (r.savedToSent ? "" : " (not saved in Sent)")); close();
      if (M.folder === "sent") { M.page = 0; loadList(); }
    } catch (err) { status(err.message); btn.disabled = false; }
  };
  $("#mailPage").appendChild(c);
  if (!to) f("to").focus(); else { f("body").focus(); f("body").setSelectionRange(0, 0); f("body").scrollTop = 0; }
  return { status };
}

// ---------- accounts: add one, choose the main one, remove one ----------
function showAccounts() {
  const read = $("#mlRead"); $("#mailPage").classList.add("reading"); M.open = null; drawList();
  read.innerHTML = `<button class="btn small ml-back" type="button">‹ Back</button><h2>Mail accounts</h2>
    <div class="ml-accts"></div>
    <h3>Add an account</h3>
    <p class="pc-note">Your password goes to your PC only (end-to-end encrypted), and is kept there protected by Windows. For Gmail, Outlook, iCloud and Yahoo use an app password from your account's security settings.</p>
    <div class="ml-form">
      <label>Email address<input id="mlUser" type="email" autocomplete="off" placeholder="you@example.com"></label>
      <label>Password<input id="mlPw" type="password" autocomplete="new-password"></label>
      <label>Incoming (IMAP) server<input id="mlImap" autocomplete="off"></label><label>Port<input id="mlImapPort" value="993" inputmode="numeric"></label>
      <label>Outgoing (SMTP) server<input id="mlSmtp" autocomplete="off"></label><label>Port<input id="mlSmtpPort" value="465" inputmode="numeric"></label>
    </div>
    <div class="row"><button class="btn primary" id="mlAdd" type="button">Add account</button><span class="pc-note" id="mlAddMsg"></span></div>`;
  read.querySelector(".ml-back").onclick = () => $("#mailPage").classList.remove("reading");
  const list = read.querySelector(".ml-accts");
  if (!M.accounts.length) list.innerHTML = '<div class="empty-note">None yet.</div>';
  for (const a of M.accounts) {
    const row = document.createElement("div"); row.className = "ml-acct";
    row.innerHTML = `<span class="ad"></span>${a.main ? '<span class="badge">Main</span>' : '<button class="btn small" data-a="main" type="button">Make main</button>'}<button class="btn small" data-a="rm" type="button">Remove</button>`;
    row.querySelector(".ad").textContent = a.user + (a.canSend ? "" : " (can't send)");
    const mainB = row.querySelector('[data-a="main"]'); if (mainB) mainB.onclick = async () => { await pcCall("/agent/mail/main", { account: a.user }); await loadAccounts(); showAccounts(); };
    row.querySelector('[data-a="rm"]').onclick = async (e) => {
      if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Really remove?"; return; }
      await pcCall("/agent/mail/forget", { account: a.user }); toast(a.user + " removed from this PC"); await loadAccounts(); showAccounts(); loadList();
    };
    list.appendChild(row);
  }
  const touched = new Set();
  ["mlImap", "mlSmtp"].forEach((id) => ($("#" + id).oninput = () => touched.add(id)));
  $("#mlUser").oninput = () => { const m = /@(.+)$/.exec($("#mlUser").value); if (!m) return; const d = m[1].toLowerCase(), p = PRESETS[d] || ["imap." + d, "smtp." + d]; if (!touched.has("mlImap")) $("#mlImap").value = p[0]; if (!touched.has("mlSmtp")) $("#mlSmtp").value = p[1]; if (/outlook|office365/.test(p[1])) $("#mlSmtpPort").value = "587"; };
  $("#mlAdd").onclick = async () => {
    const v = (id) => $("#" + id).value.trim(), btn = $("#mlAdd"), msg = $("#mlAddMsg");
    btn.disabled = true; msg.textContent = "Signing in…";
    try {
      await pcCall("/agent/mail/setup", { user: v("mlUser"), password: $("#mlPw").value, imapHost: v("mlImap"), imapPort: Number(v("mlImapPort")) || 993, smtpHost: v("mlSmtp"), smtpPort: Number(v("mlSmtpPort")) || 465 });
      $("#mlPw").value = ""; toast(v("mlUser") + " added"); M.account = v("mlUser"); await loadAccounts(); M.page = 0; loadList(); showAccounts();
    } catch (e) { msg.textContent = e.message; } finally { btn.disabled = false; }
  };
}

window.mailOpen = async function (opts) {
  if (!M.loaded) { shell(); M.loaded = true; }
  if (await loadAccounts()) { if (opts && opts.accounts) showAccounts(); else loadList(); }
};
})();
