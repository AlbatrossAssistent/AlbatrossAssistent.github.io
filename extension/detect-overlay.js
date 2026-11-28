// Detect on a tab: draws the boxes around the people (or everything) the AI finds, over the page, without catching any clicks.
// A small bar in the corner says how many and has the settings and Stop. Only drawing: nothing here clicks, aims or types.
(() => {
  if (window.__albDetect) { window.__albDetect.show(); return; }
  const cv = document.createElement("canvas"), bar = document.createElement("div");
  cv.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646";
  bar.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;padding:7px 10px;border-radius:10px;background:rgba(0,0,0,.78);color:#fff;font:600 12px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35)";
  bar.innerHTML = '<span data-t>Albatross Detect: starting…</span><select data-w style="font:inherit;border-radius:6px"><option value="person">People</option><option value="all">Everything</option></select><button data-x style="font:inherit;border:0;border-radius:6px;padding:3px 8px;cursor:pointer">Stop</button>';
  const st = { what: "person", last: null };
  bar.querySelector("[data-w]").onchange = (e) => { st.what = e.target.value; paint(); };
  bar.querySelector("[data-x]").onclick = () => { chrome.runtime.sendMessage({ det: "stop" }).catch(() => {}); remove(); };
  const ctx = cv.getContext("2d");
  function paint() {
    const r = st.last; const dpr = devicePixelRatio || 1;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.clearRect(0, 0, cv.width, cv.height);
    if (!r || !r.w) return;
    const k = cv.width / r.w, shown = r.preds.filter((p) => st.what === "all" || p.c === "person");
    ctx.lineWidth = 2.5 * dpr; ctx.font = `600 ${12 * dpr}px system-ui,sans-serif`; ctx.textBaseline = "top";
    for (const p of shown) {
      const [x, y, w, h] = p.b.map((v) => v * k), c = p.c === "person" ? "#30D158" : "#FFD60A", label = `${p.c} ${Math.round(p.s * 100)}%`;
      ctx.strokeStyle = c; ctx.strokeRect(x, y, w, h);
      const tw = ctx.measureText(label).width + 8 * dpr; ctx.fillStyle = c; ctx.fillRect(x, Math.max(0, y - 18 * dpr), tw, 18 * dpr);
      ctx.fillStyle = "#000"; ctx.fillText(label, x + 4 * dpr, Math.max(0, y - 18 * dpr) + 3 * dpr);
    }
    const n = shown.filter((p) => p.c === "person").length;
    bar.querySelector("[data-t]").textContent = `Albatross Detect: ${n} ${n === 1 ? "person" : "people"}${st.what === "all" ? `, ${shown.length} things` : ""} · ${r.ms} ms`;
  }
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.det !== "overlay") return;
    if (m.end) { remove(); return; }
    if (m.status != null && m.status !== "") { bar.querySelector("[data-t]").textContent = "Albatross Detect: " + m.status; if (/^couldn't|ended/.test(m.status)) bar.querySelector("[data-x]").textContent = "Close"; }
    if (m.preds) { st.last = m; paint(); }
  });
  addEventListener("resize", paint);
  function remove() { cv.remove(); bar.remove(); window.__albDetect = null; }
  window.__albDetect = { show() { if (!cv.isConnected) document.documentElement.append(cv, bar); } };
  document.documentElement.append(cv, bar);
})();
