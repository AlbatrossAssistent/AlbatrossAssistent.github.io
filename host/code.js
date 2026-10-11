// The Code tool: the website's AI writes a project into a folder on this PC and can read it back for later changes.
// Everything lands in <Downloads>\Albatross\Code\<project>\ and nowhere else. Nothing written here is ever run by the host.
//
// Requests come from the website (this PC through the control center's doorway, other devices end-to-end encrypted).

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = process.env.ALBATROSS_CODE || path.join(process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross"), "Code");
const MAX_FILE = 2 * 1024 * 1024;      // per file
const MAX_FILES = 200;                 // per request
const MAX_PROJECT = 30 * 1024 * 1024;  // per project folder
const READ_FILE = 40 * 1024, READ_TOTAL = 200 * 1024;
const BAD_EXT = /\.(exe|dll|msi|scr|com|pif|lnk|scf|url|inf|sys|cpl)$/i;   // programs and Windows shortcut tricks, never text a project needs
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function slug(n) {
  const s = String(n || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return s || "project";
}
// "src/app.js" -> ["src", "app.js"]; null if it could leave the project folder or isn't a plain name.
function cleanPath(p) {
  const raw = String(p || "").replace(/\\/g, "/").trim();
  if (!raw || raw.length > 200 || raw.startsWith("/") || /^[a-z]:/i.test(raw)) return null;
  const parts = raw.split("/").filter((x) => x !== "" && x !== ".");
  if (!parts.length || parts.length > 8) return null;
  for (const seg of parts) {
    if (seg === ".." || /[<>:"|?*\u0000-\u001f]/.test(seg) || /[. ]$/.test(seg) || RESERVED.test(seg)) return null;
  }
  const name = parts[parts.length - 1];
  if (BAD_EXT.test(name) || /^(desktop\.ini|autorun\.inf)$/i.test(name)) return null;
  return parts;
}
function dirSize(dir) {
  let n = 0;
  try { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, d.name); n += d.isDirectory() ? dirSize(f) : d.isFile() ? fs.statSync(f).size : 0; } } catch {}
  return n;
}
function walk(dir, base = "", out = []) {
  let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of list.sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.isSymbolicLink()) continue;
    const rel = base ? base + "/" + d.name : d.name;
    if (d.isDirectory()) { if (!/^(node_modules|\.git)$/.test(d.name)) walk(path.join(dir, d.name), rel, out); }
    else if (d.isFile()) out.push({ path: rel, size: fs.statSync(path.join(dir, d.name)).size });
    if (out.length >= 500) break;
  }
  return out;
}

function handle(method, p, body, note) {
  let j = {};
  try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  fs.mkdirSync(ROOT, { recursive: true });
  const project = slug(j.project);
  const dir = path.join(ROOT, project);

  if (method === "POST" && p === "/code/write") {
    const files = Array.isArray(j.files) ? j.files.slice(0, MAX_FILES) : [];
    if (!files.length) return [400, { error: "No files to write." }];
    fs.mkdirSync(dir, { recursive: true });
    let total = dirSize(dir);
    const written = [], skipped = [];
    for (const f of files) {
      const parts = cleanPath(f && f.path);
      if (!parts) { skipped.push({ path: String(f && f.path || "").slice(0, 80), reason: "not an allowed file name" }); continue; }
      const rel = parts.join("/"), target = path.join(dir, ...parts);
      if (target !== dir && !target.startsWith(dir + path.sep)) { skipped.push({ path: rel, reason: "outside the project folder" }); continue; }
      const data = Buffer.from(String(f.content == null ? "" : f.content), "utf8");
      if (data.length > MAX_FILE) { skipped.push({ path: rel, reason: "bigger than 2 MB" }); continue; }
      let existed = 0;
      try { const st = fs.lstatSync(target); if (!st.isFile()) { skipped.push({ path: rel, reason: "a folder or link is in the way" }); continue; } existed = st.size; } catch {}
      if (total - existed + data.length > MAX_PROJECT) { skipped.push({ path: rel, reason: "the project would be bigger than 30 MB" }); continue; }
      try {
        // a folder in the middle of the path must be a real folder too, not a link pointing elsewhere
        let cur = dir, bad = false;
        for (const seg of parts.slice(0, -1)) {
          cur = path.join(cur, seg);
          try { const st = fs.lstatSync(cur); if (!st.isDirectory()) { bad = true; break; } } catch { fs.mkdirSync(cur); }
        }
        if (bad) { skipped.push({ path: rel, reason: "a link or file is in the way" }); continue; }
        const tmp = target + ".albatross-part";
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, target);
        total += data.length - existed;
        written.push({ path: rel, size: data.length, created: !existed });
      } catch (e) { skipped.push({ path: rel, reason: e.message }); }
    }
    if (written.length) note(`Code: wrote ${written.length} file${written.length > 1 ? "s" : ""} to ${project}`);
    return [200, { project, folder: dir, written, skipped }];
  }

  // Everything the project has, so the AI can change it later (also picks up what you edited by hand).
  if (method === "POST" && p === "/code/read") {
    if (!fs.existsSync(dir)) return [404, { error: "That project isn't on this PC (anymore)." }];
    let left = READ_TOTAL;
    const files = walk(dir).map((f) => {
      const out = { path: f.path, size: f.size };
      if (f.size <= READ_FILE && f.size <= left && !BAD_EXT.test(f.path)) {
        try { const b = fs.readFileSync(path.join(dir, f.path)); if (!b.includes(0)) { out.content = b.toString("utf8"); left -= f.size; } } catch {}
      }
      return out;
    });
    return [200, { project, folder: dir, files }];
  }

  if (method === "POST" && p === "/code/projects") {
    let list = [];
    try { list = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, time: fs.statSync(path.join(ROOT, d.name)).mtimeMs })).sort((a, b) => b.time - a.time).slice(0, 30); } catch {}
    return [200, { folder: ROOT, projects: list }];
  }
  return [404, { error: "Unknown code request" }];
}

module.exports = { handle, slug, cleanPath, ROOT };
