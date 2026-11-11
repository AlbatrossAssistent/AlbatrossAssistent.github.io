// A 360° night sky, drawn as circles: stars sit all around you on a sphere at different depths, the sky turns slowly like the
// End portal's, looking around (the mouse) shifts near stars more than far ones, and stars close to the pointer are pushed
// away a little, glow, and join up with faint lines. A few shooting stars now and then.
//   const sky = createStarfield(canvas, { count: 900 });
//   each frame: sky.draw(t, { scroll: 0..1, palette: "night" | "day" | "ember", alpha: 1, flow: 0 });
//   night: the dark theme's stars; day: the light theme's soft blue, violet and amber lights; ember: red and orange embers (Max thinking)
//   pointer:   sky.pointer(clientX, clientY)   (and sky.pointer(null) when it leaves)
(function () {
  const TINTS = Array.from({ length: 6 }, () => [255, 255, 255]);
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

    // ---- a nebula now and then (night sky only): a soft cloud of coloured gas somewhere on the sky sphere, so it turns with
    // the stars; it fades in over a few seconds, stays about a minute, fades out, and the next one comes a few minutes later,
    // each time with a new shape and colours ----
    const NEB_COLORS = [[[170, 90, 255], [255, 110, 190], [90, 140, 255]], [[60, 160, 255], [70, 230, 210], [140, 110, 255]], [[255, 120, 60], [255, 70, 110], [255, 190, 120]]];
    // times are on the clock draw() gets (the frame time), set from the first frame that sees them
    let neb = null, nebNext = null;
    function nebulaTexture() {
      const S = 512, c = document.createElement("canvas"); c.width = c.height = S;
      const x = c.getContext("2d"), cols = NEB_COLORS[(Math.random() * NEB_COLORS.length) | 0];
      x.globalCompositeOperation = "lighter";
      // big soft lobes along a wavy arm, then smaller knots: a cloud, not a circle
      const arm = Math.random() * 6.28, bend = (Math.random() - .5) * 1.6;
      for (let i = 0; i < 26; i++) {
        const f = i / 25 - .5, a = arm + bend * f, d = f * S * .62;
        const cx = S / 2 + Math.cos(a) * d + (Math.random() - .5) * 70, cy = S / 2 + Math.sin(a) * d * .7 + (Math.random() - .5) * 70;
        const r = (60 + Math.random() * 110) * (1 - Math.abs(f) * .9), [cr, cg, cb] = cols[i % 3];
        const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${.18 + Math.random() * .12})`); g.addColorStop(.5, `rgba(${cr},${cg},${cb},.06)`); g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        x.fillStyle = g; x.fillRect(0, 0, S, S);
      }
      // dust: many tiny darker specks over it, so it looks grainy and far away
      x.globalCompositeOperation = "destination-out";
      x.filter = "blur(1.5px)";                                        // a fine soft grain, not round holes
      for (let i = 0; i < 2600; i++) { x.fillStyle = `rgba(0,0,0,${Math.random() * .12})`; const r = Math.random() * 1.8 + .4; x.beginPath(); x.arc(Math.random() * S, Math.random() * S, r, 0, 6.2832); x.fill(); }
      x.filter = "none";
      // a soft edge so no corner of the picture ever shows
      x.globalCompositeOperation = "destination-in";
      const edge = x.createRadialGradient(S / 2, S / 2, S * .2, S / 2, S / 2, S * .5); edge.addColorStop(0, "#000"); edge.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = edge; x.fillRect(0, 0, S, S);
      return c;
    }
    function newNebula(now) {
      const u = (Math.random() * 2 - 1) * .55, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      return { x: r * Math.cos(th), y: u, z: r * Math.sin(th), tex: nebulaTexture(), size: .9 + Math.random() * .7, rot: Math.random() * 6.28, born: now, life: 50000 + Math.random() * 40000 };
    }
    function drawNebula(now, A, rot) {
      if (nebNext == null) nebNext = now + 25000 + Math.random() * 35000;
      if (!neb && now > nebNext) neb = newNebula(now);
      if (neb && neb.born == null) neb.born = now;
      if (!neb) return;
      // a frame's time can be a moment before the nebula was made: that counts as age 0, not as faded out
      const age = Math.max(0, now - neb.born), fade = Math.max(0, Math.min(1, age / 7000, (neb.life - age) / 9000));
      if (age >= neb.life) { neb = null; nebNext = now + 70000 + Math.random() * 110000; return; }
      const [cy, sy, cp, sp, f] = rot;
      const x1 = neb.x * cy + neb.z * sy, z1 = -neb.x * sy + neb.z * cy, y1 = neb.y * cp - z1 * sp, z2 = neb.y * sp + z1 * cp;
      if (z2 < .15) return;                                          // behind us right now: it comes round again as the sky turns
      const k = f / z2, px = W / 2 + x1 * k - look.x * 18 * DPR, py = H / 2 + y1 * k - look.y * 18 * DPR, s = Math.min(W, H) * neb.size;
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = fade * .75 * A * Math.min(1, (z2 - .15) / .3);
      ctx.translate(px, py); ctx.rotate(neb.rot); ctx.drawImage(neb.tex, -s / 2, -s / 2, s, s); ctx.restore();
    }

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
      if (name === "night" && !still && opts.nebula !== false) drawNebula(t, A, [cy, sy, cp, sp, f]);   // behind the stars
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
    // nebula(): one comes now, right where the sky is looking (for trying it out)
    const nebula = () => { neb = newNebula(null); neb.x = -Math.sin(cam.yaw); neb.z = Math.cos(cam.yaw); neb.y = .08; };
    return { draw, resize, pointer, cam, nebula };
  };

  window.createPolygonField = function (container) {
    if (!container) return null;
    const cols = 6, rows = 4;
    const tiles = Array.from({ length: cols * rows }, (_, i) => {
      const tile = document.createElement("i");
      tile.dataset.index = String(i);
      return tile;
    });
    container.replaceChildren(...tiles);
    const shapes = tiles.map((el) => ({ el, x: 0, y: 0, vx: 0, vy: 0, angle: Math.random() * 6.28, spin: (Math.random() - .5) * 2, size: 0, grabbed: false }));
    let enabled = false, raf = 0, last = 0, drag = null, hover = null;
    const floorGap = 8;
    const place = (s) => {
      s.el.style.left = `${s.x}px`;
      s.el.style.top = `${s.y}px`;
      s.el.style.setProperty("--angle", `${s.angle}rad`);
    };
    const seed = () => {
      const W = Math.max(1, container.clientWidth), H = Math.max(1, container.clientHeight);
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      for (const [i, s] of shapes.entries()) {
        s.size = Math.min(126, Math.max(54, W / 10)) * (.62 + Math.random() * .38);
        s.x = Math.random() * Math.max(1, W - s.size);
        s.y = reduced ? H - s.size - floorGap : -s.size - Math.random() * (H + s.size);
        s.vx = reduced ? 0 : (Math.random() - .5) * 100;
        s.vy = 0;
        s.grabbed = false;
        s.angle = Math.random() * 6.28;
        s.spin = (Math.random() - .5) * 2.4;
        s.el.style.width = `${s.size}px`;
        s.el.classList.remove("hover", "dragging");
        s.el.dataset.index = String(i);
        place(s);
      }
    };
    const finish = () => { if (!drag) return; drag.shape.grabbed = false; drag.shape.el.classList.remove("dragging"); drag = null; schedule(); };
    const move = (e) => {
      if (!enabled) return;
      if (drag) {
        const now = performance.now(), s = drag.shape, dt = Math.max(.008, Math.min(.08, (now - drag.time) / 1000));
        const x = e.clientX - drag.dx, y = e.clientY - drag.dy;
        s.vx = (x - s.x) / dt;
        s.vy = (y - s.y) / dt;
        s.x = x; s.y = y; drag.time = now;
        place(s); schedule();
        return;
      }
      const b = container.getBoundingClientRect();
      const nearby = shapes.find((s) => e.clientX >= b.left + s.x - 12 && e.clientX <= b.left + s.x + s.size + 12
        && e.clientY >= b.top + s.y - 12 && e.clientY <= b.top + s.y + s.size + 12);
      if (hover !== nearby) {
        if (hover) hover.el.classList.remove("hover");
        hover = nearby;
        if (hover) hover.el.classList.add("hover");
      }
    };
    const down = (e) => {
      if (!enabled || e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && target.closest("button, a, input, textarea, select, label, summary, [contenteditable='true'], [role], [data-go], [data-action], dialog[open]")) return;
      const b = container.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      const tile = target && target.closest("#orbs i");
      const s = (tile && shapes[Number(tile.dataset.index)]) || [...shapes].reverse().find((shape) => x >= shape.x && x <= shape.x + shape.size && y >= shape.y && y <= shape.y + shape.size);
      if (!s) return;
      e.preventDefault();
      if (hover) hover.el.classList.remove("hover");
      hover = null;
      s.grabbed = true;
      s.el.classList.add("dragging");
      drag = { shape: s, dx: x - s.x, dy: y - s.y, time: performance.now() };
      schedule();
    };
    function tick(now) {
      raf = 0;
      if (!enabled || document.hidden) { last = 0; return; }
      const W = Math.max(1, container.clientWidth), H = Math.max(1, container.clientHeight), dt = Math.min(.032, last ? (now - last) / 1000 : .016);
      last = now;
      for (const s of shapes) {
        if (s.grabbed) continue;
        s.vy += 1500 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.angle += s.spin * dt;
        const maxX = Math.max(0, W - s.size), floor = H - s.size - floorGap;
        if (s.x < 0) { s.x = 0; s.vx = Math.abs(s.vx) * .28; }
        if (s.x > maxX) { s.x = maxX; s.vx = -Math.abs(s.vx) * .28; }
        if (s.y > floor) {
          s.y = floor;
          if (s.vy > 90) s.vy = -s.vy * .18; else s.vy = 0;
          s.vx *= .84;
          if (Math.abs(s.vx) < 7) s.vx = 0;
          s.spin *= .82;
          if (Math.abs(s.spin) < .08) s.spin = 0;
        }
      }
      for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i], b = shapes[j];
        if (a.grabbed || b.grabbed) continue;
        const ax = a.x + a.size / 2, ay = a.y + a.size / 2, bx = b.x + b.size / 2, by = b.y + b.size / 2;
        const dx = bx - ax, dy = by - ay, min = (a.size + b.size) * .39, d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || .001, nx = dx / d, ny = dy / d, push = (min - d) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) { a.vx += nx * rel * .42; a.vy += ny * rel * .42; b.vx -= nx * rel * .42; b.vy -= ny * rel * .42; }
      }
      let moving = !!drag;
      for (const s of shapes) {
        const floor = H - s.size - floorGap;
        if (s.y >= floor - .5 && Math.abs(s.vy) < 3 && Math.abs(s.vx) < 3) { s.y = floor; s.vx = s.vy = 0; }
        else moving = true;
        place(s);
      }
      if (moving) schedule(); else last = 0;
    }
    function schedule() { if (enabled && !raf) raf = requestAnimationFrame(tick); }
    const setEnabled = (on) => {
      if (enabled === on) return;
      enabled = on;
      container.classList.toggle("active", enabled);
      if (!enabled) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0; drag = null; last = 0;
        if (hover) hover.el.classList.remove("hover");
        hover = null;
      } else {
        seed();
        schedule();
      }
    };
    addEventListener("pointerdown", down);
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", finish);
    addEventListener("pointercancel", finish);
    addEventListener("resize", () => { if (enabled) { seed(); schedule(); } });
    document.addEventListener("visibilitychange", () => { if (enabled && !document.hidden) { last = 0; schedule(); } });
    return { setEnabled };
  };
})();
