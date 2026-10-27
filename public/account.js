// Optional account (Firebase Auth + Firestore): syncs settings between devices.
// Secrets (the PC code, the turn-on link) are encrypted in the browser with a passphrase before upload,
// so the database only ever holds ciphertext for them. No analytics.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyAuAODa8DAj8nAgdllfYYqCcS_Syt4-q6Y",
  authDomain: "albatross-63e62.firebaseapp.com",
  projectId: "albatross-63e62",
  storageBucket: "albatross-63e62.firebasestorage.app",
  messagingSenderId: "413247408292",
  appId: "1:413247408292:web:2f6af55a73ca422cc43e31",
});
const auth = getAuth(app), db = getFirestore(app);
let user = null, cloud = null, vaultKey = null, pushTimer = 0, applying = false;

const msg = (t, bad) => { const m = $("#accMsg"); m.hidden = !t; m.textContent = t || ""; m.style.color = bad ? "var(--danger)" : ""; };
const nice = (e) => ({
  "auth/invalid-credential": "Wrong email or password.", "auth/wrong-password": "Wrong email or password.", "auth/user-not-found": "No account with that email.",
  "auth/email-already-in-use": "There's already an account with that email. Sign in instead.", "auth/weak-password": "Use at least 6 characters.",
  "auth/invalid-email": "That email address doesn't look right.", "auth/popup-closed-by-user": "Sign-in window closed.",
  "auth/unauthorized-domain": "This website isn't allowed to sign in yet (Firebase → Authentication → Settings → Authorized domains).",
  "permission-denied": "The database refused access. Check the Firestore rules.",
}[e.code] || e.message);

// ---- passphrase encryption (PBKDF2 + AES-GCM), like the code's own encryption ----
async function deriveVault(pass, salt) {
  const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const secrets = () => ({ code: S.conn.code || "", powerUrl: store.get("powerUrl", ""), wakeHost: store.get("wakeHost", ""), wakePort: store.get("wakePort", ""), wakeMac: store.get("wakeMac", ""), connSecrets: store.get("connSecrets", {}) });
function publicSettings() {
  const c = structuredClone(S);
  c.conn = { ...c.conn, code: "" };           // the code only travels inside the vault
  return c;
}

async function push() {
  if (!user || applying) return;
  const data = { settings: publicSettings(), updated: serverTimestamp() };
  if (vaultKey && cloud?.vault?.salt) data.vault = { salt: cloud.vault.salt, check: cloud.vault.check, data: await seal(vaultKey, JSON.stringify(secrets()), "albatross-vault") };
  try { await setDoc(doc(db, "users", user.uid), data, { merge: true }); if (data.vault) cloud.vault = data.vault; $("#accSync").textContent = "Saved · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { $("#accSync").textContent = "Couldn't save: " + nice(e); }
}
const schedulePush = () => { clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); };

// every saveSettings() also syncs, and so does saving the power PIN
const _save = saveSettings;
saveSettings = function () { _save(); schedulePush(); };
const _set = store.set;
store.set = function (k, v) { const r = _set.call(store, k, v); if (/^(powerUrl|wakeHost|wakePort|wakeMac|connSecrets)$/.test(k)) schedulePush(); return r; };

function applyCloud(settings) {
  applying = true;
  const keepCode = S.conn.code;
  S = deepMerge(structuredClone(DEFAULTS), settings || {});
  if (!S.conn.code) S.conn.code = keepCode;
  _save(); applyAppearance(); loadImgFields(); renderAll(); if (isHome()) renderHome();
  applying = false;
}
async function openVault(pass) {
  const v = cloud?.vault;
  if (!v?.salt) {   // first time: create the vault with this passphrase
    const salt = crypto.getRandomValues(new Uint8Array(16));
    vaultKey = await deriveVault(pass, salt);
    cloud = cloud || {};
    cloud.vault = { salt: toB64(salt), check: await seal(vaultKey, "albatross", "albatross-check") };
    await push();
    return true;
  }
  const key = await deriveVault(pass, b64ToU8(v.salt));
  try { if (await unseal(key, v.check, "albatross-check") !== "albatross") throw 0; } catch { return false; }
  vaultKey = key;
  if (v.data) {
    const sec = JSON.parse(await unseal(key, v.data, "albatross-vault"));
    applying = true;
    if (sec.code) S.conn.code = sec.code;
    if (sec.powerUrl) _set.call(store, "powerUrl", sec.powerUrl);
    for (const k of ["wakeHost", "wakePort", "wakeMac"]) if (sec[k]) _set.call(store, k, sec[k]);
    if (sec.connSecrets && typeof sec.connSecrets === "object") _set.call(store, "connSecrets", { ...store.get("connSecrets", {}), ...sec.connSecrets });   // the saved connections' codes
    updatePowerBox(connected);
    _save(); applying = false;
    connect(true); checkSearch(); checkHost();
  }
  return true;
}
function renderVault() {
  const has = !!cloud?.vault?.salt;
  $("#vaultText").textContent = vaultKey
    ? "Unlocked on this device. Your PC code and turn-on link are saved encrypted with your passphrase."
    : has ? "Enter your passphrase to restore your PC code and turn-on link on this device."
          : "Choose a passphrase to also save your PC code and turn-on link, encrypted. Write it down: it can't be recovered, and nobody can reset it for you.";
  $("#vaultBtn").textContent = vaultKey ? "Unlocked" : has ? "Unlock" : "Set passphrase";
  $("#vaultBtn").disabled = !!vaultKey; $("#vaultPass").disabled = !!vaultKey;
}

onAuthStateChanged(auth, async (u) => {
  user = u; vaultKey = null; cloud = null;
  $("#accOut").hidden = !!u; $("#accIn").hidden = !u;
  if (!u) { msg(""); return; }
  $("#accWho").textContent = u.displayName ? `${u.displayName} · ${u.email}` : u.email;
  try {
    const snap = await getDoc(doc(db, "users", u.uid));
    cloud = snap.exists() ? snap.data() : null;
    if (cloud?.settings) { applyCloud(cloud.settings); toast("Settings loaded from your account"); }
    else await push();          // first sign-in: upload what this device has
    msg("");
  } catch (e) { msg("Signed in, but the settings couldn't load: " + nice(e), true); }
  renderVault();
});

$("#accGoogle").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => msg(nice(e), true));
const creds = () => [$("#accEmail").value.trim(), $("#accPass").value];
$("#accSignIn").onclick = () => signInWithEmailAndPassword(auth, ...creds()).catch(e => msg(nice(e), true));
$("#accSignUp").onclick = () => createUserWithEmailAndPassword(auth, ...creds()).then(() => toast("Account created")).catch(e => msg(nice(e), true));
$("#accReset").onclick = () => { const [email] = creds(); if (!email) return msg("Enter your email first.", true); sendPasswordResetEmail(auth, email).then(() => msg("Check your inbox for a reset link.")).catch(e => msg(nice(e), true)); };
$("#accSignOut").onclick = () => signOut(auth).then(() => toast("Signed out. Your settings stay on this device."));
$("#vaultBtn").onclick = async () => {
  const pass = $("#vaultPass").value;
  if (pass.length < 8) return msg("Use at least 8 characters for the passphrase.", true);
  $("#vaultBtn").disabled = true;
  try { if (await openVault(pass)) { msg(""); $("#vaultPass").value = ""; toast("Code and turn-on link unlocked"); } else msg("Wrong passphrase.", true); }
  catch (e) { msg(nice(e), true); }
  renderVault();
};
$("#accDelete").onclick = () => armed2("cloud", async () => {
  try { await deleteDoc(doc(db, "users", user.uid)); cloud = null; vaultKey = null; renderVault(); toast("Cloud data deleted. Sign out to stop syncing."); }
  catch (e) { msg(nice(e), true); }
});
