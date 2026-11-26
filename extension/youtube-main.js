// Runs in YouTube's own page (world "MAIN"), where the player's data is: tells youtube.js where in the video the ads are (for
// "Jump to the next ad" in the sidebar, to try the ad settings). Answers window messages { albYt: "cues?" } with
// { albYt: "cues", cues: [seconds, ...] } (ads in the middle; the one at the start and the one at the end left out).
(() => {
  function cues() {
    const out = new Set();
    let resp = null;
    try { const p = document.getElementById("movie_player"); resp = p && p.getPlayerResponse ? p.getPlayerResponse() : null; } catch {}
    if (!resp) resp = window.ytInitialPlayerResponse || null;
    for (const a of (resp && resp.adPlacements) || []) {
      const c = a && a.adPlacementRenderer && a.adPlacementRenderer.config && a.adPlacementRenderer.config.adPlacementConfig;
      if (!c || c.kind !== "AD_PLACEMENT_KIND_MILLISECONDS") continue;
      const ms = Number(c.adTimeOffset && c.adTimeOffset.offsetStartMilliseconds);
      if (ms > 0) out.add(Math.round(ms / 100) / 10);
    }
    return [...out].sort((a, b) => a - b);
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.albYt !== "cues?") return;
    window.postMessage({ albYt: "cues", cues: cues() }, "*");
  });
})();
