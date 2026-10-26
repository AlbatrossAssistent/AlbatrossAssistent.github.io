// A 360° night sky, drawn as circles: stars sit all around you on a sphere at different depths, the sky turns slowly like the
// End portal's, looking around (the mouse) shifts near stars more than far ones, and stars close to the pointer are pushed
// away a little, glow, and join up with faint lines. A few shooting stars now and then.
//   const sky = createStarfield(canvas, { count: 900 });
//   each frame: sky.draw(t, { scroll: 0..1, palette: "night" | "day" | "ember", alpha: 1, flow: 0 });
//   night: the dark theme's stars; day: the light theme's soft blue, violet and amber lights; ember: red and orange embers (Max thinking)
//   pointer:   sky.pointer(clientX, clientY)   (and sky.pointer(null) when it leaves)
(function () {
  const TINTS = [[255, 255, 255], [205, 225, 255], [170, 212, 255], [160, 255, 232], [255, 240, 214], [208, 190, 255]];
  const TINT_PICK = [0, 0, 0, 1, 1, 2, 2, 3, 4, 5];
  // a star keeps its tint number; each palette says what colour that is, how the lines near the pointer look, and if stars shoot
  const PALETTES = {
    night: { tints: TINTS, line: "#cfe0ff", shoot: "255,255,255", glow: .55 },
    day: { tints: [[0, 122, 255], [0, 122, 255], [88, 86, 214], [90, 200, 250], [255, 149, 0], [175, 82, 222]], line: "#2f6fe0", shoot: "", glow: .75 },
    ember: { tints: [[255, 59, 48], [255, 110, 64], [255, 149, 0], [255, 196, 130], [230, 32, 72], [255, 80, 50]], line: "#ff6a50", shoot: "255,170,110", glow: .7 },
  };

  window.createStarfield = function (canvas, opts = {}) {
    const ctx = canvas.getContext("2d");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const COUNT = opts.count || 900;
    let W = 0, H = 0, DPR = 1, stars = [], shooting = null, last = 0;
    const cam = { yaw: Math.random() * 6.28, pitch: 0 };
    const look = { x: 0, y: 0 };                          // smoothed -1..1 (where the pointer is)
    const ptr = { x: -1e5, y: -1e5, on: false };

    // soft glow sprites, one per tint of each palette (made when a palette is first used)
    const spriteSets = {};
    const spritesOf = (name) => spriteSets[name] || (spriteSets[name] = PALETTES[name].tints.map(([r, g, b]) => {
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const x = c.getContext("2d"), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, `rgba(${r},${g},${b},1)`); gr.addColorStop(.18, `rgba(${r},${g},${b},.55)`); gr.addColorStop(.5, `rgba(${r},${g},${b},.12)`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
      x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return c;
    }));

    function seed() {
      stars = [];
      for (let i = 0; i < COUNT; i++) {
        const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
        stars.push({ x: r * Math.cos(th), y: u, z: r * Math.sin(th), d: .25 + Math.random() * .75, m: Math.random() ** 3.2, t: TINT_PICK[(Math.random() * TINT_PICK.length) | 0], p: Math.random() * 6.28, sp: .5 + Math.random() * 2 });
      }
    }
    function resize() {
      DPR = Math.min(2, devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * DPR)), h = Math.max(1, Math.round(canvas.clientHeight * DPR));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      W = w; H = h;
    }
    seed(); resize();

    function pointer(cx, cy) {
      if (cx == null) { ptr.on = false; return; }
      const b = canvas.getBoundingClientRect();
      ptr.x = (cx - b.left) * (canvas.width / Math.max(1, b.width)); ptr.y = (cy - b.top) * (canvas.height / Math.max(1, b.height)); ptr.on = true;
    }

    function draw(t, o = {}) {
      if (canvas.clientWidth * DPR !== W && canvas.clientWidth) resize();
      const dt = last ? Math.min(.1, (t - last) / 1000) : .016; last = t;
      const name = PALETTES[o.palette] ? o.palette : o.dark === false ? "day" : "night", pal = PALETTES[name], sprites = spritesOf(name);
      const A = o.alpha == null ? 1 : o.alpha, still = reduce && !o.flow;
      // the sky turns slowly; the page scroll tips it up; "flow" streams the stars past (the loading screen)
      if (!still) cam.yaw += dt * (opts.drift == null ? .018 : opts.drift);
      cam.pitch = (o.scroll || 0) * 1.1 + (o.flow ? (cam.flow = (cam.flow || 0) + dt * o.flow) : (cam.flow || 0));
      const tx = ptr.on ? (ptr.x / W) * 2 - 1 : 0, ty = ptr.on ? (ptr.y / H) * 2 - 1 : 0;
      look.x += (tx - look.x) * Math.min(1, dt * 3); look.y += (ty - look.y) * Math.min(1, dt * 3);
      const yaw = cam.yaw + look.x * .22, pitch = cam.pitch + look.y * .14;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const f = Math.min(W, H) * .95, R = 150 * DPR;
      ctx.clearRect(0, 0, W, H);
      const near = [];
      for (const s of stars) {
        const x1 = s.x * cy + s.z * sy, z1 = -s.x * sy + s.z * cy;
        const y1 = s.y * cp - z1 * sp, z2 = s.y * sp + z1 * cp;
        if (z2 < .08) continue;                                   // behind us
        const k = f / z2;
        let px = W / 2 + x1 * k - look.x * s.d * 46 * DPR, py = H / 2 + y1 * k - look.y * s.d * 46 * DPR;
        if (px < -40 || px > W + 40 || py < -40 || py > H + 40) continue;
        let boost = 1, size = (.55 + 1.7 * s.m) * (.75 + .5 * s.d) * DPR;
        if (ptr.on) {
          const dx = px - ptr.x, dy = py - ptr.y, dd = Math.hypot(dx, dy);
          if (dd < R && dd > .01) {
            const q = 1 - dd / R; px += dx / dd * q * q * 30 * DPR; py += dy / dd * q * q * 30 * DPR;
            boost = 1 + q * 1.8; size *= 1 + q * .8;
            if (near.length < 48) near.push(px, py, q);
          }
        }
        const tw = still ? 1 : .68 + .32 * Math.sin(t / 1000 * s.sp + s.p);
        const a = Math.min(1, (.22 + .78 * s.m) * tw * boost) * A * (z2 > .6 ? 1 : z2 / .6 + .25);
        if (s.m > .55 || boost > 1.4) { const gs = size * (5 + 5 * s.m); ctx.globalAlpha = a * pal.glow; ctx.drawImage(sprites[s.t], px - gs, py - gs, gs * 2, gs * 2); }
        ctx.globalAlpha = a; const [r, g, b] = pal.tints[s.t]; ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath(); ctx.arc(px, py, Math.max(.45 * DPR, size), 0, 6.2832); ctx.fill();
      }
      // faint lines between the stars around the pointer
      if (near.length >= 6) {
        ctx.lineWidth = DPR; ctx.strokeStyle = pal.line;
        for (let i = 0; i < near.length; i += 3) for (let j = i + 3; j < near.length; j += 3) {
          const d = Math.hypot(near[i] - near[j], near[i + 1] - near[j + 1]);
          if (d < 90 * DPR) { ctx.globalAlpha = (1 - d / (90 * DPR)) * Math.min(near[i + 2], near[j + 2]) * .5 * A; ctx.beginPath(); ctx.moveTo(near[i], near[i + 1]); ctx.lineTo(near[j], near[j + 1]); ctx.stroke(); }
        }
      }
      // a shooting star now and then
      if (!still && pal.shoot) {
        if (!shooting && Math.random() < .0035) shooting = { x: Math.random() * W * .8, y: Math.random() * H * .45, vx: (7 + Math.random() * 6) * DPR, vy: (2 + Math.random() * 2.5) * DPR, life: 1 };
        if (shooting) {
          const g = ctx.createLinearGradient(shooting.x, shooting.y, shooting.x - shooting.vx * 16, shooting.y - shooting.vy * 16);
          g.addColorStop(0, `rgba(${pal.shoot},${shooting.life * A})`); g.addColorStop(1, `rgba(${pal.shoot},0)`);
          ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = 1.6 * DPR; ctx.beginPath(); ctx.moveTo(shooting.x, shooting.y); ctx.lineTo(shooting.x - shooting.vx * 16, shooting.y - shooting.vy * 16); ctx.stroke();
          shooting.x += shooting.vx; shooting.y += shooting.vy; shooting.life -= .014;
          if (shooting.life <= 0) shooting = null;
        }
      }
      ctx.globalAlpha = 1;
    }
    return { draw, resize, pointer, cam };
  };
})();
