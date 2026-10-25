// Mail for the Agent: read the inbox (IMAP) and send a message (SMTP) with the account the user sets up themselves.
// The password is typed by the user into the website's Mail form and arrives end-to-end encrypted; it is stored on this PC only,
// protected with Windows' own per-user encryption (DPAPI: only this Windows account on this PC can read it back). It never goes
// to the AI, and the AI cannot read mail settings: it can only ask for the inbox, one message, or to send one (which the user approves).

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { execFile } = require("child_process");

const FILE = process.env.ALBATROSS_MAIL || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "mail.json");
const LOCAL = (h) => /^(127\.0\.0\.1|localhost|::1)$/.test(h);

// ---------- password protection (Windows DPAPI through PowerShell; the password goes in an environment variable, never a command line) ----------
const ps = (cmd, env) => new Promise((res, rej) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 20000, env: { ...process.env, ...env } }, (e, out, err) => (e ? rej(new Error(String(err || e.message).trim().slice(0, 200))) : res(String(out).trim()))));
async function protect(pw) {
  if (process.platform !== "win32") throw new Error("Mail is only set up for Windows (it needs Windows to protect the password).");
  return ps("ConvertTo-SecureString $env:AP_PW -AsPlainText -Force | ConvertFrom-SecureString", { AP_PW: pw });
}
async function unprotect(enc) {
  return ps("$s = ConvertTo-SecureString $env:AP_ENC; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))", { AP_ENC: enc });
}
function loadCfg() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return null; } }
async function secret(cfg) { return cfg.pw ? cfg.pw : unprotect(cfg.enc); }       // cfg.pw only ever exists inside tests

// ---------- text helpers ----------
const dec = (buf, cs) => { try { return new TextDecoder((cs || "utf-8").toLowerCase().replace(/^utf8$/, "utf-8")).decode(buf); } catch { return buf.toString("utf8"); } };
function qpDecode(s) { return Buffer.from(s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1"); }
function words(h) {   // =?utf-8?B?...?= and =?iso-8859-1?Q?...?=
  return String(h || "").replace(/\r?\n[ \t]+/g, " ").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, t) => dec(enc.toLowerCase() === "b" ? Buffer.from(t, "base64") : qpDecode(t.replace(/_/g, " ")), cs)).replace(/\?=\s+=\?/g, "");
}
function headerMap(raw) {
  const m = {}; let key = "";
  for (const line of String(raw).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && key) m[key] += " " + line.trim();
    else { const i = line.indexOf(":"); if (i > 0) { key = line.slice(0, i).toLowerCase(); m[key] = line.slice(i + 1).trim(); } }
  }
  return m;
}
function bodyText(headRaw, bodyLatin1) {
  const h = headerMap(headRaw), ct = h["content-type"] || "text/plain", cte = (h["content-transfer-encoding"] || "7bit").toLowerCase();
  const bnd = /boundary="?([^";]+)"?/i.exec(ct);
  if (/multipart/i.test(ct) && bnd) {
    const parts = bodyLatin1.split("--" + bnd[1]).slice(1).filter((x) => !x.startsWith("--"));
    let html = "";
    for (const part of parts) {
      const i = part.search(/\r?\n\r?\n/); if (i < 0) continue;
      const ph = part.slice(0, i).replace(/^\r?\n/, ""), pb = part.slice(i).replace(/^\r?\n\r?\n/, "");
      const t = bodyText(ph, pb);
      if (/text\/plain/i.test(headerMap(ph)["content-type"] || "text/plain") && !/multipart/i.test(headerMap(ph)["content-type"] || "") && t) return t;
      if (/text\/html/i.test(headerMap(ph)["content-type"] || "")) html = html || t;
      if (/multipart/i.test(headerMap(ph)["content-type"] || "") && t) return t;
    }
    return html;
  }
  const cs = (/charset="?([^";\s]+)"?/i.exec(ct) || [])[1];
  const buf = cte === "base64" ? Buffer.from(bodyLatin1.replace(/\s+/g, ""), "base64") : cte === "quoted-printable" ? qpDecode(bodyLatin1) : Buffer.from(bodyLatin1, "latin1");
  let t = dec(buf, cs);
  if (/text\/html/i.test(ct)) t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<(br|\/p|\/div|\/li|\/tr)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n");
  return t.trim();
}

// ---------- a very small IMAP client (one connection per request) ----------
class Line {   // reads a socket as text lines and fixed-size pieces, 1 character = 1 byte (latin1), decoded properly later
  constructor(sock) { this.s = sock; this.buf = ""; this.waiters = []; this.err = null;
    sock.setEncoding("latin1");
    sock.on("data", (d) => { this.buf += d; this.pump(); });
    const fail = (e) => { this.err = e || new Error("Connection closed"); this.pump(); };
    sock.on("error", fail); sock.on("close", () => fail(new Error("The mail server closed the connection")));
    sock.setTimeout(30000, () => fail(new Error("The mail server didn't answer in time")));
  }
  pump() { while (this.waiters.length) { const w = this.waiters[0]; if (!w.try()) break; this.waiters.shift(); } }
  wait(fn) { return new Promise((res, rej) => { const w = { try: () => { const r = fn(); if (r !== undefined) { res(r); return true; } if (this.err) { rej(this.err); return true; } return false; } }; this.waiters.push(w); this.pump(); }); }
  line() { return this.wait(() => { const i = this.buf.indexOf("\r\n"); if (i < 0) return undefined; const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return l; }); }
  bytes(n) { return this.wait(() => { if (this.buf.length < n) return undefined; const b = this.buf.slice(0, n); this.buf = this.buf.slice(n); return b; }); }
  write(t) { this.s.write(t, "latin1"); }
}
function connect(host, port, mode) {
  return new Promise((res, rej) => {
    if (mode === "plain" && !LOCAL(host)) return rej(new Error("Unencrypted mail connections are only allowed to this PC itself."));
    const s = mode === "tls" ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.once("error", rej); s.once(mode === "tls" ? "secureConnect" : "connect", () => { s.removeListener("error", rej); res(s); });
  });
}
const q = (s) => '"' + String(s).replace(/[\\"]/g, "\\$&").replace(/[\r\n]/g, "") + '"';
async function imapOpen(cfg) {
  const s = await connect(cfg.imapHost, cfg.imapPort || 993, cfg.imapMode || "tls"), L = new Line(s);
  let n = 0;
  const greet = await L.line(); if (!/^\* (OK|PREAUTH)/i.test(greet)) throw new Error("Not an IMAP server: " + greet.slice(0, 80));
  // runs a command; returns { text, lits } where each {n} literal in the text is replaced by \u0000<index>\u0000
  const run = async (cmd, secretText) => {
    const tag = "A" + ++n; L.write(`${tag} ${cmd}\r\n`);
    let text = "", lits = [];
    for (;;) {
      const l = await L.line();
      if (l.startsWith(tag + " ")) { if (!/^\S+ OK/i.test(l)) throw new Error(secretText ? "The mail server refused the sign-in: " + l.slice(tag.length + 1, 120) : l.slice(tag.length + 1, 200)); return { text, lits }; }
      const m = /\{(\d+)\}$/.exec(l);
      if (m) { const lit = await L.bytes(Number(m[1])); lits.push(lit); text += l.replace(/\{\d+\}$/, "\u0000" + (lits.length - 1) + "\u0000") + "\n"; }
      else text += l + "\n";
    }
  };
  return { run, close: () => { try { L.write(`A${++n} LOGOUT\r\n`); s.end(); } catch {} } };
}
async function imapSession(cfg, fn) {
  const pw = await secret(cfg), c = await imapOpen(cfg);
  try { await c.run(`LOGIN ${q(cfg.user)} ${q(pw)}`, true); await c.run("SELECT INBOX"); return await fn(c); } finally { c.close(); }
}
const lit = (r, text, nth) => { const m = [...text.matchAll(/\u0000(\d+)\u0000/g)][nth || 0]; return m ? r.lits[Number(m[1])] : ""; };

async function list(cfg, { unread = false, count = 10 } = {}) {
  count = Math.max(1, Math.min(30, Number(count) || 10));
  return imapSession(cfg, async (c) => {
    let set;
    if (unread) { const r = await c.run("UID SEARCH UNSEEN"); const ids = ((/SEARCH ([\d ]*)/.exec(r.text) || [])[1] || "").trim().split(/\s+/).filter(Boolean); if (!ids.length) return { messages: [], total: 0 }; set = ids.slice(-count).join(","); }
    else { const ex = await c.run("NOOP"); const n = Number((/\* (\d+) EXISTS/.exec(ex.text) || [])[1] || 0); const st = await c.run("STATUS INBOX (MESSAGES)"); const total = Number((/MESSAGES (\d+)/.exec(st.text) || [])[1] || n); if (!total) return { messages: [], total: 0 }; const r = await c.run(`FETCH ${Math.max(1, total - count + 1)}:${total} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`); return parseList(r, total); }
    const r = await c.run(`UID FETCH ${set} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
    return parseList(r, null);
  });
}
function parseList(r, total) {
  const msgs = [];
  for (const blk of r.text.split(/^\* \d+ FETCH /m).slice(1)) {
    const uid = (/UID (\d+)/.exec(blk) || [])[1], flags = (/FLAGS \(([^)]*)\)/.exec(blk) || [])[1] || "";
    const h = headerMap(Buffer.from(lit(r, blk, 0), "latin1").toString("latin1"));
    msgs.push({ id: uid, from: words(h.from), subject: words(h.subject), date: h.date || "", unread: !/\\Seen/i.test(flags) });
  }
  return { messages: msgs.reverse(), total: total == null ? msgs.length : total };
}
async function readOne(cfg, id) {
  if (!/^\d+$/.test(String(id))) throw new Error("Bad message id");
  return imapSession(cfg, async (c) => {
    const r = await c.run(`UID FETCH ${id} (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.60000>)`);
    const head = lit(r, r.text, 0), body = lit(r, r.text, 1);
    if (!head) throw new Error("No such message");
    const h = headerMap(head);
    return { id: String(id), from: words(h.from), to: words(h.to), subject: words(h.subject), date: h.date || "", text: bodyText(head, body).slice(0, 12000) };
  });
}

// ---------- SMTP ----------
async function smtpSend(cfg, { to, subject, text }) {
  const rcpt = String(to || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  if (!rcpt.length || rcpt.length > 10 || rcpt.some((a) => !/^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/.test(a))) throw new Error("Check the recipient address.");
  const pw = await secret(cfg), mode = cfg.smtpMode || (Number(cfg.smtpPort) === 587 ? "starttls" : "tls");
  let s = await connect(cfg.smtpHost, cfg.smtpPort || 465, mode === "tls" ? "tls" : mode === "plain" ? "plain" : "plain-then-tls");
  let L = new Line(s);
  const reply = async () => { let code = "", text = ""; for (;;) { const l = await L.line(); text += l + "\n"; code = l.slice(0, 3); if (l[3] !== "-") break; } return { code, text }; };
  const cmd = async (c, ok) => { L.write(c + "\r\n"); const r = await reply(); if (!String(ok).split("|").includes(r.code)) throw new Error("The mail server said: " + r.text.trim().slice(0, 160)); return r; };
  const g = await reply(); if (g.code !== "220") throw new Error("Not a mail server: " + g.text.slice(0, 80));
  await cmd("EHLO albatross.local", "250");
  if (mode === "starttls") {
    await cmd("STARTTLS", "220");
    s.removeAllListeners("data"); s = tls.connect({ socket: s, servername: cfg.smtpHost }); await new Promise((res, rej) => { s.once("secureConnect", res); s.once("error", rej); }); L = new Line(s);
    await cmd("EHLO albatross.local", "250");
  }
  await cmd("AUTH PLAIN " + Buffer.from("\u0000" + cfg.user + "\u0000" + pw, "utf8").toString("base64"), "235");
  const from = cfg.from || cfg.user;
  await cmd(`MAIL FROM:<${from.replace(/[<>\r\n]/g, "")}>`, "250");
  for (const a of rcpt) await cmd(`RCPT TO:<${a}>`, "250|251");
  await cmd("DATA", "354");
  const enc = (t) => (/^[\x20-\x7e]*$/.test(t) ? t : "=?utf-8?B?" + Buffer.from(t, "utf8").toString("base64") + "?=");
  const msg = [`From: ${from}`, `To: ${rcpt.join(", ")}`, `Subject: ${enc(String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 200))}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString("hex")}@albatross.local>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(String(text || ""), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n")].join("\r\n");
  L.write(msg.replace(/\r\n\./g, "\r\n..") + "\r\n.\r\n");
  const done = await reply(); if (done.code !== "250") throw new Error("The mail server didn't accept the message: " + done.text.trim().slice(0, 160));
  try { L.write("QUIT\r\n"); s.end(); } catch {}
  return { sent: true, to: rcpt };
}

async function handle(method, p, body, note) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  try {
    const cfg = loadCfg();
    if (p === "/agent/mail/status") return [200, { configured: !!cfg, user: cfg ? cfg.user : "", imapHost: cfg ? cfg.imapHost : "", smtpHost: cfg ? cfg.smtpHost : "" }];
    if (p === "/agent/mail/forget") { try { fs.unlinkSync(FILE); } catch {} note("Mail: account removed"); return [200, { ok: true }]; }
    if (p === "/agent/mail/setup") {
      const c = { imapHost: String(j.imapHost || "").trim(), imapPort: Number(j.imapPort) || 993, smtpHost: String(j.smtpHost || "").trim(), smtpPort: Number(j.smtpPort) || 465, user: String(j.user || "").trim(), from: String(j.from || j.user || "").trim() };
      if (j.imapMode) c.imapMode = j.imapMode; if (j.smtpMode) c.smtpMode = j.smtpMode;
      if (!c.imapHost || !c.user || !j.password) return [400, { error: "Fill in the mail server, your address and the password." }];
      if (!/^[\w.-]+$/.test(c.imapHost) || (c.smtpHost && !/^[\w.-]+$/.test(c.smtpHost))) return [400, { error: "That doesn't look like a server name." }];
      await imapSession({ ...c, pw: String(j.password) }, async () => 1);            // does it sign in?
      c.enc = await protect(String(j.password));
      fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(c, null, 2));
      note(`Mail: account ${c.user} set up`);
      return [200, { ok: true, user: c.user }];
    }
    if (!cfg) return [409, { error: "Mail isn't set up yet. Open the Agent tab → Mail to add your account." }];
    if (p === "/agent/mail/list") return [200, await list(cfg, j)];
    if (p === "/agent/mail/read") return [200, await readOne(cfg, j.id)];
    if (p === "/agent/mail/send") { if (!cfg.smtpHost) return [409, { error: "No outgoing mail server is set up." }]; const r = await smtpSend(cfg, j); note(`Mail: sent a message to ${r.to.join(", ")}`); return [200, r]; }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown mail request" }];
}

module.exports = { handle, imapList: list, imapRead: readOne, smtpSend, bodyText, words };
