// Which Albatross account a request comes from, so chats and lists on this PC are kept per account.
// The website sends the signed-in account's Firebase ID token as "_acct" in the request's body (inside the end-to-end
// encryption). It is checked here against Google's public keys (signature, project, issuer, expiry), and the account's id
// ("uid") decides the folder. No token: the shared "no account" chats, as before. A token that doesn't check out is refused,
// never treated as "no account", so one account's chats can't end up in another's.

const crypto = require("crypto");

const PROJECT = "albatross-63e62";
const CERTS = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let certs = { at: 0, ttl: 0, keys: {} };
const seen = new Map();          // token -> { uid, exp }: checked once, not on every request

async function keys(force) {
  if (!force && Date.now() - certs.at < certs.ttl) return certs.keys;
  const r = await fetch(CERTS, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Couldn't check your sign-in (Google's keys: HTTP " + r.status + ")");
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  certs = { at: Date.now(), ttl: (m ? Number(m[1]) : 3600) * 1000, keys: await r.json() };
  return certs.keys;
}
const b64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const refuse = () => Object.assign(new Error("Your sign-in couldn't be checked. Sign in again (Settings → Account)."), { status: 401 });

async function verify(token) {
  if (!token) return "";
  if (typeof token !== "string" || token.length > 4096) throw refuse();
  const hit = seen.get(token);
  if (hit && hit.exp * 1000 > Date.now()) return hit.uid;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw refuse();
  let head, claims;
  try { head = JSON.parse(b64u(h)); claims = JSON.parse(b64u(p)); } catch { throw refuse(); }
  if (head.alg !== "RS256" || !head.kid) throw refuse();
  let cert = (await keys())[head.kid];
  if (!cert) cert = (await keys(true))[head.kid];                     // Google rotated its keys
  if (!cert) throw refuse();
  const ok = crypto.createVerify("RSA-SHA256").update(h + "." + p).verify(cert, b64u(s));
  const now = Date.now() / 1000;
  if (!ok || claims.aud !== PROJECT || claims.iss !== "https://securetoken.google.com/" + PROJECT || !(claims.exp > now) || claims.iat > now + 300 || typeof claims.sub !== "string" || !claims.sub) throw refuse();
  const uid = /^[A-Za-z0-9_-]{1,128}$/.test(claims.sub) ? claims.sub : crypto.createHash("sha256").update(claims.sub).digest("hex").slice(0, 40);
  if (seen.size > 500) for (const [k, v] of seen) if (v.exp * 1000 < Date.now()) seen.delete(k);
  seen.set(token, { uid, exp: claims.exp });
  return uid;
}

// Takes "_acct" out of a JSON body: [uid ("" for no account), the body without it]
async function fromBody(body) {
  let j; try { j = JSON.parse(body || "{}"); } catch { return ["", body]; }
  if (!j || typeof j !== "object" || Array.isArray(j) || !("_acct" in j)) return ["", body];
  const t = j._acct; delete j._acct;
  return [await verify(t), JSON.stringify(j)];
}

module.exports = { verify, fromBody };
