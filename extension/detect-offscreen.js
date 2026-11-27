// Detect on a tab: the tab's picture comes in as video (chrome.tabCapture, started from the menu), COCO-SSD looks at it as often as
// the graphics card allows, and every result goes to the tab (background.js passes it to detect-overlay.js, which draws the boxes).
// It only looks: it never clicks, aims or types on the page.
let stream = null, tabId = null, run = 0, model = null;
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.det !== "offscreen") return;
  if (m.cmd === "start") start(m);
  if (m.cmd === "stop") stop();
});
async function start(m) {
  stop(); const me = ++run; tabId = m.tabId;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: m.streamId, maxWidth: 1280, maxHeight: 1280, maxFrameRate: 30 } } });
    const v = document.getElementById("v"); v.srcObject = stream; await v.play();
    say({ status: "Loading the AI…" });
    model = model || await cocoSsd.load({ base: "lite_mobilenet_v2" });
    say({ status: "" });
    while (me === run) {
      const t0 = performance.now();
      const preds = await model.detect(v, 30, 0.3).catch(() => []);
      if (me !== run) return;
      say({ w: v.videoWidth, h: v.videoHeight, ms: Math.round(performance.now() - t0), preds: preds.map((p) => ({ c: p.class, s: Math.round(p.score * 100) / 100, b: p.bbox.map(Math.round) })) });
      await new Promise((r) => setTimeout(r, 15));
    }
  } catch (e) { say({ status: "Couldn't watch this tab: " + (e.message || e), end: true }); stop(); }
}
function stop() { run++; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }
function say(o) { chrome.runtime.sendMessage({ det: "result", tabId, ...o }).catch(() => {}); }
