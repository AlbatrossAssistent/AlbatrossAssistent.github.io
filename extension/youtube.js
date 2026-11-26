// YouTube without waiting for ads. When YouTube plays an ad in the player (#movie_player gets the class "ad-showing"), the ad is
// muted, played at 16x speed and jumped to its end, and its Skip button is pressed as soon as there is one. When the video comes
// back, your sound and speed are as they were, at the same place in the video. Banner ads over the video are closed.
// (Loading the video a second time and switching to it doesn't work: every load of a video gets its own ads, at the same places.)
// On by default; ⋯ → "YouTube ads" in the sidebar switches it off (chrome.storage.local "ytAds").
(() => {
  let on = true, saved = null;
  try {
    chrome.storage.local.get("ytAds", (v) => { on = !v || v.ytAds !== false; });
    chrome.storage.onChanged.addListener((c) => { if (c.ytAds) on = c.ytAds.newValue !== false; });
  } catch {}
  const SKIP = ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button, button[id^='skip-button']";
  function tick() {
    const player = document.querySelector("#movie_player, .html5-video-player");
    const video = player && player.querySelector("video");
    if (!video) return;
    const ad = on && player.classList.contains("ad-showing");
    if (ad) {
      if (!saved) saved = { muted: video.muted, rate: video.playbackRate };
      video.muted = true;
      try { video.playbackRate = 16; } catch {}
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.3) { try { video.currentTime = video.duration - 0.1; } catch {} }
      const skip = document.querySelector(SKIP);
      if (skip) skip.click();
    } else if (saved) {
      // the ad is over: the video plays with your own sound and speed again
      video.muted = saved.muted;
      try { video.playbackRate = saved.rate === 16 ? 1 : saved.rate; } catch {}
      saved = null;
    }
    if (on) for (const b of document.querySelectorAll(".ytp-ad-overlay-close-button")) b.click();
  }
  setInterval(tick, 200);
  // react at once when the player switches to an ad, not only on the next tick
  const watch = () => { const p = document.querySelector("#movie_player"); if (p) new MutationObserver(tick).observe(p, { attributes: true, attributeFilter: ["class"] }); else setTimeout(watch, 1000); };
  watch();
})();
