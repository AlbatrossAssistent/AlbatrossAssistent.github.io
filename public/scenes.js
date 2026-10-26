// Two more moving backgrounds, for the themes Aurora and Lagoon (the sky in starfield.js is the third kind):
//   aurora  northern lights: curtains of green, teal and violet light sway over a night sky; near the pointer they bend toward
//           it and glow brighter
//   lagoon  clear turquoise water seen from above with moving light patterns; the pointer draws ripples into it, a click
//           drops a big ring wave, and now and then a drop falls by itself
//   const sc = createScene(canvas, "aurora");   each frame: sc.draw(t, { alpha });   sc.pointer(x, y) / sc.pointer(null); sc.click(x, y)
(function () {
  window.createScene = function (canvas, kind) {
    const ctx = canvas.getContext("2d");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, DPR = 1;
    const ptr = { x: 0, y: 0, on: false, sx: 0, sy: 0 };
    function resize() {
      DPR = Math.min(2, devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * DPR)), h = Math.max(1, Math.round(canvas.clientHeight * DPR));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      W = w; H = h; if (kind === "lagoon") makeWater();
    }
    function pointer(cx, cy) {
      if (cx == null) { ptr.on = false; return; }
      const b = canvas.getBoundingClientRect();
      ptr.x = (cx - b.left) * (W / Math.max(1, b.width)); ptr.y = (cy - b.top) * (H / Math.max(1, b.height));
      if (!ptr.on) { ptr.sx = ptr.x; ptr.sy = ptr.y; }
      ptr.on = true;
    }

    // ---------------- aurora ----------------
    const stars = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random() * .75, r: Math.random() * 1.1 + .3, p: Math.random() * 6.28 }));
    const curtains = [
      { y: .30, amp: .07, len: .38, hue: [80, 255, 170], sp: .11, ph: 0 },
      { y: .22, amp: .05, len: .30, hue: [60, 220, 255], sp: .08, ph: 2.1 },
      { y: .38, amp: .06, len: .26, hue: [170, 110, 255], sp: .13, ph: 4.2 },
    ];
    function drawAurora(t, A) {
      const s = reduce ? 0 : t / 1000;
      const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#020612"); g.addColorStop(.6, "#05121c"); g.addColorStop(1, "#0a1a1f");
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = A; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      for (const st of stars) { ctx.globalAlpha = A * (.35 + .35 * Math.sin(s * 1.3 + st.p)); ctx.fillStyle = "#dfe9ff"; ctx.beginPath(); ctx.arc(st.x * W, st.y * H, st.r * DPR, 0, 6.2832); ctx.fill(); }
      // the pointer, followed softly
      ptr.sx += (ptr.x - ptr.sx) * .08; ptr.sy += (ptr.y - ptr.sy) * .08;
      ctx.globalCompositeOperation = "lighter";
      const step = Math.max(3, Math.round(4 * DPR));
      for (const c of curtains) {
        const [r, gg, b] = c.hue;
        for (let x = -step; x < W + step; x += step) {
          const u = x / W;
          let y = (c.y + c.amp * Math.sin(u * 5.2 + s * c.sp * 6 + c.ph) + c.amp * .5 * Math.sin(u * 13.7 - s * c.sp * 9 + c.ph * 2)) * H;
          let glow = .45 + .35 * Math.sin(u * 23 + s * 1.7 + c.ph) * Math.sin(u * 7 - s * .9);
          if (ptr.on) {                                                  // near the pointer the curtain leans toward it and brightens
            const dx = (x - ptr.sx) / (W * .18), near = Math.exp(-dx * dx);
            y += (ptr.sy - y) * .35 * near; glow += .9 * near;
          }
          const len = c.len * H * (.7 + .3 * Math.sin(u * 9 + s * .6 + c.ph));
          const rg = ctx.createLinearGradient(0, y - len, 0, y + len * .12);
          rg.addColorStop(0, `rgba(${r},${gg},${b},0)`); rg.addColorStop(.75, `rgba(${r},${gg},${b},${Math.max(0, .09 * glow)})`); rg.addColorStop(1, `rgba(${r},${gg},${b},0)`);
          ctx.globalAlpha = A; ctx.fillStyle = rg; ctx.fillRect(x, y - len, step + 1, len * 1.12);
        }
      }
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    }

    // ---------------- lagoon: a small ripple simulation, drawn bigger ----------------
    let gw = 0, gh = 0, cur = null, prev = null, img = null, off = null, offCtx = null, lastDrop = 0, lastTick = 0;
    function makeWater() {
      gw = Math.max(40, Math.round(W / (5 * DPR))); gh = Math.max(30, Math.round(H / (5 * DPR)));
      cur = new Float32Array(gw * gh); prev = new Float32Array(gw * gh);
      off = document.createElement("canvas"); off.width = gw; off.height = gh; offCtx = off.getContext("2d"); img = offCtx.createImageData(gw, gh);
    }
    function drop(x, y, strength, radius) {
      const cx = Math.round(x / W * gw), cy = Math.round(y / H * gh), R = radius || 2;
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
        const xx = cx + i, yy = cy + j; if (xx < 1 || yy < 1 || xx >= gw - 1 || yy >= gh - 1) continue;
        const d = Math.hypot(i, j); if (d <= R) prev[yy * gw + xx] += strength * (1 - d / (R + 1));
      }
    }
    function drawLagoon(t, A) {
      if (!cur) makeWater();
      const s = reduce ? 0 : t / 1000;
      if (!reduce) {
        // the pointer stirs the water as it moves; a drop falls by itself now and then
        if (ptr.on) { const d = Math.hypot(ptr.x - ptr.sx, ptr.y - ptr.sy); if (d > 2 * DPR) drop(ptr.x, ptr.y, Math.min(260, 40 + d * 3), 1); ptr.sx = ptr.x; ptr.sy = ptr.y; }
        if (t - lastDrop > 2600 + Math.random() * 3000) { lastDrop = t; drop(Math.random() * W, Math.random() * H, 220, 2); }
        if (t - lastTick > 15) {                                       // one step of the wave equation (about 60 per second)
          lastTick = t;
          for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
            const i = y * gw + x;
            const v = (prev[i - 1] + prev[i + 1] + prev[i - gw] + prev[i + gw]) / 2 - cur[i];
            cur[i] = v * .975;
          }
          const tmp = prev; prev = cur; cur = tmp;
        }
      }
      // shade: turquoise water, brighter where a wave leans toward the light, plus slowly moving caustics on the bottom
      const d = img.data;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const i = y * gw + x, sx = x > 0 && x < gw - 1 ? prev[i - 1] - prev[i + 1] : 0, sy = y > 0 && y < gh - 1 ? prev[i - gw] - prev[i + gw] : 0;
        // caustics: three wavy sines crossing; where they nearly cancel there's a thin bright line, like light on a pool floor
        const wx = x + Math.sin(y * .11 + s * .5) * 3, wy = y + Math.sin(x * .09 - s * .4) * 3;
        const sum = Math.sin(wx * .23 + s * .8) + Math.sin(wy * .27 - s * .7) + Math.sin((wx + wy) * .17 + s * .5);
        const cau = Math.pow(Math.max(0, 1 - Math.abs(sum) / 1.4), 5);
        const light = Math.max(-28, Math.min(46, (sx + sy) * .35)) + cau * 34;
        const depth = y / gh;
        d[i * 4] = Math.min(255, 196 - depth * 40 + light * .6);
        d[i * 4 + 1] = Math.min(255, 236 - depth * 22 + light * .8);
        d[i * 4 + 2] = Math.min(255, 240 - depth * 10 + light * .7);
        d[i * 4 + 3] = 255;
      }
      offCtx.putImageData(img, 0, 0);
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = A; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, 0, 0, W, H); ctx.globalAlpha = 1;
    }

    function draw(t, o = {}) {
      if (canvas.clientWidth * DPR !== W && canvas.clientWidth) resize();
      const A = o.alpha == null ? 1 : o.alpha;
      ctx.clearRect(0, 0, W, H);
      if (kind === "aurora") drawAurora(t, A); else drawLagoon(t, A);
    }
    // a click: a big ring wave in the lagoon, a bright flare in the aurora
    function click(cx, cy) {
      pointer(cx, cy);
      if (kind === "lagoon") drop(ptr.x, ptr.y, 900, 4);
      else for (const c of curtains) c.ph += .6;
    }
    resize();
    return { draw, resize, pointer, click };
  };
})();
