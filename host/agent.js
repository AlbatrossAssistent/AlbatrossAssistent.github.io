// Files on this PC for the website: a file browser (the "PC files" menu, and the paperclip's "From my PC"), and the tools the Agent
// uses: read, write, move and edit files in its own workspace, print, and read pages from the web.
//
// Where things live (all inside <Downloads>\Albatross, which is what Beam saves into):
//   all      the whole Albatross folder (what devices sent here, what the Code tool wrote, ...)   read, and move into
//   code     <Downloads>\Albatross\Code        projects written by the Code tool                    read, write
//   agent    <Downloads>\Albatross\Agent       the Agent's workspace                                read, write, move
//   pictures <Downloads>\Albatross\Pictures    pictures made on this PC                             read
// Nothing outside these folders is ever touched, the Agent can't delete anything (only the user can, in the PC files window, and it
// goes to the Recycle Bin), and nothing here runs a program.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const dns = require("dns").promises;
const net = require("net");

const BASE = path.resolve(process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross"));
const ROOTS = {
  all: { name: "All files", dir: BASE, write: false },
  code: { name: "Code projects", dir: path.resolve(process.env.ALBATROSS_CODE || path.join(BASE, "Code")), write: true },
  agent: { name: "Agent workspace", dir: path.join(BASE, "Agent"), write: true },
  pictures: { name: "Pictures", dir: path.join(BASE, "Pictures"), write: false },
};
const MAX_TEXT = 400 * 1024, MAX_B64 = 20 * 1024 * 1024, MAX_WRITE = 4 * 1024 * 1024, MAX_ENTRIES = 500;
const BAD_EXT = /\.(exe|dll|msi|scr|com|pif|lnk|scf|url|inf|sys|cpl|bat|cmd|ps1|vbs|js?e|wsf|reg)$/i;   // never written by the Agent
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MIME = { txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", py: "text/x-python", ts: "text/plain", xml: "text/xml", log: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4" };
const mimeOf = (n) => MIME[path.extname(n).slice(1).toLowerCase()] || "application/octet-stream";

// "agent:notes/todo.txt" -> { root, dir, parts, full }, or throws a message the AI can understand
function resolve(spec, { write = false } = {}) {
  let rootId = "agent", rel = String(spec == null ? "" : spec).trim();
  const m = /^(all|code|agent|pictures|received):(.*)$/i.exec(rel);
  if (m) { rootId = m[1].toLowerCase() === "received" ? "all" : m[1].toLowerCase(); rel = m[2]; }
  const root = ROOTS[rootId];
  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = rel.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.length > 10 || rel.length > 260) throw new Error("That path is too long.");
  for (const seg of parts) {
    if (seg === ".." || /[<>:"|?*\u0000-\u001f]/.test(seg) || /[. ]$/.test(seg) || RESERVED.test(seg)) throw new Error(`"${seg}" isn't an allowed name.`);
  }
  if (write) {
    if (!root.write) throw new Error(`${root.name} is read-only: write into "agent:" instead.`);
    if (!parts.length) throw new Error("Give a file name.");
    if (BAD_EXT.test(parts[parts.length - 1])) throw new Error("Programs and scripts can't be written.");
  }
  fs.mkdirSync(root.dir, { recursive: true });
  const full = path.join(root.dir, ...parts);
  if (full !== root.dir && !full.startsWith(root.dir + path.sep)) throw new Error("Outside the allowed folder.");
  // a link in the way could lead anywhere else: refuse every link on the path
  let cur = root.dir;
  for (const seg of parts) {
    cur = path.join(cur, seg);
    try { if (fs.lstatSync(cur).isSymbolicLink()) throw new Error("Links aren't followed."); } catch (e) { if (e.message === "Links aren't followed.") throw e; break; }
  }
  return { rootId, root, parts, full, spec: rootId + ":" + parts.join("/") };
}
const isText = (buf) => !buf.subarray(0, 4096).includes(0);

function list(spec) {
  const r = resolve(spec || "agent:");
  let ents = [];
  try { ents = fs.readdirSync(r.full, { withFileTypes: true }); } catch { throw new Error("That folder doesn't exist."); }
  const out = [];
  for (const d of ents) {
    if (d.isSymbolicLink() || d.name.startsWith(".") || d.name.endsWith(".albatross-part") || d.name.endsWith(".part")) continue;
    let st; try { st = fs.statSync(path.join(r.full, d.name)); } catch { continue; }
    out.push({ name: d.name, dir: d.isDirectory(), size: d.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, mime: d.isDirectory() ? "" : mimeOf(d.name) });
    if (out.length >= MAX_ENTRIES) break;
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { spec: r.spec, entries: out };
}
function read(spec, { b64 = false, max } = {}) {
  const r = resolve(spec);
  let st; try { st = fs.statSync(r.full); } catch { throw new Error("That file doesn't exist."); }
  if (!st.isFile()) throw new Error("That is a folder, not a file.");
  const name = path.basename(r.full), mime = mimeOf(name);
  if (b64) {
    if (st.size > MAX_B64) throw new Error("That file is bigger than 20 MB.");
    return { name, size: st.size, mime, b64: fs.readFileSync(r.full).toString("base64") };
  }
  const buf = fs.readFileSync(r.full).subarray(0, Math.min(MAX_TEXT, max || MAX_TEXT));
  if (!isText(buf)) return { name, size: st.size, mime, binary: true };
  return { name, size: st.size, mime, text: buf.toString("utf8"), truncated: st.size > buf.length };
}
function write(spec, content, mode = "create") {
  const r = resolve(spec, { write: true });
  const data = Buffer.from(String(content == null ? "" : content), "utf8");
  if (data.length > MAX_WRITE) throw new Error("That is bigger than 4 MB.");
  let exists = false; try { const st = fs.lstatSync(r.full); if (!st.isFile()) throw new Error("A folder is in the way."); exists = true; } catch (e) { if (e.message === "A folder is in the way.") throw e; }
  if (exists && mode === "create") throw new Error(`${r.spec} already exists. Use mode "overwrite" or "append", or pick another name.`);
  let cur = r.root.dir;
  for (const seg of r.parts.slice(0, -1)) { cur = path.join(cur, seg); try { if (!fs.lstatSync(cur).isDirectory()) throw new Error("A file is in the way."); } catch (e) { if (e.message === "A file is in the way.") throw e; fs.mkdirSync(cur); } }
  if (mode === "append" && exists) fs.appendFileSync(r.full, data);
  else { const tmp = r.full + ".albatross-part"; fs.writeFileSync(tmp, data); fs.renameSync(tmp, r.full); }
  return { spec: r.spec, size: fs.statSync(r.full).size, created: !exists };
}
// move (or copy) a file or folder; never over an existing one
function move(from, to, copy = false) {
  const a = resolve(from), b = resolve(to, { write: true });
  if (!a.parts.length) throw new Error("Pick a file or folder to move.");
  if (fs.existsSync(b.full)) throw new Error(`${b.spec} already exists.`);
  let st; try { st = fs.statSync(a.full); } catch { throw new Error("That doesn't exist."); }
  if (!copy && !(a.root.write || a.rootId === "all")) throw new Error(`Files in "${a.root.name}" can be copied but not moved: use copy.`);
  fs.mkdirSync(path.dirname(b.full), { recursive: true });
  if (b.full === a.full || b.full.startsWith(a.full + path.sep)) throw new Error("Can't move something into itself.");
  if (copy) fs.cpSync(a.full, b.full, { recursive: true, errorOnExist: true, force: false, dereference: false });
  else fs.renameSync(a.full, b.full);
  return { from: a.spec, to: b.spec, copied: !!copy, folder: st.isDirectory() };
}
// The user's own "Delete" in the PC files window, never one of the Agent's tools. The Windows Recycle Bin gets the file or folder,
// so it can be put back from there.
async function trash(spec) {
  const r = resolve(spec);
  if (!r.parts.length) throw new Error("Pick a file or folder, not a whole location.");
  let st; try { st = fs.lstatSync(r.full); } catch { throw new Error("That doesn't exist."); }
  if (process.platform !== "win32") throw new Error("The Recycle Bin is only set up for Windows.");
  await ps("Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:ALB_TRASH; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }", { ALB_TRASH: r.full });
  if (fs.existsSync(r.full)) throw new Error("It couldn't be moved to the Recycle Bin.");
  return { spec: r.spec, folder: st.isDirectory() };
}
function mkdir(spec) { const r = resolve(spec + "/placeholder", { write: true }); fs.mkdirSync(path.dirname(r.full), { recursive: true }); return { spec: r.spec.replace(/\/placeholder$/, "") }; }

// ---------- printing ----------
const ps = (cmd, env) => new Promise((res, rej) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 30000, env: { ...process.env, ...(env || {}) } }, (e, out, err) => (e ? rej(new Error(String(err || e.message).trim().slice(0, 300))) : res(String(out).trim()))));
// Fax and OneNote aren't printers anyone means; "Print to PDF" and the XPS writer save a file instead (into Albatross\Printed)
async function printers() {
  if (process.platform !== "win32") return [];
  const out = await ps("Get-CimInstance Win32_Printer | Select-Object Name,Default,WorkOffline,PortName | ConvertTo-Json -Compress");
  const j = out ? JSON.parse(out) : [];
  return (Array.isArray(j) ? j : [j]).filter((p) => !/^(fax|onenote)\b/i.test(p.Name) && !/^(SHRFAX:|nul:)$/i.test(p.PortName || ""))
    .map((p) => ({ name: p.Name, default: !!p.Default, offline: !!p.WorkOffline, toFile: /^PORTPROMPT:$/i.test(p.PortName || "") }));
}
// Printing goes through print.ps1 (drawn with Windows' own printing, no app opens), because the host usually runs in Windows'
// background session, where an app's own "Print" (Notepad, Photos, a PDF reader) can't work.
const PRINTABLE = /\.(txt|md|csv|log|json|pdf|png|jpe?g|bmp|gif|docx?|rtf|odt|html?|xlsx?|ods|pptx?|odp)$/i;
async function print(spec, printer) {
  if (process.platform !== "win32") throw new Error("Printing is only set up for Windows.");
  const r = resolve(spec);
  let st; try { st = fs.statSync(r.full); } catch { throw new Error("That file doesn't exist."); }
  if (!st.isFile()) throw new Error("That is a folder.");
  if (BAD_EXT.test(r.full)) throw new Error("Programs and scripts can't be printed.");
  if (!PRINTABLE.test(r.full)) throw new Error("That kind of file can't be printed from here (text, PDF, pictures and Office files can).");
  const list = await printers();
  if (!list.length) throw new Error("No printer is installed on this PC.");
  // no printer named: a real one (in Windows' background session "Print to PDF" is often the default, which isn't what anyone means)
  const pick = printer ? list.find((p) => p.name.toLowerCase() === String(printer).toLowerCase()) : list.find((p) => p.default && !p.toFile) || list.find((p) => !p.toFile) || list[0];
  if (!pick) throw new Error("No printer called that. Printers: " + list.map((p) => p.name).join(", "));
  if (pick.offline) throw new Error(`The printer ${pick.name} is offline. Switch it on, or pick another printer.`);
  let outFile = "", savedAs = "";
  if (pick.toFile) {
    const dir = path.join(BASE, "Printed"); fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(r.full).replace(/\.[^.]+$/, ""), ext = /xps/i.test(pick.name) ? ".xps" : ".pdf";
    let n = 0; do { outFile = path.join(dir, base + (n ? ` (${n})` : "") + ext); n++; } while (fs.existsSync(outFile));
    savedAs = "all:Printed/" + path.basename(outFile);
  }
  const out = await new Promise((res, rej) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "print.ps1")],
    { windowsHide: true, timeout: 180000, env: { ...process.env, AP_FILE: r.full, AP_PRINTER: pick.name, AP_OUT: outFile } },
    (e, so, se) => (e ? rej(new Error(e.killed ? "Printing took too long and was stopped." : String(se || e.message).trim().split(/\r?\n/)[0].replace(/^.*?\.ps1\s*:\s*/, "").slice(0, 300) || "Printing failed.")) : res(String(so)))));
  const pages = Number((/"pages":(\d+)/.exec(out) || [])[1]) || 0;
  return { printed: r.spec, printer: pick.name, pages, savedAs };
}

// ---------- reading a web page (for the Agent's browser) ----------
function privateIp(ip) {
  if (net.isIPv6(ip)) return /^(::1|fe80|fc|fd|::ffff:(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01])))/i.test(ip) || ip === "::";
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function browse(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error("That isn't a web address."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https pages.");
  // pages inside your own home network (the router, other computers) are off limits: this is for the open web
  const ips = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map((x) => x.address);
  if (!ips.length || ips.some(privateIp)) throw new Error("That address is inside your own network, so it isn't opened.");
  const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 (compatible; Albatross Agent)", Accept: "text/html,text/plain,application/json" } });
  const final = new URL(res.url);
  if (final.hostname !== u.hostname) { const ips2 = net.isIP(final.hostname) ? [final.hostname] : (await dns.lookup(final.hostname, { all: true })).map((x) => x.address); if (ips2.some(privateIp)) throw new Error("It redirected into your own network, so it isn't opened."); }
  const type = res.headers.get("content-type") || "";
  if (!/text|json|xml/.test(type)) throw new Error("That is not a text page (" + (type || "unknown type") + ").");
  const raw = Buffer.from(await res.arrayBuffer()).subarray(0, 1.5 * 1024 * 1024).toString("utf8");
  if (!/html/.test(type)) return { url: res.url, title: "", text: raw.slice(0, 14000), links: [] };
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1] || "";
  const links = [];
  raw.replace(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => { try { const l = new URL(h, res.url); if (/^https?:$/.test(l.protocol) && links.length < 30) links.push({ url: l.href, text: t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80) }); } catch {} return ""; });
  const text = raw.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ").replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
  return { url: res.url, title: title.replace(/\s+/g, " ").trim().slice(0, 200), text: text.slice(0, 14000), truncated: text.length > 14000, links };
}

// ---------- the PC files code ----------
// The PC files window (and everything else that reads files through /pcfiles/) needs a code the user picks. It is kept here as a
// salted hash (<LocalAppData>\Albatross\pcfiles-code.json); the right code gets a key that works for 12 hours. 5 wrong codes in a
// row lock it for 5 minutes. Forgot it: delete that file on the PC and pick a new one.
const crypto = require("crypto");
const CODE_FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "pcfiles-code.json");
const keys = new Map();                                   // key -> valid until
let wrong = 0, lockedUntil = 0;
const codeSet = () => fs.existsSync(CODE_FILE);
const hashOf = (code, salt) => crypto.scryptSync(String(code), salt, 32).toString("hex");
function checkCode(code) {
  if (Date.now() < lockedUntil) throw new Error(`Too many wrong codes. Try again in ${Math.ceil((lockedUntil - Date.now()) / 60000)} min.`);
  const { salt, hash } = JSON.parse(fs.readFileSync(CODE_FILE, "utf8"));
  if (!crypto.timingSafeEqual(Buffer.from(hashOf(code, salt), "hex"), Buffer.from(hash, "hex"))) {
    if (++wrong >= 5) { wrong = 0; lockedUntil = Date.now() + 5 * 60000; }
    throw new Error("Wrong code");
  }
  wrong = 0;
}
function newKey() { const k = crypto.randomBytes(24).toString("hex"); keys.set(k, Date.now() + 12 * 3600000); return k; }
function saveCode(code) {
  if (!/^\d{4,12}$/.test(String(code || ""))) throw new Error("The code must be 4 to 12 digits.");
  const salt = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(CODE_FILE), { recursive: true });
  fs.writeFileSync(CODE_FILE, JSON.stringify({ salt, hash: hashOf(code, salt) }));
  keys.clear();
}
function codeRequest(p, j) {
  if (p === "/pcfiles/code/status") return { set: codeSet(), unlocked: keys.get(j.key) > Date.now() };
  if (p === "/pcfiles/code/set") {
    if (codeSet()) checkCode(j.old);
    saveCode(j.code);
    return { key: newKey() };
  }
  if (p === "/pcfiles/code/unlock") { if (!codeSet()) throw new Error("No code yet"); checkCode(j.code); return { key: newKey() }; }
  if (p === "/pcfiles/code/lock") { keys.delete(j.key); return { ok: true }; }
  return null;
}

async function handle(method, p, body, note) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  try {
    if (p.startsWith("/pcfiles/code/")) { const r = codeRequest(p, j); return r ? [200, r] : [404, { error: "Unknown request" }]; }
    if (p.startsWith("/pcfiles/") && !(keys.get(j.key) > Date.now())) return [401, { error: codeSet() ? "PC files are locked" : "PC files need a code" }];
    if (p === "/pcfiles/roots") return [200, { roots: Object.entries(ROOTS).map(([id, r]) => ({ id, name: r.name, write: r.write, exists: fs.existsSync(r.dir) })), base: BASE }];
    if (p === "/pcfiles/list") return [200, list(j.spec)];
    if (p === "/pcfiles/read") return [200, read(j.spec, { b64: !!j.b64, max: j.max })];
    if (p === "/pcfiles/trash") { const r = await trash(j.spec); note(`PC files: moved ${r.spec} to the Recycle Bin`); return [200, r]; }
    if (p === "/agent/list") return [200, list(j.spec)];
    if (p === "/agent/read") return [200, read(j.spec, { max: 60 * 1024 })];
    if (p === "/agent/write") { const r = write(j.spec, j.content, j.mode); note(`Agent: ${r.created ? "wrote" : "changed"} ${r.spec}`); return [200, r]; }
    if (p === "/agent/move") { const r = move(j.from, j.to, !!j.copy); note(`Agent: ${r.copied ? "copied" : "moved"} ${r.from} to ${r.to}`); return [200, r]; }
    if (p === "/agent/mkdir") return [200, mkdir(j.spec)];
    if (p === "/agent/printers") return [200, { printers: await printers() }];
    if (p === "/agent/print") { const r = await print(j.spec, j.printer); note(`Agent: printed ${r.printed} on ${r.printer}`); return [200, r]; }
    if (p === "/agent/browse") return [200, await browse(j.url)];
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown request" }];
}

module.exports = { handle, ROOTS, BASE, resolve };
