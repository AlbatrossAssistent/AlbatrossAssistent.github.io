// A glowing neural network that turns slowly while a picture is being made: nodes in a 3D ball, each wired to its nearest
// neighbours, with signals running along the wires and lighting up the node they reach (which sometimes passes them on).
// The pointer tilts the ball towards itself, wakes the nodes near it and links to them, dragging spins it, and a click or tap
// fires a wave of signals from the closest node. Plain 2D canvas, so it works without WebGL.
// createNetwork(canvas) draws until the canvas leaves the page (or stop() is called).
(function () {
  window.createNetwork = function (cv) {
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const N = 84, K = 3;
    // nodes: a Fibonacci sphere, jittered, some pulled inwards so it reads as a volume and not a shell
    const nodes = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + .5)) / N, r = Math.sqrt(1 - y * y), th = i * 2.39996323 + Math.random() * .35;
      const d = Math.random() < .22 ? .35 + Math.random() * .4 : .82 + Math.random() * .18;
      nodes.push({ x: Math.cos(th) * r * d, y: y * d, z: Math.sin(th) * r * d, glow: 0, size: .8 + Math.random() * .7, links: [] });
    }
    const edges = [], seen = new Set();
    nodes.forEach((a, i) => {
      nodes.map((b, j) => [j, (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2]).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]).slice(0, K)
        .forEach(([j]) => { const key = Math.min(i, j) + "-" + Math.max(i, j); if (seen.has(key)) return; seen.add(key); const e = { a: i, b: j, glow: 0 }; edges.push(e); a.links.push(e); nodes[j].links.push(e); });
    });
    let signals = [];   // { e, from, t, speed }
    const fire = (i, strength) => {
      const n = nodes[i]; n.glow = Math.min(1, n.glow + strength);
      for (const e of n.links) if (signals.length < 140) signals.push({ e, from: i, t: 0, speed: 1.1 + Math.random() * .9, s: strength });
    };

    // the pointer: where it is over the card (-1..1), whether it is there, and dragging
    const host = cv.parentElement || cv;
    const ptr = { x: 0, y: 0, in: false, down: false, lx: 0, moved: 0 };
    let yaw = Math.random() * 6.28, pitch = .35, spin = 0, tiltX = 0, tiltY = 0;
    let proj = [];
    const at = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * 2 - 1, (e.clientY - r.top) / r.height * 2 - 1, e.clientX - r.left, e.clientY - r.top]; };
    const nearest = (px, py) => { let best = -1, bd = 1e9; proj.forEach((p, i) => { const d = (p.sx - px) ** 2 + (p.sy - py) ** 2 - p.z * 400; if (d < bd) { bd = d; best = i; } }); return best; };
    const onMove = (e) => {
      const [x, y, px, py] = at(e); ptr.x = x; ptr.y = y; ptr.px = px; ptr.py = py; ptr.in = true;
      if (ptr.down) { const dx = e.clientX - ptr.lx; ptr.lx = e.clientX; ptr.moved += Math.abs(dx); spin = dx * .012; yaw += dx * .012; }
    };
    const onDown = (e) => { ptr.down = true; ptr.lx = e.clientX; ptr.moved = 0; onMove(e); };
    const onUp = (e) => {
      if (ptr.down && ptr.moved < 6) { const [, , px, py] = at(e), i = nearest(px, py); if (i >= 0) fire(i, 1); }   // a click, not a drag
      ptr.down = false; if (e.pointerType !== "mouse") ptr.in = false;
    };
    const onLeave = () => { ptr.in = false; ptr.down = false; };
    host.addEventListener("pointermove", onMove); host.addEventListener("pointerdown", onDown);
    addEventListener("pointerup", onUp); host.addEventListener("pointerleave", onLeave);

    let stopped = false, last = performance.now(), nextFire = 0, W = 0, H = 0, DPR = 1;
    const frame = (now) => {
      if (stopped || !cv.isConnected) { host.removeEventListener("pointermove", onMove); host.removeEventListener("pointerdown", onDown); removeEventListener("pointerup", onUp); host.removeEventListener("pointerleave", onLeave); return; }
      requestAnimationFrame(frame);
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      DPR = Math.min(2, devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight;
      const w = Math.max(1, Math.round(W * DPR)), h = Math.max(1, Math.round(H * DPR));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);

      // turning: a slow constant spin, the drag's momentum fading out, and a lean towards the pointer
      if (!still) yaw += dt * .16;
      if (!ptr.down) { yaw += spin; spin *= Math.pow(.04, dt); }
      tiltX += ((ptr.in ? ptr.y * .55 : 0) - tiltX) * Math.min(1, dt * 3); tiltY += ((ptr.in ? ptr.x * .6 : 0) - tiltY) * Math.min(1, dt * 3);
      const cy = Math.cos(yaw + tiltY), sy = Math.sin(yaw + tiltY), cp = Math.cos(pitch + tiltX), sp = Math.sin(pitch + tiltX);
      const R = Math.min(W, H) * .33, CX = W / 2, CY = H * .44, D = 3.2;
      proj = nodes.map((n) => {
        const x = n.x * cy + n.z * sy, z1 = -n.x * sy + n.z * cy, y = n.y * cp - z1 * sp, z = n.y * sp + z1 * cp, k = D / (D - z);
        return { sx: CX + x * R * k, sy: CY + y * R * k, z, k };
      });

      // signals: one on its own now and then, more right at the start; each one passes on with some chance
      if (!still && now > nextFire) { fire((Math.random() * N) | 0, .7); nextFire = now + 380 + Math.random() * 700; }
      const near = ptr.in ? (i) => { const p = proj[i], d = Math.hypot(p.sx - ptr.px, p.sy - ptr.py); return Math.max(0, 1 - d / (R * .55)); } : () => 0;
      for (const n of nodes) n.glow *= Math.pow(.25, dt);
      for (const e of edges) e.glow *= Math.pow(.2, dt);
      signals = signals.filter((s) => {
        s.t += dt * s.speed; s.e.glow = Math.max(s.e.glow, .8 * s.s);
        if (s.t < 1) return true;
        const to = s.e.a === s.from ? s.e.b : s.e.a;
        nodes[to].glow = Math.min(1, nodes[to].glow + .6 * s.s);
        if (s.s > .25 && Math.random() < .55) for (const e of nodes[to].links) if (e !== s.e && Math.random() < .5 && signals.length < 140) signals.push({ e, from: to, t: 0, speed: s.speed, s: s.s * .8 });
        return false;
      });

      // wires, far ones fainter
      ctx.lineCap = "round";
      for (const e of edges) {
        const a = proj[e.a], b = proj[e.b], depth = ((a.z + b.z) / 2 + 1) / 2, wake = Math.max(near(e.a), near(e.b));
        ctx.strokeStyle = `rgba(${110 + 120 * e.glow | 0},${165 + 70 * e.glow | 0},255,${(.07 + .22 * depth + .5 * e.glow + .35 * wake).toFixed(3)})`;
        ctx.lineWidth = .6 + .7 * depth + 1.2 * e.glow;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      // the pointer joins up with the nodes around it
      if (ptr.in) {
        proj.forEach((p, i) => { const v = near(i); if (v <= .15) return; ctx.strokeStyle = `rgba(180,215,255,${(v * .45).toFixed(3)})`; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(ptr.px, ptr.py); ctx.lineTo(p.sx, p.sy); ctx.stroke(); });
      }
      // signals: a bright dot with a short tail
      for (const s of signals) {
        const a = proj[s.from], b = proj[s.e.a === s.from ? s.e.b : s.e.a], t = s.t, x = a.sx + (b.sx - a.sx) * t, y = a.sy + (b.sy - a.sy) * t;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 6); g.addColorStop(0, `rgba(235,248,255,${s.s})`); g.addColorStop(1, "rgba(120,180,255,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 6, 0, 6.283); ctx.fill();
      }
      // nodes, back to front, with a halo when they are lit
      proj.map((p, i) => i).sort((i, j) => proj[i].z - proj[j].z).forEach((i) => {
        const p = proj[i], n = nodes[i], depth = (p.z + 1) / 2, lit = Math.min(1, n.glow + near(i) * .8), r = (1.3 + 1.6 * depth) * n.size * p.k * (1 + lit * .6);
        if (lit > .05) {
          const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r * 6); g.addColorStop(0, `rgba(140,195,255,${(.55 * lit).toFixed(3)})`); g.addColorStop(1, "rgba(80,140,255,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 6, 0, 6.283); ctx.fill();
        }
        ctx.fillStyle = `rgba(${150 + 105 * lit | 0},${195 + 55 * lit | 0},255,${(.35 + .5 * depth + .15 * lit).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, 6.283); ctx.fill();
      });
    };
    for (let i = 0; i < 3; i++) fire((Math.random() * N) | 0, .8);
    requestAnimationFrame(frame);
    return { stop() { stopped = true; } };
  };
})();
