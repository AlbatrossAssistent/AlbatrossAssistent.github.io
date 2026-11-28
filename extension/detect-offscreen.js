// Detect on a tab: the tab's picture comes in as a video stream (chrome.tabCapture, started from the menu). Each frame is taken straight
// from the stream (MediaStreamTrackProcessor: no <video> element, which a page nobody sees may never decode), drawn onto a canvas,
// and COCO-SSD looks at it, as often as the graphics card allows. Every result and every step goes to the tab (background.js passes
// it to detect-overlay.js, which draws the boxes and shows the status). It only looks: it never clicks, aims or types.
let stream = null, tabId = null, run = 0, model = null;
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (!m || m.det !== "offscreen") return;
  if (m.cmd === "ping") { reply({ ok: true }); return; }
  if (m.cmd === "start") { reply({ ok: true }); start(m); return; }
  if (m.cmd === "stop") { stop(); reply({ ok: true }); }
});
async function start(m) {
  stop(); const me = ++run; tabId = m.tabId;
  try {
    say({ status: "getting the tab's picture…" });
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: m.streamId, maxWidth: 1280, maxHeight: 1280, maxFrameRate: 30 } } });
    const track = stream.getVideoTracks()[0];
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    say({ status: "loading the AI (the first time takes a few seconds)…" });
    model = model || await cocoSsd.load({ base: "lite_mobilenet_v2" });
    say({ status: "looking…" });
    const cv = document.createElement("canvas"), ctx = cv.getContext("2d");
    while (me === run) {
      const { value: frame, done } = await reader.read();
      if (done || me !== run) { if (frame) frame.close(); break; }
      const w = frame.displayWidth, h = frame.displayHeight;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      ctx.drawImage(frame, 0, 0); frame.close();
      const t0 = performance.now();
      const preds = await model.detect(cv, 30, 0.3);
      if (me !== run) break;
      say({ w, h, ms: Math.round(performance.now() - t0), preds: preds.map((p) => ({ c: p.class, s: Math.round(p.score * 100) / 100, b: p.bbox.map(Math.round) })) });
    }
    try { reader.cancel(); } catch {}
    if (me === run) say({ status: "the tab's picture ended", end: true });
  } catch (e) { say({ status: "couldn't: " + (e && e.message || e), end: true }); stop(); }
}
function stop() { run++; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }
function say(o) { chrome.runtime.sendMessage({ det: "result", tabId, ...o }).catch(() => {}); }
