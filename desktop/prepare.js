// Copies what the app needs to run on its own into desktop/bundle (packed into the installer as resources/albatross):
// the host (the part that talks to Ollama, files, mail, the browser ...), the website it shows, the Chrome extension, and the
// two packages the host uses. Run by "npm run dist" before building the installer.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "bundle");
fs.rmSync(OUT, { recursive: true, force: true });
const skip = /(^|[\\/])(host-code\.json|schedule\.json|.*\.log(\.old)?|comfyui\.log|node_modules)$/i;
const copy = (from, to) => fs.cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true, filter: (f) => !skip.test(path.relative(ROOT, f)) || f === path.join(ROOT, from) });
copy("host", "host");
copy("public", "public");
copy("extension", "extension");
for (const dep of ["ws", "pdfjs-dist", "@napi-rs"]) fs.cpSync(path.join(ROOT, "node_modules", dep), path.join(OUT, "node_modules", dep), { recursive: true });
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify({ name: "albatross-files", private: true }, null, 2));
console.log("bundle ready:", OUT);
