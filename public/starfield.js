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
      if (o.palette === "gold") return drawSparks(t, dt, A, o.dark !== false, still);
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
    // ---- gold sparks (Max thinking): fine golden sparks that rise slowly from the bottom, sway, flicker and fade; the pointer
    // nudges the ones near it aside ----
    const GOLD = [[255, 214, 120], [255, 190, 80], [255, 232, 170], [245, 170, 60], [255, 204, 102]];
    const GOLD_INK = [[196, 132, 18], [176, 110, 10], [214, 152, 40], [160, 96, 8], [205, 140, 28]];
    let sparks = [];
    const goldSprites = {};
    const goldSprite = (rgb) => { const k = rgb.join(); if (goldSprites[k]) return goldSprites[k]; const c = document.createElement("canvas"); c.width = c.height = 48; const x = c.getContext("2d"), g = x.createRadialGradient(24, 24, 0, 24, 24, 24); g.addColorStop(0, `rgba(${k},.9)`); g.addColorStop(.25, `rgba(${k},.35)`); g.addColorStop(1, `rgba(${k},0)`); x.fillStyle = g; x.fillRect(0, 0, 48, 48); return (goldSprites[k] = c); };
    function spark(anywhere) {
      return { x: Math.random() * W, y: anywhere ? Math.random() * H : H + Math.random() * 60 * DPR, vy: (10 + Math.random() * 34) * DPR, vx: (Math.random() - .5) * 6 * DPR,
        sw: (6 + Math.random() * 18) * DPR, f: .3 + Math.random() * 1.2, p: Math.random() * 6.28, r: (.5 + Math.random() ** 2 * 1.9) * DPR, c: (Math.random() * GOLD.length) | 0,
        life: anywhere ? Math.random() * 6 : 0, max: 7 + Math.random() * 10, fl: 2 + Math.random() * 6 };
    }
    function drawSparks(t, dt, A, dark, still) {
      ctx.clearRect(0, 0, W, H);
      const want = Math.round(Math.min(260, Math.max(60, W * H / (6500 * DPR * DPR))));
      if (sparks.length > want) sparks.length = want;
      while (sparks.length < want) sparks.push(spark(true));
      const pal = dark ? GOLD : GOLD_INK, R = 110 * DPR;
      ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
      for (let i = 0; i < sparks.length; i++) {
        let s = sparks[i];
        if (!still) {
          s.life += dt; s.y -= s.vy * dt; s.x += (s.vx + Math.sin(t / 1000 * s.f + s.p) * s.sw) * dt;
          if (ptr.on) { const dx = s.x - ptr.x, dy = s.y - ptr.y, d = Math.hypot(dx, dy); if (d < R && d > .1) { const q = (1 - d / R) ** 2; s.x += dx / d * q * 90 * DPR * dt; s.y += dy / d * q * 90 * DPR * dt; } }
          if (s.y < -20 * DPR || s.life > s.max || s.x < -40 || s.x > W + 40) s = sparks[i] = spark(false);
        }
        const fade = Math.max(0, Math.min(1, s.life / 1.4, (s.max - s.life) / 2.2)) * (still ? 1 : .65 + .35 * Math.sin(t / 1000 * s.fl + s.p));
        const a = fade * A * (dark ? 1 : .75), rgb = pal[s.c];
        if (s.r > 1.1 * DPR) { const gs = s.r * 7; ctx.globalAlpha = a * .55; ctx.drawImage(goldSprite(rgb), s.x - gs, s.y - gs, gs * 2, gs * 2); }
        ctx.globalAlpha = a; ctx.fillStyle = `rgb(${rgb.join()})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    }
    // nebula(): one comes now, right where the sky is looking (for trying it out)
    const nebula = () => { neb = newNebula(null); neb.x = -Math.sin(cam.yaw); neb.z = Math.cos(cam.yaw); neb.y = .08; };
    return { draw, resize, pointer, cam, nebula };
  };

  // ---------- the light theme's shapes: soft rounded shapes that fall, stack, tumble and can be picked up and thrown ----------
  //   const field = createPolygonField(container);  field.setEnabled(true | false)
  // A small rigid-body engine: each shape is a convex polygon (its rounded corners included, so what you see is what collides),
  // with mass, rotation, friction and a little bounce. Contacts are found with separating axes and resolved with impulses,
  // several times per frame. You hold a shape at the point you grabbed it (a soft spring), so it swings, pushes the others
  // and keeps its speed when you let go. On phones and tablets gravity follows how the device is tilted.
  window.createPolygonField = function (container) {
    if (!container) return null;
    const SVG = "http://www.w3.org/2000/svg";
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = matchMedia("(pointer: coarse)").matches;
    const G = 2300, STEP = 1 / 120, ITER = 10, SLOP = .6, BETA = .22, FRICTION = .45, BOUNCE = .22, FLOOR_GAP = 6;
    // [corners (0 = circle, -1 = pill), corner rounding]
    const KINDS = [[3, .24], [4, .2], [0, 0], [5, .2], [6, .16], [-1, 0], [4, .2], [3, .24], [0, 0]];
    const PAINT = [["#EEF3FB", "#D9E3F2"], ["#E6F0FF", "#C7DBFF"], ["#EFEBFF", "#D8CFFF"], ["#E4F6EE", "#C5EAD8"], ["#FFF1E6", "#FFD9C0"], ["#F4F4F7", "#E0E2E8"], ["#E9F4FF", "#CFE6FF"]];
    let bodies = [], enabled = false, raf = 0, last = 0, acc = 0, calm = 0, W = 0, H = 0;
    let drag = null, hover = null, uid = 0;
    const grav = { x: 0, y: 1, tx: 0, ty: 1 };

    // ---- shapes ----
    function rounded(pts, r, seg) {
      if (r <= 0) return pts.slice();
      const out = [], n = pts.length;
      for (let i = 0; i < n; i++) {
        const [px, py] = pts[(i + n - 1) % n], [vx, vy] = pts[i], [qx, qy] = pts[(i + 1) % n];
        let ax = px - vx, ay = py - vy, bx = qx - vx, by = qy - vy;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by); ax /= la; ay /= la; bx /= lb; by /= lb;
        const th = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by))), rr = Math.min(r, Math.tan(th / 2) * Math.min(la, lb) / 2);
        let hx = ax + bx, hy = ay + by; const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
        const cd = rr / Math.sin(th / 2), cx = vx + hx * cd, cy = vy + hy * cd, d = rr / Math.tan(th / 2);
        const a1 = Math.atan2(vy + ay * d - cy, vx + ax * d - cx); let da = Math.atan2(vy + by * d - cy, vx + bx * d - cx) - a1;
        while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        for (let s = 0; s <= seg; s++) out.push([cx + rr * Math.cos(a1 + da * s / seg), cy + rr * Math.sin(a1 + da * s / seg)]);
      }
      return out.filter((p, i, a) => { const q = a[(i + 1) % a.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > .4; });
    }
    function outline(kind, size) {
      const [n, round] = kind, R = size / 2;
      if (n === 0) return { phys: Array.from({ length: 18 }, (_, i) => [R * Math.cos(i / 18 * 6.2832), R * Math.sin(i / 18 * 6.2832)]), circle: R };
      if (n === -1) { const w = size * .62, h = size * .3, rect = [[-w, -h], [w, -h], [w, h], [-w, h]]; return { phys: rounded(rect, h, 4), draw: rounded(rect, h, 10) }; }
      const off = -Math.PI / 2 + (n === 4 ? Math.PI / 4 : 0), pts = Array.from({ length: n }, (_, i) => [R * Math.cos(off + i / n * 6.2832), R * Math.sin(off + i / n * 6.2832)]);
      return { phys: rounded(pts, R * round, 3), draw: rounded(pts, R * round, 8) };
    }
    function massProps(pts) {
      let A = 0, cx = 0, cy = 0, I = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length], c = x1 * y2 - x2 * y1;
        A += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c; I += c * (x1 * x1 + x1 * x2 + x2 * x2 + y1 * y1 + y1 * y2 + y2 * y2);
      }
      A /= 2; cx /= 6 * A; cy /= 6 * A; I = Math.abs(I / 12) - Math.abs(A) * (cx * cx + cy * cy);
      return { area: Math.abs(A), cx, cy, I };
    }
    function makeBody(i, size) {
      const kind = KINDS[i % KINDS.length], o = outline(kind, size), m = massProps(o.phys);
      let phys = o.phys.map(([x, y]) => [x - m.cx, y - m.cy]);
      // the edges go round so that (ey, -ex) points outwards
      { const [a, b] = phys; if ((b[1] - a[1]) * ((a[0] + b[0]) / 2) - (b[0] - a[0]) * ((a[1] + b[1]) / 2) < 0) phys.reverse(); }
      const n = phys.length, lv = new Float64Array(n * 2), ln = new Float64Array(n * 2);
      let R = 0;
      for (let k = 0; k < n; k++) {
        const [x, y] = phys[k], [x2, y2] = phys[(k + 1) % n], l = Math.hypot(x2 - x, y2 - y);
        lv[k * 2] = x; lv[k * 2 + 1] = y; ln[k * 2] = (y2 - y) / l; ln[k * 2 + 1] = -(x2 - x) / l; R = Math.max(R, Math.hypot(x, y));
      }
      const density = .001, mass = m.area * density, inertia = m.I * density;
      const b = { n, lv, ln, wv: new Float64Array(n * 2), wn: new Float64Array(n * 2), R, invM: 1 / mass, invI: 1 / inertia, mass,
        x: 0, y: 0, a: Math.random() * 6.28, vx: 0, vy: 0, w: 0, inside: false, el: null };
      // the picture: an svg the size of the bounding circle, turned and moved with a transform
      const S = Math.ceil(R + 2), el = document.createElement("i"), id = "pf" + (++uid), [c1, c2] = PAINT[(i * 3 + 1) % PAINT.length];
      el.dataset.index = String(i); el.style.width = el.style.height = S * 2 + "px"; el.style.transformOrigin = `${S}px ${S}px`;
      const d = o.circle ? `M${-m.cx - o.circle} ${-m.cy}a${o.circle} ${o.circle} 0 1 0 ${o.circle * 2} 0a${o.circle} ${o.circle} 0 1 0 ${-o.circle * 2} 0Z`
        : "M" + o.draw.map(([x, y]) => (x - m.cx).toFixed(1) + " " + (y - m.cy).toFixed(1)).join("L") + "Z";
      el.innerHTML = `<svg viewBox="${-S} ${-S} ${S * 2} ${S * 2}" width="${S * 2}" height="${S * 2}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><path d="${d}" fill="url(#${id})"/><path class="rim" d="${d}"/></svg>`;
      b.el = el; b.S = S;
      return b;
    }
    function toWorld(b) {
      const c = Math.cos(b.a), s = Math.sin(b.a);
      for (let k = 0; k < b.n * 2; k += 2) {
        const x = b.lv[k], y = b.lv[k + 1], nx = b.ln[k], ny = b.ln[k + 1];
        b.wv[k] = b.x + c * x - s * y; b.wv[k + 1] = b.y + s * x + c * y;
        b.wn[k] = c * nx - s * ny; b.wn[k + 1] = s * nx + c * ny;
      }
    }

    // ---- contacts ----
    function maxSep(A, B) {
      let best = -Infinity, edge = 0;
      for (let i = 0; i < A.n * 2; i += 2) {
        const nx = A.wn[i], ny = A.wn[i + 1], vx = A.wv[i], vy = A.wv[i + 1];
        let s = Infinity;
        for (let j = 0; j < B.n * 2; j += 2) { const d = nx * (B.wv[j] - vx) + ny * (B.wv[j + 1] - vy); if (d < s) s = d; }
        if (s > best) { best = s; edge = i; }
      }
      return [best, edge];
    }
    // up to two contact points between two shapes, the normal pointing from A to B
    function collide(A, B, out) {
      const [sa, ea] = maxSep(A, B); if (sa > SLOP) return;
      const [sb, eb] = maxSep(B, A); if (sb > SLOP) return;
      let ref = A, inc = B, e = ea, flip = false;
      if (sb > sa + .1) { ref = B; inc = A; e = eb; flip = true; }
      const nx = ref.wn[e], ny = ref.wn[e + 1], e2 = (e + 2) % (ref.n * 2);
      const v1x = ref.wv[e], v1y = ref.wv[e + 1], v2x = ref.wv[e2], v2y = ref.wv[e2 + 1];
      let ie = 0, md = Infinity;
      for (let i = 0; i < inc.n * 2; i += 2) { const d = nx * inc.wn[i] + ny * inc.wn[i + 1]; if (d < md) { md = d; ie = i; } }
      const ie2 = (ie + 2) % (inc.n * 2);
      let p = [[inc.wv[ie], inc.wv[ie + 1]], [inc.wv[ie2], inc.wv[ie2 + 1]]];
      const tx = v2x - v1x, ty = v2y - v1y, tl = Math.hypot(tx, ty), ux = tx / tl, uy = ty / tl;
      const clip = (pts, ox, oy, off) => {
        const d0 = ox * pts[0][0] + oy * pts[0][1] - off, d1 = ox * pts[1][0] + oy * pts[1][1] - off, r = [];
        if (d0 >= 0) r.push(pts[0]); if (d1 >= 0) r.push(pts[1]);
        if (d0 * d1 < 0) { const t = d0 / (d0 - d1); r.push([pts[0][0] + t * (pts[1][0] - pts[0][0]), pts[0][1] + t * (pts[1][1] - pts[0][1])]); }
        return r;
      };
      p = clip(p, ux, uy, ux * v1x + uy * v1y); if (p.length < 2) return;
      p = clip(p, -ux, -uy, -(ux * v2x + uy * v2y)); if (p.length < 2) return;
      for (const [x, y] of p) {
        const sep = nx * (x - v1x) + ny * (y - v1y);
        if (sep <= SLOP) out.push({ A, B, nx: flip ? -nx : nx, ny: flip ? -ny : ny, x, y, depth: -sep, jn: 0, jt: 0 });
      }
    }
    const WALL = { invM: 0, invI: 0, vx: 0, vy: 0, w: 0, x: 0, y: 0 };
    // the screen's edges: the floor and the sides always, the top once a shape has fallen in
    function walls(b, out) {
      const lim = [[0, 1, -(H - FLOOR_GAP)], [-1, 0, 0], [1, 0, -W]];
      if (b.inside) lim.push([0, -1, 0]); else if (b.y - b.R > 0) b.inside = true;
      for (const [nx, ny, off] of lim) {              // the wall is where nx*x + ny*y + off = 0, the body stays where it's < 0
        if (nx * b.x + ny * b.y + off < -b.R - SLOP) continue;
        let n = 0;
        for (let k = 0; k < b.n * 2; k += 2) {
          const d = nx * b.wv[k] + ny * b.wv[k + 1] + off;
          if (d > -SLOP) { out.push({ A: b, B: WALL, nx, ny, x: b.wv[k], y: b.wv[k + 1], depth: d, jn: 0, jt: 0 }); if (++n > 3) break; }
        }
      }
    }

    // ---- one step of the world ----
    function step(dt) {
      for (const b of bodies) {
        if (b === drag?.b) { b.vx += grav.x * G * dt * .4; b.vy += grav.y * G * dt * .4; }
        else { b.vx += grav.x * G * dt; b.vy += grav.y * G * dt; }
        const lin = Math.max(0, 1 - .12 * dt), ang = Math.max(0, 1 - .9 * dt);
        b.vx *= lin; b.vy *= lin; b.w *= ang;
        toWorld(b);
      }
      const cs = [];
      for (let i = 0; i < bodies.length; i++) {
        const A = bodies[i]; walls(A, cs);
        for (let j = i + 1; j < bodies.length; j++) {
          const B = bodies[j], dx = B.x - A.x, dy = B.y - A.y, r = A.R + B.R + SLOP;
          if (dx * dx + dy * dy < r * r) collide(A, B, cs);
        }
      }
      for (const c of cs) {
        const { A, B, nx, ny } = c;
        c.rax = c.x - A.x; c.ray = c.y - A.y; c.rbx = c.x - B.x; c.rby = c.y - B.y;
        const rnA = c.rax * ny - c.ray * nx, rnB = c.rbx * ny - c.rby * nx;
        c.mn = 1 / (A.invM + B.invM + A.invI * rnA * rnA + B.invI * rnB * rnB);
        const tx = -ny, ty = nx, rtA = c.rax * ty - c.ray * tx, rtB = c.rbx * ty - c.rby * tx;
        c.mt = 1 / (A.invM + B.invM + A.invI * rtA * rtA + B.invI * rtB * rtB);
        const vn = relV(c, nx, ny);
        c.bias = Math.max(vn < -90 ? -BOUNCE * vn : 0, BETA / dt * Math.max(0, c.depth - SLOP));
      }
      // the shape in your hand follows the pointer like on a soft spring, at the point where you picked it up
      let joint = null;
      if (drag) {
        const b = drag.b, c = Math.cos(b.a), s = Math.sin(b.a), rx = c * drag.lx - s * drag.ly, ry = s * drag.lx + c * drag.ly;
        const om = 2 * Math.PI * 6, k = b.mass * om * om, damp = 2 * b.mass * .75 * om, gam = 1 / (dt * (damp + dt * k)), beta = dt * k * gam;
        const k11 = b.invM + b.invI * ry * ry + gam, k12 = -b.invI * rx * ry, k22 = b.invM + b.invI * rx * rx + gam, det = 1 / (k11 * k22 - k12 * k12);
        joint = { b, rx, ry, m11: k22 * det, m12: -k12 * det, m22: k11 * det, cx: (b.x + rx - drag.tx) * beta, cy: (b.y + ry - drag.ty) * beta, max: b.mass * G * 40 * dt };
        b.w *= .98;
      }
      for (let it = 0; it < ITER; it++) {
        if (joint) {
          const { b, rx, ry } = joint, vx = b.vx - b.w * ry + joint.cx, vy = b.vy + b.w * rx + joint.cy;
          let ix = -(joint.m11 * vx + joint.m12 * vy), iy = -(joint.m12 * vx + joint.m22 * vy);
          const l = Math.hypot(ix, iy); if (l > joint.max) { ix *= joint.max / l; iy *= joint.max / l; }
          b.vx += b.invM * ix; b.vy += b.invM * iy; b.w += b.invI * (rx * iy - ry * ix);
        }
        for (const c of cs) {
          const { A, B, nx, ny } = c;
          let j = c.mn * (c.bias - relV(c, nx, ny));
          const jn = Math.max(0, c.jn + j); j = jn - c.jn; c.jn = jn;
          push(c, nx * j, ny * j);
          const tx = -ny, ty = nx, lim = FRICTION * c.jn;
          let f = -c.mt * relV(c, tx, ty);
          const jt = Math.max(-lim, Math.min(lim, c.jt + f)); f = jt - c.jt; c.jt = jt;
          push(c, tx * f, ty * f);
        }
      }
      let energy = 0;
      for (const b of bodies) {
        b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.w * dt;
        energy = Math.max(energy, Math.hypot(b.vx, b.vy) + Math.abs(b.w) * b.R);
        // a shape that left the screen sideways (thrown hard) comes back in
        if (b.x < -b.R * 3 || b.x > W + b.R * 3 || b.y > H + b.R * 3 || b.y < -H * 3) { b.x = Math.min(W - b.R, Math.max(b.R, b.x)); b.y = -b.R * 2; b.vx = b.vy = b.w = 0; b.inside = false; }
      }
      return energy;
    }
    function relV(c, tx, ty) {
      const { A, B } = c;
      const vax = A.vx - A.w * c.ray, vay = A.vy + A.w * c.rax, vbx = B.vx - B.w * c.rby, vby = B.vy + B.w * c.rbx;
      return (vbx - vax) * tx + (vby - vay) * ty;
    }
    function push(c, px, py) {
      const { A, B } = c;
      A.vx -= A.invM * px; A.vy -= A.invM * py; A.w -= A.invI * (c.rax * py - c.ray * px);
      B.vx += B.invM * px; B.vy += B.invM * py; B.w += B.invI * (c.rbx * py - c.rby * px);
    }

    // ---- showing them ----
    function draw() {
      for (const b of bodies) {
        b.el.style.transform = `translate3d(${(b.x - b.S).toFixed(1)}px,${(b.y - b.S).toFixed(1)}px,0) rotate(${b.a.toFixed(3)}rad)`;
        // the shadow of a lifted shape falls downwards on the screen, whichever way the shape is turned
        if (b === hover || (drag && b === drag.b)) { const lift = drag && b === drag.b ? 16 : 7, c = Math.cos(b.a), s = Math.sin(b.a); b.el.style.setProperty("--sx", (s * lift).toFixed(1) + "px"); b.el.style.setProperty("--sy", (c * lift).toFixed(1) + "px"); }
      }
    }
    function tick(now) {
      raf = 0;
      if (!enabled || document.hidden) { last = 0; return; }
      const dt = last ? Math.min(.05, (now - last) / 1000) : STEP; last = now;
      grav.x += (grav.tx - grav.x) * Math.min(1, dt * 7); grav.y += (grav.ty - grav.y) * Math.min(1, dt * 7);
      acc += dt; let e = 0;
      while (acc >= STEP) { e = Math.max(e, step(STEP)); acc -= STEP; }
      draw();
      // everything lies still: stop until something moves it again
      calm = e < 9 && !drag ? calm + dt : 0;
      if (calm < .8) schedule(); else { last = 0; for (const b of bodies) b.vx = b.vy = b.w = 0; }
    }
    function schedule() { if (enabled && !raf) raf = requestAnimationFrame(tick); }
    const wake = () => { calm = 0; schedule(); };

    function seed() {
      W = Math.max(1, container.clientWidth); H = Math.max(1, container.clientHeight);
      const count = Math.round(Math.min(22, Math.max(8, W * H / 56000)));
      const base = Math.min(118, Math.max(50, Math.sqrt(W * H) / 11));
      bodies = Array.from({ length: count }, (_, i) => makeBody(i, base * (.62 + Math.random() * .5)));
      bodies.forEach((b, i) => { b.x = b.R + Math.random() * Math.max(1, W - 2 * b.R); b.y = -b.R - i * (H / count) * .7 - Math.random() * 80; b.w = (Math.random() - .5) * 3; b.vx = (Math.random() - .5) * 120; });
      container.replaceChildren(...bodies.map(b => b.el));
      if (reduced) { for (let i = 0; i < 1400; i++) step(STEP); for (const b of bodies) b.vx = b.vy = b.w = 0; }
      draw(); calm = 0; acc = 0;
    }
    function fit() {
      const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
      if (Math.abs(w - W) < 2 && Math.abs(h - H) < 2) return;
      W = w; H = h;
      for (const b of bodies) if (b.inside) { b.x = Math.min(W - b.R, Math.max(b.R, b.x)); b.y = Math.min(H - FLOOR_GAP - b.R, b.y); }
      wake();
    }

    // ---- hands ----
    function bodyAt(x, y) {
      for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i], dx = x - b.x, dy = y - b.y; if (dx * dx + dy * dy > b.R * b.R) continue;
        toWorld(b); let inside = true;
        for (let k = 0; k < b.n * 2 && inside; k += 2) if (b.wn[k] * (x - b.wv[k]) + b.wn[k + 1] * (y - b.wv[k + 1]) > 2) inside = false;
        if (inside) return b;
      }
      return null;
    }
    // shapes sit behind the page, so a press counts only on empty background, never on text, a card, a field or a button
    const BLOCK = "button, a, input, textarea, select, label, summary, video, canvas:not(#sky), iframe, img, p, h1, h2, h3, h4, li, pre, code, [contenteditable], [role], [data-go], [data-action], dialog[open], aside, .topbar, .box, .home-card, .home-action, .home-feature, .manual-section, .home-whatsapp, .msg, .md, .notes-grid, .lp-step";
    const local = (e) => { const r = container.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function down(e) {
      if (!enabled || (e.button != null && e.button !== 0)) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && !t.closest("#orbs") && t.closest(BLOCK)) return;
      const [x, y] = local(e), b = bodyAt(x, y);
      if (!b) return;
      e.preventDefault();
      const c = Math.cos(-b.a), s = Math.sin(-b.a), dx = x - b.x, dy = y - b.y;
      drag = { b, lx: c * dx - s * dy, ly: s * dx + c * dy, tx: x, ty: y, id: e.pointerId };
      bodies.splice(bodies.indexOf(b), 1); bodies.push(b); container.appendChild(b.el);   // on top while held
      b.el.classList.add("dragging"); document.documentElement.classList.add("pf-grabbing");
      setHover(null); wake();
    }
    function move(e) {
      if (!enabled) return;
      if (drag) { if (e.pointerId !== drag.id) return; [drag.tx, drag.ty] = local(e); wake(); return; }
      if (e.pointerType !== "mouse") return;
      const t = e.target instanceof Element ? e.target : null;
      setHover(t && !t.closest("#orbs") && t.closest(BLOCK) ? null : bodyAt(...local(e)));
    }
    function setHover(b) {
      if (hover === b) return;
      if (hover) hover.el.classList.remove("hover");
      hover = b; if (b) b.el.classList.add("hover");
      document.documentElement.classList.toggle("pf-hover", !!b);
    }
    function up(e) {
      if (!drag || (e && e.pointerId != null && e.pointerId !== drag.id)) return;
      drag.b.el.classList.remove("dragging"); document.documentElement.classList.remove("pf-grabbing");
      const b = drag.b, sp = Math.hypot(b.vx, b.vy), max = 4200;
      if (sp > max) { b.vx *= max / sp; b.vy *= max / sp; }
      drag = null; wake();
    }

    // ---- tilt (phones and tablets): gravity points to wherever "down" is ----
    let tiltOn = false;
    // Where "down" is on the page, from the device's tilt. beta and gamma are measured against the upright device (its portrait
    // body), whichever way the page is turned. angle: how far the page is turned (0 upright, 90 turned counter-clockwise, ...),
    // landscape: the window is wider than tall. Returns [x, y] with y > 0 meaning towards the bottom of the screen.
    function tiltGravity(beta, gamma, angle, landscape) {
      const b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
      const x = Math.sin(g) * Math.cos(b), y = Math.sin(b);            // down, on the screen as it is built into the device
      const turn = (a) => { const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [c * x + s * y, -s * x + c * y]; };
      const a = ((Math.round(Number(angle) / 90) * 90) % 360 + 360) % 360;
      // A window taller than wide is turned by 0 or 180, a wider one by 90 or 270. Some browsers (iPhone, iPad, tablets) report the
      // angle against the other axis, which puts everything a quarter turn off, with the shapes piled on one side. Then take the two
      // turns that fit the window and use the one that makes things fall towards the bottom (flat on a table: the nearer one).
      if ((a % 180 === 90) !== !!landscape) {
        const v1 = turn((a + 90) % 360), v2 = turn((a + 270) % 360);
        return Math.abs(v1[1] - v2[1]) > .05 ? (v1[1] > v2[1] ? v1 : v2) : v2;
      }
      return turn(a);
    }
    // iPhone and iPad know window.orientation best (0 upright, 90 / -90 sideways); elsewhere screen.orientation.angle
    const pageAngle = () => (typeof window.orientation === "number" ? window.orientation : screen.orientation && typeof screen.orientation.angle === "number" ? screen.orientation.angle : 0);
    let tiltDbg = null;
    function onTilt(e) {
      if (e.beta == null || e.gamma == null) return;
      const ang = pageAngle(), [nx, ny] = tiltGravity(e.beta, e.gamma, ang, innerWidth > innerHeight);
      if (tiltDbg) tiltDbg.textContent = `beta ${e.beta.toFixed(0)}  gamma ${e.gamma.toFixed(0)}  angle ${ang}  ${innerWidth}x${innerHeight}\ngravity x ${nx.toFixed(2)}  y ${ny.toFixed(2)}`;
      if (Math.abs(nx - grav.tx) + Math.abs(ny - grav.ty) > .04) { grav.tx = nx; grav.ty = ny; if (enabled) wake(); }
    }
    // open the page with ?tilt to see the raw numbers on screen (for checking a device)
    if (/[?&]tilt\b/.test(location.search)) {
      tiltDbg = document.createElement("pre");
      tiltDbg.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:999;margin:0;padding:6px 8px;border-radius:8px;font:11px/1.4 monospace;background:rgba(0,0,0,.7);color:#fff;pointer-events:none;white-space:pre";
      tiltDbg.textContent = "tilt: waiting for the first reading (tap the page once on iPhone)";
      document.body.appendChild(tiltDbg);
    }
    function startTilt() {
      if (tiltOn || !coarse || !("DeviceOrientationEvent" in window)) return;
      const go = () => { if (tiltOn) return; tiltOn = true; addEventListener("deviceorientation", onTilt); };
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        // iPhone and iPad ask first, and only after a tap
        const ask = () => { removeEventListener("touchend", ask); removeEventListener("click", ask); DeviceOrientationEvent.requestPermission().then((r) => { if (r === "granted") go(); }).catch(() => {}); };
        addEventListener("touchend", ask, { once: true }); addEventListener("click", ask, { once: true });
      } else go();
    }

    const setEnabled = (on) => {
      if (enabled === on) return;
      enabled = on;
      container.classList.toggle("active", enabled);
      if (!enabled) { if (raf) cancelAnimationFrame(raf); raf = 0; drag = null; last = 0; setHover(null); return; }
      if (!bodies.length || !container.children.length) seed(); else fit();
      startTilt(); wake();
    };
    addEventListener("pointerdown", down);
    addEventListener("touchstart", (e) => {
      if (!enabled || e.touches.length !== 1) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && !t.closest("#orbs") && t.closest(BLOCK)) return;
      const r = container.getBoundingClientRect();
      if (bodyAt(e.touches[0].clientX - r.left, e.touches[0].clientY - r.top)) e.preventDefault();
    }, { passive: false });
    addEventListener("pointermove", move, { passive: true });
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    addEventListener("blur", () => up());
    addEventListener("resize", () => { if (enabled) fit(); });
    document.addEventListener("visibilitychange", () => { if (enabled && !document.hidden) { last = 0; wake(); } });
    return { setEnabled, reseed: () => { if (enabled) { seed(); wake(); } },
      // run the world forward right away (tests: headless browsers give hardly any animation frames)
      advance: (secs) => { for (let i = 0; i < secs / STEP; i++) step(STEP); draw(); }, gravity: (x, y) => { grav.tx = x; grav.ty = y; wake(); }, tilt: tiltGravity, bodies: () => bodies };
  };
})();
