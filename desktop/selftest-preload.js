// For the self-check window only (see runSelfTest in main.js): before the app's own scripts run, it gives the throwaway profile
// the same start settings as the smoke test (no intro, not connected to anything real) and records every script error.
window.__errs = [];
window.addEventListener("error", (e) => window.__errs.push((e.message || "error") + " @ " + String(e.filename || "").split("/").pop() + ":" + e.lineno));
try {
  localStorage.setItem("burrow.settings", JSON.stringify({ theme: "dark", intro: false, serverVersion: 2, conn: { mode: "local", url: "http://127.0.0.1:1" } }));
  localStorage.setItem("burrow.termsAccepted", JSON.stringify("2099-01-01"));
  localStorage.setItem("burrow.seenVersion", JSON.stringify("9999-01-01.1"));
} catch {}
