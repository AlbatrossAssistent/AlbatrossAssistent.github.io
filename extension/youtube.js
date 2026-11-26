// YouTube without waiting for ads. Two ways, chosen in the sidebar (⋯ → YouTube ads; chrome.storage.local "ytMode"):
//
// "skip" (the default): when YouTube plays an ad in the player (#movie_player gets the class "ad-showing"), the ad is muted,
//   played at 16x speed and jumped to its end, and its Skip button is pressed as soon as there is one. When the video comes back,
//   your sound and speed are as they were. Banner ads over the video are closed.
//
// "swap": the ads are watched, but not by you. A second copy of the video runs in a hidden, muted tab and stays about a minute
//   ahead of you: when it gets to an ad, the ad plays there. When your copy then reaches that ad, you're switched to the second
//   copy at the same second, already past the ad, with your volume and speed. Your old copy watches its ad muted and becomes the
//   one ahead. The ad at the very start of a video can't be done ahead (both copies get one when they open). The coordination
//   runs in background.js; the hidden tab is driven by messages from it (its own timers are slowed down by Chrome).
//
// "off": nothing.
(() => {
  let mode = "skip", saved = null;
  try {
    chrome.storage.local.get(["ytMode", "ytAds"], (v) => { mode = v.ytMode || (v.ytAds === false ? "off" : "skip"); });
    chrome.storage.onChanged.addListener((c) => { if (c.ytMode) mode = c.ytMode.newValue || "skip"; });
  } catch {}
  const SKIP = ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button, button[id^='skip-button']";
  const parts = () => { const player = document.querySelector("#movie_player, .html5-video-player"); return { player, video: player && player.querySelector("video") }; };
  const isAd = (player) => !!player && player.classList.contains("ad-showing");
  const videoId = () => new URLSearchParams(location.search).get("v") || "";

  // ---------- skip ----------
  function skip(player, video) {
    if (mode === "skip" && isAd(player)) {
      if (!saved) saved = { muted: video.muted, rate: video.playbackRate };
      video.muted = true;
      try { video.playbackRate = 16; } catch {}
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.3) { try { video.currentTime = video.duration - 0.1; } catch {} }
      const b = document.querySelector(SKIP);
      if (b) b.click();
    } else if (saved) {
      // the ad is over: the video plays with your own sound and speed again
      video.muted = saved.muted;
      try { video.playbackRate = saved.rate === 16 ? 1 : saved.rate; } catch {}
      saved = null;
    }
    if (mode === "skip") for (const b of document.querySelectorAll(".ytp-ad-overlay-close-button")) b.click();
  }

  // ---------- swap ----------
  // lastT: where the video itself is (during an ad the <video> plays the ad, so it's kept from before);
  // clear: up to where this copy has had its ads (it played or jumped past every ad before that point)
  let lastT = 0, clear = 0, clearFor = "", seekAt = 0, steady = 0, role = "none";
  function note(player, video) {
    const v = videoId();
    if (v !== clearFor) { clearFor = v; clear = 0; lastT = 0; }
    if (!isAd(player) && !video.seeking && video.readyState >= 2) lastT = video.currentTime;
  }
  async function mainTick(player, video) {
    note(player, video);
    if (!videoId()) return;
    let r; try { r = await chrome.runtime.sendMessage({ yt: "tick", v: videoId(), t: lastT, ad: isAd(player), rate: video.playbackRate, volume: video.volume }); } catch { return; }
    role = (r && r.role) || "none";
  }
  // the hidden copy: told by background.js where you are (lead), it stays 20 to 150 seconds ahead. Jumping ahead makes YouTube
  // play an ad that lies on the way, which is the point; while one plays, it lets it play.
  function helperStep(m) {
    const { player, video } = parts();
    if (!video) return { v: videoId(), clear: 0, ad: false };
    note(player, video);
    if (m.v && m.v !== videoId()) { location.replace("https://www.youtube.com/watch?v=" + encodeURIComponent(m.v) + "&t=" + Math.floor(m.lead + 60) + "s"); return { v: "", clear: 0, ad: false }; }
    const ad = isAd(player);
    if (ad) { steady = 0; video.play().catch(() => {}); return { v: videoId(), clear, ad }; }
    const at = video.currentTime;
    if (Date.now() - seekAt > 2500) {
      if (at < m.lead + 20 || at > m.lead + 150) { try { video.currentTime = m.lead + 60; } catch {} seekAt = Date.now(); steady = 0; video.play().catch(() => {}); return { v: videoId(), clear, ad }; }
      // a few calm looks in a row (no ad, not just jumped): everything up to here has had its ads
      if (++steady >= 3) clear = Math.max(clear, at);
      if (at > m.lead + 90) video.pause(); else video.play().catch(() => {});
    }
    return { v: videoId(), clear, ad };
  }
  // switched to: this copy is now the one you watch, at your second, with your volume and speed
  function become(m) {
    const { video } = parts(); if (!video) return;
    try { video.currentTime = m.t; } catch {}
    try { video.playbackRate = m.rate || 1; } catch {}
    if (typeof m.volume === "number") video.volume = m.volume;
    video.muted = false; video.play().catch(() => {});
    role = "main"; steady = 0;
  }
  // the old one: its ad plays out muted; it already had its ads up to where you were
  function demote(m) { role = "helper"; swapped++; clear = Math.max(clear, m.t || 0); seekAt = 0; steady = 0; }
  // ---------- to try it: jump to just before the next ad ----------
  // The ad places come from YouTube's own page (youtube-main.js). 10 seconds before, so in "swap" the hidden copy has time to
  // get past that ad first.
  const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  function askCues() {
    return new Promise((res) => {
      const on = (e) => { if (e.source === window && e.data && e.data.albYt === "cues") { removeEventListener("message", on); res(e.data.cues || []); } };
      addEventListener("message", on);
      window.postMessage({ albYt: "cues?" }, "*");
      setTimeout(() => { removeEventListener("message", on); res(null); }, 1500);
    });
  }
  async function jumpToAd() {
    const { player, video } = parts();
    if (!video || !videoId()) return { error: "Open a YouTube video first." };
    if (isAd(player)) return { error: "An ad is playing right now." };
    const cues = await askCues();
    if (cues === null) return { error: "Couldn't read the video's ad places (reload the YouTube page once)." };
    const now = video.currentTime, next = cues.find((c) => c > now + 11);
    if (!next) return { error: cues.length ? "No more ads after " + fmt(now) + " in this video." : "YouTube placed no ads in the middle of this video (short videos often have none)." };
    video.currentTime = Math.max(0, next - 10);
    video.play().catch(() => {});
    reportAd(next);
    return { ok: true, text: "Jumped to " + fmt(next - 10) + ": an ad place at " + fmt(next) + " (" + cues.length + " in this video). Whether YouTube fills it, it says shortly after." };
  }
  // After the jump: did an ad really come at that place? An ad place is only an offer: YouTube decides there whether to show one
  // (often not right after a jump, or soon after another ad). The answer goes to the sidebar, with what the setting did.
  let adsSeen = 0, wasAd = false, swapped = 0;
  function reportAd(at) {
    const before = adsSeen, swapsBefore = swapped, until = Date.now() + 45000;
    let cameAt = 0;
    const t = setInterval(() => {
      const { video } = parts();
      const came = adsSeen > before || swapped > swapsBefore;
      if (came && !cameAt) cameAt = Date.now();
      if (came && Date.now() - cameAt < 1500) return;              // in "swap" the switch comes a moment after the ad shows
      const past = video && !isAd(parts().player) && video.currentTime > at + 6;
      if (!came && !past && Date.now() < until) return;
      clearInterval(t);
      const what = swapped > swapsBefore ? "you were switched to the copy ahead (watch ahead, swap)" : mode === "skip" ? "it was muted and skipped (skip)" : mode === "swap" ? "the copy ahead wasn't past it yet, so it played here" : "it played (leave them)";
      const text = came ? "An ad came at " + fmt(at) + ": " + what + "." : "No ad came at " + fmt(at) + ": YouTube left that place empty this time.";
      try { chrome.runtime.sendMessage({ ytNote: text }); } catch {}
    }, 500);
  }
  try {
    chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if (!m || !m.yt) return;
      if (m.yt === "lead") { role = "helper"; reply(helperStep(m)); return; }
      if (m.yt === "become") { become(m); reply({ ok: true }); return; }
      if (m.yt === "demote") { demote(m); reply({ ok: true }); return; }
      if (m.yt === "jumpAd") { jumpToAd().then(reply); return true; }
    });
  } catch {}

  function tick() {
    const { player, video } = parts();
    if (!video) return;
    const a = isAd(player); if (a && !wasAd) adsSeen++; wasAd = a;          // ads that really came (for the jump's report)
    if (mode === "swap") { if (saved) skip(player, video); if (role !== "helper" && !document.hidden) mainTick(player, video); else note(player, video); }
    else skip(player, video);
  }
  setInterval(tick, 250);
  // react at once when the player switches to an ad, not only on the next tick
  const watch = () => { const p = document.querySelector("#movie_player"); if (p) new MutationObserver(tick).observe(p, { attributes: true, attributeFilter: ["class"] }); else setTimeout(watch, 1000); };
  watch();
})();
