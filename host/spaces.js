// Whose files: everything Albatross makes or receives on this PC (pictures, the AI's folder, code projects, files sent with
// Beam) is kept apart per account, like the chats (chats.js):
//   a signed-in account          Downloads\Albatross\Accounts\<account>\...
//   guests (the guest code)      Downloads\Albatross\Guests\...
//   no account (the PC's owner)  Downloads\Albatross\...   (as before; the Accounts and Guests folders are left out of its lists)
// A request runs inside run(space, fn); the file code asks current() where it is, so it doesn't have to pass the space along.
// The account comes from the sign-in token the website sends inside the end-to-end encryption, checked in account.js.
const path = require("path"), os = require("os");
const { AsyncLocalStorage } = require("async_hooks");

const BASE = path.resolve(process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross"));
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const SPACE_DIRS = new Set(["Accounts", "Guests"]);
const als = new AsyncLocalStorage();

function spaceOf(uid) {
  if (uid === "guest") return "Guests";
  if (uid && UID.test(uid)) return path.join("Accounts", uid);
  return "";
}
const baseOf = (space) => (space ? path.join(BASE, space) : BASE);
const run = (space, fn) => als.run(String(space || ""), fn);
const current = () => als.getStore() || "";
// in the owner's (shared) space, the other spaces' folders aren't part of "All files"
const hidden = (space, dir, name) => !space && path.resolve(dir) === BASE && SPACE_DIRS.has(name);
// is this file inside a "Pictures" folder of any space (for guest recaps and picture links)
function isPicturePath(full) {
  const rel = path.relative(BASE, path.resolve(full));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length >= 2 && parts[parts.length - 2] === "Pictures";
}

module.exports = { BASE, spaceOf, baseOf, run, current, hidden, isPicturePath, SPACE_DIRS };
