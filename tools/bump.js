// Raises the app's version for a release: APP_VERSION in public/app.js (today's date + a running number), a line for the
// "Albatross was updated" pop-up (WHATS_NEW), and the ?v= on app.css / app.js / account.js in public/index.html, so no browser
// mixes a new page with an old cached script.
//   node tools/bump.js "What changed, in one sentence" ["Another line" ...]
const fs = require("fs"), path = require("path");
const P = path.join(__dirname, "..", "public");
const lines = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (!lines.length) { console.error('usage: node tools/bump.js "what changed" ["more" ...]'); process.exit(2); }
let js = fs.readFileSync(path.join(P, "app.js"), "utf8");
const old = (/const APP_VERSION = "([^"]+)"/.exec(js) || [])[1];
if (!old) { console.error("APP_VERSION not found in app.js"); process.exit(1); }
const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const [oldDay, oldN] = old.split(".");
const ver = `${today}.${oldDay === today ? Number(oldN) + 1 : 1}`;
js = js.replace(`const APP_VERSION = "${old}";`, `const APP_VERSION = "${ver}";`);
js = js.replace("const WHATS_NEW = [\n", `const WHATS_NEW = [\n  [${JSON.stringify(ver)}, ${JSON.stringify(lines)}],\n`).replace("const WHATS_NEW = [\r\n", `const WHATS_NEW = [\r\n  [${JSON.stringify(ver)}, ${JSON.stringify(lines)}],\r\n`);
fs.writeFileSync(path.join(P, "app.js"), js);
const htmlFile = path.join(P, "index.html");
fs.writeFileSync(htmlFile, fs.readFileSync(htmlFile, "utf8").replace(/((?:app\.css|app\.js|account\.js)\?v=)[\w.-]+/g, `$1${ver}`));
console.log(`${old} -> ${ver}`);
