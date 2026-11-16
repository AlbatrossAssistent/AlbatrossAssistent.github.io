// Minecraft redstone circuits as a real build, in 3D (used by redstone.js for the "redstone_design" tool).
//
// 1) redstoneLayout(spec) turns the NOR netlist into blocks, one per grid cell:
//    - every input and every torch output gets its own dust line ("lane") on the ground, running east, lanes 3 rows apart so they
//      never touch;
//    - the torches stand in a row south of the lanes, each on a stone block lifted to height 3: inputs run into that block, the
//      torch on its south side is the output;
//    - north–south wires climb out of their lane onto a row of stone bricks (dust 2 blocks up) and pass OVER the other lanes, so
//      wires cross without connecting; each wire has a column of its own, 2 apart from the next;
//    - repeaters go into straight stretches where the signal would get too weak (dust loses 1 strength per block).
//    Then a small redstone simulator (dust shapes and connections, signal strength, powered blocks, torches, repeaters, all with
//    Java Edition's rules) runs the finished build through every row of the truth table: a layout that doesn't behave is never shown.
// 2) redstone3D(spec) draws it: drawn-here pixel textures in the Minecraft style (grass, stone, stone bricks, dust, torches,
//    lever, lamp, repeater), drag to turn it, click a lever to switch it and watch the dust light up tick by tick.
(function () {
  const N = [0, 0, -1], E = [1, 0, 0], S = [0, 0, 1], W = [-1, 0, 0], UP = [0, 1, 0], DOWN = [0, -1, 0];
  const DIRS = [N, E, S, W];
  const K = (p) => p[0] + "," + p[1] + "," + p[2];
  const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
  const neg = (d) => [-d[0], -d[1], -d[2]];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const MAX_GATES_3D = 24;

  // ---------- the redstone rules ----------
  function rules(m) {
    const get = (p) => m.get(K(p));
    const solid = (p) => p[1] <= 0 || (!!get(p) && (get(p).t === "block" || get(p).t === "lamp"));
    const isDust = (p) => !!get(p) && get(p).t === "dust";
    // where a dust piece connects: dust beside it, one up (onto a block, unless a block sits on this dust) or one down,
    // and torches, levers and repeaters (only from the front or back)
    function conns(p) {
      const out = [];
      for (const d of DIRS) {
        const q = add(p, d), e = get(q);
        if (e && e.t !== "block" && e.t !== "lamp") {
          if (e.t === "dust" || e.t === "torch" || e.t === "lever" || (e.t === "rep" && e.f[1] === 0 && Math.abs(e.f[0]) === Math.abs(d[0]) && Math.abs(e.f[2]) === Math.abs(d[2]))) out.push({ d, q });
          continue;
        }
        if (solid(q)) { if (!solid(add(p, UP)) && isDust(add(q, UP))) out.push({ d, q: add(q, UP) }); }
        else if (isDust(add(q, DOWN))) out.push({ d, q: add(q, DOWN) });
      }
      return out;
    }
    // where it sends power: a dot (no connections) everywhere, one connection = a straight line both ways, else its connections
    function points(c) { const ds = c.map((x) => x.d); return ds.length === 0 ? DIRS : ds.length === 1 ? [ds[0], neg(ds[0])] : ds; }
    return { get, solid, isDust, conns, points };
  }

  function simulator(m) {
    const R = rules(m), { get, isDust } = R;
    const all = [...m.values()];
    const dusts = all.filter((e) => e.t === "dust"), torches = all.filter((e) => e.t === "torch"), reps = all.filter((e) => e.t === "rep");
    const levers = all.filter((e) => e.t === "lever"), lamps = all.filter((e) => e.t === "lamp");
    for (const d of dusts) { d.c = R.conns(d.p); d.pt = R.points(d.c); d.nb = d.c.filter((x) => isDust(x.q)).map((x) => get(x.q)); d.mask = d.c.reduce((s, x) => s | (1 << DIRS.indexOf(x.d)), 0); d.up = d.c.filter((x) => x.q[1] > d.p[1]).map((x) => x.d); }
    // a block is strongly powered by a repeater facing into it or a lit torch under it
    const strong = (b, st) => {
      const e = get(b); if (!e || e.t !== "block") return false;
      for (const d of DIRS) { const r = get(add(b, neg(d))); if (r && r.t === "rep" && same(r.f, d) && st.rep.get(r)) return true; }
      const t = get(add(b, DOWN)); return !!(t && t.t === "torch" && st.torch.get(t));
    };
    function dustLevels(st) {
      const s = new Map();
      for (const d of dusts) {
        let v = 0;
        for (const dir of DIRS) {
          const q = add(d.p, dir), e = get(q); if (!e) continue;
          if ((e.t === "lever" && st.lever.get(e)) || (e.t === "torch" && st.torch.get(e)) || (e.t === "rep" && st.rep.get(e) && same(add(q, e.f), d.p)) || (e.t === "block" && strong(q, st))) v = 15;
        }
        if (strong(add(d.p, DOWN), st)) v = 15;
        s.set(d, v);
      }
      for (let changed = true; changed;) { changed = false; for (const d of dusts) for (const n of d.nb) if (s.get(d) - 1 > s.get(n)) { s.set(n, s.get(d) - 1); changed = true; } }
      return s;
    }
    // powered at all (weakly is enough for a torch on it or a lamp): dust on top, dust pointing into it, a repeater facing it
    function powered(b, s, st) {
      if (strong(b, st)) return true;
      const top = get(add(b, UP)); if (top && top.t === "dust" && s.get(top) > 0) return true;
      for (const d of DIRS) {
        const e = get(add(b, neg(d))); if (!e) continue;
        if (e.t === "dust" && s.get(e) > 0 && e.pt.some((x) => same(x, d))) return true;
        if (e.t === "rep" && same(e.f, d) && st.rep.get(e)) return true;
      }
      return false;
    }
    function repInput(r, s, st) {
      const bp = add(r.p, neg(r.f)), e = get(bp); if (!e) return false;
      if (e.t === "dust") return s.get(e) > 0 && e.pt.some((x) => same(x, r.f));
      if (e.t === "rep") return same(e.f, r.f) && st.rep.get(e);
      if (e.t === "torch") return st.torch.get(e);
      if (e.t === "block") return powered(bp, s, st);
      return false;
    }
    const fresh = () => ({ lever: new Map(levers.map((l) => [l, false])), torch: new Map(torches.map((t) => [t, true])), rep: new Map(reps.map((r) => [r, false])) });
    // one redstone tick: dust follows at once, torches and repeaters take a tick each
    function tick(st) {
      const s = dustLevels(st), torch = new Map(), rep = new Map();
      let changed = false;
      for (const t of torches) { const v = !powered(add(t.p, t.a), s, st); torch.set(t, v); if (v !== st.torch.get(t)) changed = true; }
      for (const r of reps) { const v = repInput(r, s, st); rep.set(r, v); if (v !== st.rep.get(r)) changed = true; }
      return { st: { lever: st.lever, torch, rep }, changed };
    }
    function view(st) { const s = dustLevels(st); return { s, lamps: new Map(lamps.map((l) => [l, powered(l.p, s, st)])) }; }
    function settle(st, max = 400) { let n = 0; for (; n < max; n++) { const r = tick(st); if (!r.changed) break; st = r.st; } return { st, ticks: n }; }
    return { dusts, torches, reps, levers, lamps, fresh, tick, view, settle };
  }

  // ---------- the build ----------
  // The same rules as the circuit itself (see redstone.js): a gate is a torch, or a join of wires (merge: true) that costs no torch.
  const gv = (g, val) => { const any = g.ins.some((x) => val[x]); return g.merge ? (any ? 1 : 0) : any ? 0 : 1; };
  const netTick = (spec, val) => { const nx = { ...val }; for (const g of spec.gates) nx[g.name] = gv(g, val); return nx; };
  function netSettle(spec, inputs, from) {
    let val = { ...(from || {}), ...inputs };
    for (const g of spec.gates) if (!(g.name in val)) val[g.name] = 0;
    for (let t = 0; t < spec.gates.length + 3 || (spec.seq && t < 80); t++) { const nx = netTick(spec, val); if (spec.gates.every((g) => nx[g.name] === val[g.name])) break; val = nx; }
    return val;
  }
  // circuits that remember start from a known state: first the lever pattern spec.init, then everything released
  function netRest(spec) {
    if (!spec.seq) return netSettle(spec, Object.fromEntries(spec.vars.map((v) => [v, 0])));
    let val = Object.fromEntries(spec.gates.map((g) => [g.name, 1]));
    for (const phase of [spec.init || {}, {}]) val = netSettle(spec, Object.fromEntries(spec.vars.map((v) => [v, phase[v] ? 1 : 0])), val);
    return val;
  }
  const torchesOf = (spec) => spec.gates.filter((g) => !g.merge);

  function newBuild() {
    const m = new Map(), labels = [];
    const put = (p, e) => {
      const k = K(p), o = m.get(k);
      if (o) { if (o.t === "block" && e.t === "block") return o; throw new Error("layout clash at " + k); }
      e.p = p; m.set(k, e); return e;
    };
    return { m, labels, put,
      dust: (x, y, z, net) => { put([x, y, z], { t: "dust", net }); if (y > 1) put([x, y - 1, z], { t: "block", m: "bricks" }); },
      lever: (x, y, z, name) => { put([x, y, z], { t: "lever", name }); labels.push({ at: [x + 0.5, y + 0.9, z + 0.5], text: name }); },
      lamp: (x, y, z) => { put([x, y, z], { t: "lamp" }); labels.push({ at: [x + 0.5, y + 1.4, z + 0.5], text: "lamp" }); },
      stone: (x, y, z, gate) => put([x, y, z], { t: "block", m: "stone", gate }),
      torch: (x, y, z, a, name) => { put([x, y, z], { t: "torch", a, name }); if (name) labels.push({ at: [x + 0.5, y + 1.7, z + 0.5], text: name }); } };
  }

  // ---- compact hand-made layouts: what a player would build ----
  // Drawn as text, one string per row of blocks (x runs east, rows run south), everything on the ground layer:
  // . empty   d dust   S stone   O lamp   A..F the levers for input 1..6   and a torch is > < v ^ for the side of its block it stands on
  // (> east of the block, < west, v south, ^ north). Wires end in a straight piece pointing into the block they power.
  function fromArt(vars, rows, names) {
    const B = newBuild(), A = { ">": W, "<": E, v: N, "^": S };
    rows.forEach((row, z) => [...row].forEach((c, x) => {
      if (c === "d") B.dust(x, 1, z); else if (c === "S") B.stone(x, 1, z); else if (c === "O") B.lamp(x, 1, z);
      else if (c >= "A" && c <= "F") B.lever(x, 1, z, vars[c.charCodeAt(0) - 65]);
      else if (A[c]) B.torch(x, 1, z, A[c], (names || {})[x + "," + z] || "");
    }));
    return B;
  }
  const padRows = (rows) => { const w = Math.max(...rows.map((r) => r.length)); return rows.map((r) => r.padEnd(w, ".")); };
  const ART = {
    // a XOR b: T1 = a NOR b; T2 = a NOR T1; T3 = b NOR T1; the lamp joins T2 and T3
    xor: (vars) => fromArt(vars, padRows([
      "AdddddddS>dd..",
      "....d...d..d..",
      "....S>ddd..ddO",
      "....d...d..d..",
      "BdddddddS>dd..",
    ]), { "9,0": "T2", "5,2": "T1", "9,4": "T3" }),
    // a XNOR b: the XOR with one more torch that inverts it
    xnor: (vars) => fromArt(vars, padRows([
      "AdddddddS>dd......",
      "....d...d..d......",
      "....S>ddd..ddS>dO.",
      "....d...d..d......",
      "BdddddddS>dd......",
    ]), { "9,0": "T2", "5,2": "T1", "9,4": "T3", "14,2": "T4" }),
    // two torches that feed each other: the lamp is the memory
    latch: (vars) => fromArt(["S", "R"], padRows([
      "Bddd....",
      "...d....",
      ".ddS>ddO",
      ".d...d..",
      ".d<Sdd..",
      "...d....",
      "Addd....",
    ]), { "4,2": "T1", "2,4": "T2" }),
    // the lever's rising edge, delayed by two torches, switches the output on for one tick
    pulse: (vars) => fromArt(vars, padRows([
      "AdS>ddS>d",
      "....d...d",
      "....ddSdd",
      "......v..",
      "......d..",
      "......O..",
    ]), { "3,0": "T1", "7,0": "T2", "6,3": "T3" }),
  };
  // a row of levers, each straight on or through its own NOT torch, joined into one wire (an OR), then to the lamp
  // or through one more torch (a NOR). With that: AND, NAND, OR, NOR, "a and not b", "a or not b", ... of any number of inputs.
  function buildBus(vars, shape) {
    const { lines, kind } = shape, n = lines.length, B = newBuild(), W_ = W;
    const nots = lines.filter((l) => l.not).length;
    const nameOf = (k) => "T" + (k + 1);
    if (n === 1) {
      const l = lines[0], inv = kind === "or" ? l.not : !l.not;
      B.lever(0, 1, 0, vars[l.i]); B.dust(1, 1, 0);
      if (inv) { B.stone(2, 1, 0); B.torch(3, 1, 0, W_, "T1"); B.dust(4, 1, 0); B.lamp(5, 1, 0); } else B.lamp(2, 1, 0);
      return B;
    }
    const Xb = nots ? 5 : 2, zm = n - 1;
    let k = 0;
    lines.forEach((l, idx) => {
      const z = 2 * idx; B.lever(0, 1, z, vars[l.i]); B.dust(1, 1, z);
      if (l.not) { B.stone(2, 1, z); B.torch(3, 1, z, W_, nameOf(k++)); for (let x = 4; x < Xb; x++) B.dust(x, 1, z); }
      else for (let x = 2; x < Xb; x++) B.dust(x, 1, z);
    });
    for (let z = 0; z <= 2 * (n - 1); z++) B.dust(Xb, 1, z);
    B.dust(Xb + 1, 1, zm);
    if (kind === "or") B.lamp(Xb + 2, 1, zm);
    else { B.stone(Xb + 2, 1, zm); B.torch(Xb + 3, 1, zm, W_, nameOf(nots)); B.dust(Xb + 4, 1, zm); B.lamp(Xb + 5, 1, zm); }
    return B;
  }
  function busNet(vars, lines, kind) {
    const gates = [], parts = []; let k = 0;
    for (const l of lines) { if (l.not) { const name = "T" + (++k); gates.push({ name, ins: [vars[l.i]] }); parts.push(name); } else parts.push(vars[l.i]); }
    let out;
    if (kind === "nor") { out = "T" + (k + 1); gates.push({ name: out, ins: parts }); }
    else if (parts.length === 1) out = parts[0];
    else { out = "OUT"; gates.push({ name: out, ins: parts, merge: true }); }
    return { gates, out };
  }
  // the compact layout for a function, if there is one: the circuit (named like the picture) and the shape the picture is built from
  const cubeOf = (nv, rows) => {
    const k = rows.length; if (!k || (k & (k - 1))) return null;
    const fixed = [];
    for (let i = 0; i < nv; i++) { const bit = nv - 1 - i, v0 = (rows[0] >> bit) & 1; if (rows.every((r) => ((r >> bit) & 1) === v0)) fixed.push({ i, val: v0 }); }
    return k === 1 << (nv - fixed.length) ? fixed : null;
  };
  window.redstoneTemplate = function (vars, tt) {
    const nv = vars.length, ones = [], zeros = [];
    tt.forEach((v, r) => (v ? ones : zeros).push(r));
    if (!ones.length || !zeros.length) return null;
    const cands = [];
    const add = (fixed, kind) => {
      if (!fixed || fixed.length !== nv) return;
      const lines = fixed.map((f) => ({ i: f.i, not: f.val === 1 })), nots = lines.filter((l) => l.not).length;
      cands.push({ cost: kind === "nor" ? nots + 1 : nots, shape: { t: "bus", kind, lines }, net: busNet(vars, lines, kind) });
    };
    add(cubeOf(nv, ones), "nor"); add(cubeOf(nv, zeros), "or");      // all ones in one corner of the table = AND of the inputs; all zeros = OR
    if (cands.length) return cands.sort((a, b) => a.cost - b.cost)[0];
    if (nv === 2) {
      const key = tt.join("");
      const [a, b] = vars, x = [{ name: "T1", ins: [a, b] }, { name: "T2", ins: ["T1", a] }, { name: "T3", ins: ["T1", b] }];
      if (key === "0110") return { shape: { t: "xor" }, net: { gates: [...x, { name: "OUT", ins: ["T2", "T3"], merge: true }], out: "OUT" } };
      if (key === "1001") return { shape: { t: "xnor" }, net: { gates: [...x, { name: "T4", ins: ["T2", "T3"] }], out: "T4" } };
    }
    return null;
  };
  function buildShape(spec) {
    const sh = spec.shape; if (!sh) return null;
    const t = sh.t || sh;
    if (t === "bus") return buildBus(spec.vars, sh);
    return ART[t] ? ART[t](spec.vars) : null;
  }

  // ---- everything else: one dust line (a "lane") on the ground for every wire, torches in a row to the south, and wires that
  // cross run up over the others on stone bricks. Not small, but it works for any circuit; lanes LS apart (2, or 3 if 2 doesn't work).
  function buildGeneric(spec, LS) {
    const { vars, gates, out } = spec;
    if (torchesOf(spec).length > MAX_GATES_3D) throw new Error(`That circuit needs ${torchesOf(spec).length} torches: too big for the 3D build view (up to ${MAX_GATES_3D}).`);
    const B = newBuild(), { dust, put, labels } = B;
    if (!gates.length) {   // the output is an input: lever, dust, lamp
      B.lever(0, 1, 0, out); dust(1, 1, 0, out); dust(2, 1, 0, out); B.lamp(3, 1, 0);
      return B;
    }
    const consumed = new Set(); gates.forEach((g) => g.ins.forEach((n) => consumed.add(n)));
    const lanes = [...vars.filter((v) => consumed.has(v)), ...gates.filter((g) => consumed.has(g.name)).map((g) => g.name)];
    const zOf = {}; lanes.forEach((n, i) => (zOf[n] = LS * i));
    const zG = LS * lanes.length + 2, gx = {};      // two spare rows: room for a repeater at the foot of every joined wire
    let edge = 0;
    for (const g of gates) { gx[g.name] = edge + 2 + 2 * (g.ins.length - 1); edge = gx[g.name] + 2; }
    const lo = {}, hi = {}, taps = [];
    for (const v of vars) if (consumed.has(v)) { lo[v] = 1; hi[v] = 1; }
    for (const g of gates) if (consumed.has(g.name)) { lo[g.name] = gx[g.name] + 2; hi[g.name] = gx[g.name] + 2; }
    for (const g of gates) g.ins.forEach((n, j) => {
      const c = j === 0 ? gx[g.name] : gx[g.name] - 2 * j;
      taps.push({ n, c, west: j >= 1, merge: !!g.merge });
      lo[n] = Math.min(lo[n], c); hi[n] = Math.max(hi[n], c);
    });
    for (const v of vars) if (consumed.has(v)) { B.lever(0, 1, zOf[v], v); }
    for (const n of lanes) for (let x = lo[n]; x <= hi[n]; x++) dust(x, 1, zOf[n], n);
    for (const t of taps) {      // climb out of the lane (2 steps), then south at height 3 over everything
      const zl = zOf[t.n];
      dust(t.c, 2, zl + 1, t.n); dust(t.c, 3, zl + 2, t.n);
      // wires that meet (the 2nd, 3rd... input of a torch's block, and every input of the final join) get a repeater at their foot:
      // power only flows forward, so one signal can't leak into another's line through the join
      for (let z = zl + 3; z <= (t.west || t.merge ? zG : zG - 1); z++) {
        if (z === zG - 1 && (t.west || t.merge)) { put([t.c, 3, z], { t: "rep", f: S }); put([t.c, 2, z], { t: "block", m: "bricks" }); }
        else dust(t.c, 3, z, t.n);
      }
      if (t.west) dust(t.c + 1, 3, zG, t.n);
    }
    for (const g of gates) {
      const x = gx[g.name];
      if (g.merge) {      // the wires meet here, and go on to the lamp
        dust(x + 1, 3, zG, g.name); B.lamp(x + 2, 3, zG); labels.push({ at: [x + 0.5, 4.6, zG + 0.5], text: "join" });
        continue;
      }
      B.stone(x, 3, zG, g.name);
      B.torch(x, 3, zG + 1, N, g.name);
      dust(x, 3, zG + 2, g.name);
      if (g.name === out) B.lamp(x, 3, zG + 3);
      if (consumed.has(g.name)) {   // back north to its own lane: over, then 2 steps down
        const zo = zOf[g.name];
        dust(x + 1, 3, zG + 2, g.name);
        for (let z = zG + 2; z >= zo + 2; z--) dust(x + 2, 3, z, g.name);
        dust(x + 2, 2, zo + 1, g.name);
      }
    }
    return B;
  }

  // repeaters where the signal would get too weak: walk every wire from its lever or torch and put one on a straight, flat
  // piece before the strength runs out (a repeater sends 15 again)
  function addRepeaters(m, th) {
    const R = rules(m), get = R.get;
    const dusts = [...m.values()].filter((e) => e.t === "dust");
    const info = new Map(dusts.map((d) => [d, R.conns(d.p)]));
    const srcs = dusts.filter((d) => info.get(d).some((c) => { const e = get(c.q); return e && (e.t === "lever" || e.t === "torch"); }));
    const parent = new Map(), order = [], seen = new Set(srcs);
    const queue = [...srcs];
    while (queue.length) { const d = queue.shift(); order.push(d); for (const c of info.get(d)) { const n = get(c.q); if (n && n.t === "dust" && !seen.has(n)) { seen.add(n); parent.set(n, d); queue.push(n); } } }
    const kids = new Map(); for (const [k, p] of parent) kids.set(p, [...(kids.get(p) || []), k]);
    const level = new Map();
    for (const d of order) {
      const p = parent.get(d), s = !p ? 15 : p.t === "rep" ? 15 : level.get(p) - 1;
      const c = info.get(d), ch = kids.get(d) || [];
      const straight = c.length === 2 && same(c[0].d, neg(c[1].d)) && c.every((x) => x.q[1] === d.p[1] && get(x.q) && get(x.q).t === "dust");
      if (s <= th && p && ch.length === 1 && straight) {
        const f = [ch[0].p[0] - d.p[0], 0, ch[0].p[2] - d.p[2]];
        d.t = "rep"; d.f = f; delete d.net; level.set(d, 15);
      } else level.set(d, s);
    }
  }

  const layoutCache = new WeakMap();
  // The compact hand-made layout first (if the function has one), then the general one; each with as few repeaters as work (put in
  // late first: fewer of them, less delay; if a wire runs dry before a straight piece comes along, the check fails and the next
  // try puts them in a little earlier). Every layout must pass the redstone check below, or the next one is tried.
  function layout(spec) {
    if (layoutCache.has(spec)) return layoutCache.get(spec);
    const tries = [];
    if (spec.shape) tries.push(["compact", () => buildShape(spec)]);
    tries.push(["lanes", () => buildGeneric(spec, 2)], ["lanes", () => buildGeneric(spec, 3)]);
    let err = null;
    for (const [kind, make] of tries) {
      for (const th of [1, 2, 3, 4, 6, 9]) {
        try { const res = tryLayout(spec, make(), th); res.kind = kind; layoutCache.set(spec, res); return res; }
        catch (e) { err = e; if (/too big/.test(e.message)) throw e; if (/layout clash/.test(e.message)) break; }
      }
    }
    throw err;
  }
  // the block simulation, taken to its resting state (circuits that remember: the pattern spec.init first, then released)
  function blockRest(sim, spec) {
    const setL = (st, inp) => { for (const l of sim.levers) st.lever.set(l, !!inp[l.name]); };
    let st = sim.fresh();
    if (spec.seq) { setL(st, spec.init || {}); st = sim.settle(st, 200).st; setL(st, {}); st = sim.settle(st, 200).st; return st; }
    return sim.settle(st).st;
  }
  function tryLayout(spec, B, th) {
    const { m, labels } = B;
    if (!B.m.size) throw new Error("no layout");
    addRepeaters(m, th);
    const sim = simulator(m), nv = spec.vars.length;
    const setL = (st, inp) => { for (const l of sim.levers) st.lever.set(l, !!inp[l.name]); };
    const lampLit = (st) => !![...sim.view(st).lamps.values()][0];
    let delay = 0, st = blockRest(sim, spec);
    if (spec.seq) {
      // the block build has to behave like the circuit, step by step, from the same resting state
      let ref = netRest(spec);
      if (lampLit(st) !== !!ref[spec.out]) throw new Error("the 3D build didn't pass its own check (rest state)");
      (spec.test || []).forEach((vec, i) => {
        setL(st, vec); const r = sim.settle(st, 200); st = r.st; delay = Math.max(delay, r.ticks);
        ref = netSettle(spec, vec, ref);
        if (lampLit(st) !== !!ref[spec.out]) throw new Error("the 3D build didn't pass its own check (step " + i + ")");
      });
      if (spec.pulse) {      // a pulse is over before things settle: watch it tick by tick
        st = blockRest(sim, spec); setL(st, { [spec.vars[0]]: 1 }); let seen = false;
        for (let t = 0; t < 14; t++) { const r = sim.tick(st); st = r.st; if (lampLit(st)) seen = true; if (!r.changed) break; }
        if (!seen) throw new Error("the 3D pulse never lit the lamp");
        if (lampLit(st)) throw new Error("the 3D pulse didn't switch off again");
      }
    } else {
      for (let n = 0; n < 1 << nv; n++) {
        const inp = {}; spec.vars.forEach((v, k) => (inp[v] = (n >> (nv - 1 - k)) & 1));
        setL(st, inp); const r = sim.settle(st); st = r.st; delay = Math.max(delay, r.ticks);
        if (lampLit(st) !== !!netSettle(spec, inp)[spec.out]) throw new Error("the 3D build didn't pass its own check (row " + n + ")");
      }
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0;
    for (const e of m.values()) { x0 = Math.min(x0, e.p[0]); x1 = Math.max(x1, e.p[0]); z0 = Math.min(z0, e.p[2]); z1 = Math.max(z1, e.p[2]); y1 = Math.max(y1, e.p[1]); }
    const all = [...m.values()], count = (f) => all.filter(f).length;
    return { m, labels, sim, delay, box: { x0, x1, z0, z1, y1 },
      counts: { bricks: count((e) => e.t === "block" && e.m === "bricks"), stone: count((e) => e.t === "block" && e.m === "stone"), dust: count((e) => e.t === "dust"), torches: count((e) => e.t === "torch"), repeaters: count((e) => e.t === "rep"), levers: count((e) => e.t === "lever"), lamps: count((e) => e.t === "lamp") } };
  }
  window.redstoneLayout = layout;
  window.redstone3dTest = { buildGeneric, simulator, addRepeaters, blockRest, netSettle, buildShape };   // for the self-test and debugging
  window.redstoneLayoutText = function (spec) {
    const L = layout(spec), c = L.counts, b = L.box;
    return `3D build (shown to the user, block by block): ${b.x1 - b.x0 + 1} × ${b.z1 - b.z0 + 1} blocks on the ground, ${b.y1} high. Materials: ${c.dust} redstone dust, ${c.torches} redstone torch${c.torches === 1 ? "" : "es"}, ${c.stone} stone (the torch blocks), ${c.bricks} stone bricks (bridges and steps), ${c.repeaters ? c.repeaters + " repeaters, " : ""}${c.levers} lever${c.levers === 1 ? "" : "s"}, ${c.lamps} redstone lamp. ${L.kind === "compact" ? "A compact layout on one level, like a player would build it. " : "Every wire has its own dust line on the ground and crosses the others on a raised bridge, so no two lines touch (the general layout, bigger than a hand-made one). "}Checked with a redstone simulation (${spec.seq ? "the lamp follows the circuit step by step" : "every row of the truth table"}); delay up to ${L.delay} redstone ticks.`;
  };
  if (typeof document === "undefined") return;

  // ====================================================================== textures ======================================================================
  function rng(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function paint16(seed, fn) {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const g = c.getContext("2d"), img = g.createImageData(16, 16), r = rng(seed);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const px = fn(x, y, r); if (!px) continue;
      const i = (y * 16 + x) * 4; img.data[i] = px[0]; img.data[i + 1] = px[1]; img.data[i + 2] = px[2]; img.data[i + 3] = px[3] == null ? 255 : px[3];
    }
    g.putImageData(img, 0, 0); return c;
  }
  const mul = (c, k) => [Math.max(0, Math.min(255, c[0] * k)), Math.max(0, Math.min(255, c[1] * k)), Math.max(0, Math.min(255, c[2] * k))];
  const coarse = (r) => { const a = Array.from({ length: 16 }, r); return (x, y) => a[(x >> 2) + (y >> 2) * 4]; };
  const TEX = {};
  const tex = (k) => TEX[k] || (TEX[k] = makeTex(k));
  function makeTex(k) {
    if (k.startsWith("grass_top")) { const v = Number(k.slice(9)) || 0; return paint16(11 + v, (x, y, r) => { const n = r(); return mul([92, 150, 54], n > 0.93 ? 1.18 : n < 0.08 ? 0.72 : 0.84 + r() * 0.24); }); }
    switch (k) {
      case "dirt": return paint16(21, (x, y, r) => { const n = r(); return n > 0.9 ? [104, 74, 52] : n < 0.08 ? [158, 116, 84] : mul([134, 96, 67], 0.86 + r() * 0.22); });
      case "grass_side": { const fr = rng(5), edge = Array.from({ length: 16 }, () => 2 + Math.floor(fr() * 3)); return paint16(22, (x, y, r) => y < edge[x] ? mul([92, 150, 54], 0.82 + r() * 0.25) : (r() > 0.9 ? [104, 74, 52] : mul([134, 96, 67], 0.86 + r() * 0.22))); }
      case "stone": { const r0 = rng(31), cs = coarse(r0); return paint16(32, (x, y, r) => { const v = 108 + cs(x, y) * 26 + r() * 18; return [v, v, v]; }); }
      case "bricks": return paint16(41, (x, y, r) => {
        const row = y >> 3, yy = y & 7, vx = row ? 7 : 15;
        if (yy === 7 || x === vx || (row === 1 && x === 15 && false)) return [86, 86, 86];
        const v = (yy === 0 ? 132 : 118) + r() * 14 - (x === vx - 1 ? 10 : 0); return [v, v, v];
      });
      case "cobble": { const pts = Array.from({ length: 9 }, (_, i) => { const r = rng(60 + i); return [r() * 16, r() * 16, 0.75 + r() * 0.5]; }); return paint16(61, (x, y, r) => {
        let a = 1e9, b = 1e9, k2 = 1; for (const p of pts) for (const ox of [-16, 0, 16]) for (const oy of [-16, 0, 16]) { const d = (x - p[0] - ox) ** 2 + (y - p[1] - oy) ** 2; if (d < a) { b = a; a = d; k2 = p[2]; } else if (d < b) b = d; }
        const edge = Math.sqrt(b) - Math.sqrt(a) < 1.2; const v = edge ? 72 : 118 * k2 + r() * 14; return [v, v, v]; }); }
      case "smooth": return paint16(71, (x, y, r) => { const v = x === 0 || y === 0 || x === 15 || y === 15 ? 138 : 164 + r() * 8; return [v, v, v]; });
      case "lamp_off": case "lamp_on": { const on = k === "lamp_on"; return paint16(on ? 81 : 82, (x, y, r) => {
        const line = x % 5 === 0 || y % 5 === 0;
        if (on) return line ? mul([196, 122, 52], 0.9 + r() * 0.2) : mul(r() > 0.5 ? [255, 236, 170] : [255, 214, 120], 0.95 + r() * 0.08);
        return line ? mul([58, 36, 22], 0.9 + r() * 0.2) : mul(r() > 0.5 ? [132, 86, 48] : [104, 66, 36], 0.9 + r() * 0.15); }); }
      case "stick": return paint16(91, (x, y, r) => mul(x % 4 < 2 ? [118, 88, 48] : [92, 68, 36], 0.9 + r() * 0.2));
      case "torch_on": return paint16(92, (x, y, r) => r() > 0.6 ? [255, 190, 150] : [255, 58, 30]);
      case "torch_off": return paint16(93, (x, y, r) => mul([104, 26, 18], 0.85 + r() * 0.3));
    }
    const dm = /^dust(\d+)_(\d+)$/.exec(k);
    if (dm) {    // dust: a blob in the middle, an arm to each side it connects to (all four for a lone dot), brighter when powered
      const mask = Number(dm[1]), lv = Number(dm[2]), t = lv / 15, col = lv ? [130 + 125 * t, 8 + 32 * t, 4] : [84, 0, 0];
      const arms = mask === 0 ? 15 : mask;
      return paint16(100 + mask, (x, y, r) => {
        const inC = x >= 5 && x <= 10 && y >= 5 && y <= 10, inV = x >= 6 && x <= 9, inH = y >= 6 && y <= 9;
        const on = inC || (inV && y < 6 && arms & 1) || (inH && x > 9 && arms & 2) || (inV && y > 9 && arms & 4) || (inH && x < 6 && arms & 8);
        if (!on || r() < 0.1) return null;
        return [...mul(col, 0.72 + r() * 0.45), 255];
      });
    }
    const dv = /^dustv_(\d+)$/.exec(k);
    if (dv) { const lv = Number(dv[1]), t = lv / 15, col = lv ? [130 + 125 * t, 8 + 32 * t, 4] : [84, 0, 0]; return paint16(120, (x, y, r) => (x >= 6 && x <= 9 && r() > 0.1 ? [...mul(col, 0.72 + r() * 0.45), 255] : null)); }
    const rp = /^rep_(on|off)$/.exec(k);
    if (rp) { const on = rp[1] === "on"; return paint16(130, (x, y, r) => (x >= 7 && x <= 8 && y >= 2 && y <= 13 ? (on ? [255, 40, 20] : [96, 8, 4]) : (x === 0 || y === 0 || x === 15 || y === 15 ? [138, 138, 138] : [164 + r() * 8, 164 + r() * 8, 164 + r() * 8]))); }
    return paint16(1, () => [255, 0, 255]);
  }
  const SHADED = {};
  function shaded(k, sh) {
    const key = k + "|" + sh; if (SHADED[key]) return SHADED[key];
    const src = tex(k); if (sh >= 1) return (SHADED[key] = src);
    const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
    const g = c.getContext("2d"); g.drawImage(src, 0, 0); g.globalCompositeOperation = "source-atop"; g.fillStyle = `rgba(0,0,0,${(1 - sh).toFixed(2)})`; g.fillRect(0, 0, c.width, c.height);
    return (SHADED[key] = c);
  }

  // ====================================================================== geometry ======================================================================
  const v3 = (x, y, z) => [x, y, z];
  const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], vsc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  // a box from its corner o along A, B (up), C; tx(face) gives the texture key for "top" | "bottom" | "side"
  function box(faces, o, A, B, C, tx, meta, cull) {
    const nA = norm(A), nB = norm(B), nC = norm(C);
    const F = [
      ["top", vadd(o, B), vadd(vadd(o, B), A), vadd(vadd(o, B), C), nB, UP],
      ["bottom", vadd(o, C), vadd(vadd(o, C), A), o, neg(nB), DOWN],
      ["side", vadd(o, vadd(A, B)), vadd(o, B), vadd(o, A), neg(nC), N],
      ["side", vadd(o, vadd(C, B)), vadd(o, vadd(vadd(C, B), A)), vadd(o, C), nC, S],
      ["side", vadd(o, B), vadd(o, vadd(B, C)), o, neg(nA), W],
      ["side", vadd(o, vadd(vadd(A, B), C)), vadd(o, vadd(A, B)), vadd(o, vadd(A, C)), nA, E],
    ];
    for (const [kind, p0, p1, p3, n, dir] of F) { if (cull && cull(dir)) continue; faces.push({ p0, p1, p3, n, tex: () => tx(kind), ...meta }); }
  }
  function sceneOf(L) {
    const faces = [], heads = [], levers = [], { m } = L, get = (p) => m.get(K(p));
    const opaque = (p) => p[1] <= 0 || (!!get(p) && (get(p).t === "block" || get(p).t === "lamp"));
    for (const e of m.values()) {
      const [x, y, z] = e.p, meta = { e, y };
      if (e.t === "block" || e.t === "lamp") {
        const tk = e.t === "lamp" ? () => (e.lit ? "lamp_on" : "lamp_off") : () => (e.m === "stone" ? "stone" : "bricks");
        box(faces, v3(x, y, z), E, UP, S, tk, meta, (d) => opaque(add(e.p, d)));
      } else if (e.t === "dust") {
        faces.push({ ...meta, p0: v3(x, y + 0.015, z), p1: v3(x + 1, y + 0.015, z), p3: v3(x, y + 0.015, z + 1), n: UP, tex: () => "dust" + e.mask + "_" + (e.lv || 0) });
        for (const d of e.up) {     // dust running up the side of the block it climbs onto
          const c = [x + 0.5 + d[0] * 0.485, y + 0.5, z + 0.5 + d[2] * 0.485], U = [Math.abs(d[2]) * 0.5, 0, Math.abs(d[0]) * 0.5];
          faces.push({ ...meta, p0: vadd(vadd(c, neg(U)), [0, 0.5, 0]), p1: vadd(vadd(c, U), [0, 0.5, 0]), p3: vadd(vadd(c, neg(U)), [0, -0.5, 0]), n: neg(d), tex: () => "dustv_" + (e.lv || 0) });
        }
      } else if (e.t === "torch") {
        const a = e.a, t = 0.39, up = norm(vadd(vsc(UP, Math.cos(t)), vsc(a, -Math.sin(t))));
        const e1 = [a[2] === 0 ? 0 : 1, 0, a[0] === 0 ? 0 : 1], e2 = norm(cross(up, e1)), w = 2 / 16;
        const base = [x + 0.5 + a[0] * 0.42, y + 0.2, z + 0.5 + a[2] * 0.42];
        const o = vadd(base, vadd(vsc(e1, -w / 2), vsc(e2, -w / 2)));
        box(faces, o, vsc(e1, w), vsc(up, 8 / 16), vsc(e2, w), () => "stick", meta);
        box(faces, vadd(o, vsc(up, 8 / 16)), vsc(e1, w), vsc(up, 2.2 / 16), vsc(e2, w), () => (e.lit ? "torch_on" : "torch_off"), meta);
        heads.push({ e, at: vadd(base, vsc(up, 9.5 / 16)) });
      } else if (e.t === "lever") {
        box(faces, v3(x + 5 / 16, y, z + 4 / 16), vsc(E, 6 / 16), vsc(UP, 3 / 16), vsc(S, 8 / 16), () => "cobble", meta);
        const piv = [x + 0.5, y + 3 / 16, z + 0.5], w = 2 / 16;
        const stick = (on) => { const t = on ? 0.7 : -0.7, up = [0, Math.cos(t), Math.sin(t)], e2 = norm(cross(up, E)); return { up, o: vadd(piv, vadd(vsc(E, -w / 2), vsc(e2, -w / 2))), e2 }; };
        for (const on of [false, true]) { const s = stick(on); box(faces, s.o, vsc(E, w), vsc(s.up, 9 / 16), vsc(s.e2, w), () => "stick", { ...meta, show: () => !!e.on === on }); }
        levers.push({ e, at: () => vadd(piv, vsc(stick(!!e.on).up, 0.35)) });
      } else if (e.t === "rep") {
        const f = e.f, side = [-f[2], 0, f[0]], c = [x + 0.5, y, z + 0.5];
        const o = vadd(c, vadd(vsc(side, -0.5), vsc(f, -0.5)));
        box(faces, o, side, vsc(UP, 2 / 16), f, (k) => (k === "top" ? (e.on ? "rep_on" : "rep_off") : "smooth"), meta);
        for (const k of [-0.25, 0.28]) {
          const b = vadd(vadd(c, vsc(f, k)), [0, 2 / 16, 0]), w = 2 / 16, o2 = vadd(b, vadd(vsc(side, -w / 2), vsc(f, -w / 2)));
          box(faces, o2, vsc(side, w), vsc(UP, 3 / 16), vsc(f, w), () => "stick", meta);
          box(faces, vadd(o2, [0, 3 / 16, 0]), vsc(side, w), vsc(UP, 2 / 16), vsc(f, w), () => (e.on ? "torch_on" : "torch_off"), meta);
          heads.push({ e, at: vadd(b, [0, 4.5 / 16, 0]), small: true });
        }
      }
    }
    return { faces, heads, levers };
  }

  // ====================================================================== the 3D card ======================================================================
  const CSS3 = `
.rs-3d .rs-stage3 { position: relative; border-radius: 10px; overflow: hidden; touch-action: none; user-select: none; background: #a9d2ff; }
.rs-3d canvas { display: block; width: 100%; cursor: grab; }
.rs-3d canvas.drag { cursor: grabbing; }
.rs-3d .rs-tools { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.rs-3d .rs-tools button, .rs-3d .rs-tools select { all: unset; box-sizing: border-box; height: 28px; min-width: 28px; line-height: 28px; text-align: center; font: 600 12px/28px system-ui, sans-serif; border-radius: 8px; padding: 0 9px; background: rgba(20,24,30,.72); color: #fff; cursor: pointer; }
.rs-3d .rs-tools select option { color: #000; background: #fff; }
.rs-3d .rs-tools button:focus-visible, .rs-3d .rs-tools select:focus-visible { outline: 2px solid #fff; }
.rs-3d .rs-tools button:hover { background: rgba(20,24,30,.9); }
.rs-3d .rs-hint { position: absolute; left: 8px; bottom: 8px; font: 500 11px system-ui, sans-serif; color: #fff; background: rgba(20,24,30,.6); padding: 3px 8px; border-radius: 8px; pointer-events: none; }
.rs-3d .rs-mats { margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.rs-3d .rs-mats b { color: var(--fg); }
`;
  function style3() { if (document.getElementById("rs3-style")) return; const s = document.createElement("style"); s.id = "rs3-style"; s.textContent = CSS3; document.head.appendChild(s); }

  window.redstone3D = function (spec) {
    let L; try { L = layout(spec); } catch (e) { return null; }
    style3();
    const { sim, box: bb } = L, scene = sceneOf(L);
    const box = document.createElement("div"); box.className = "rs-3d";
    box.innerHTML = `<div class="rs-stage3"><canvas></canvas><div class="rs-tools"><select aria-label="Show up to height"><option value="9">All layers</option><option value="1">Layer 1 (ground)</option><option value="2">Layers 1–2</option><option value="3">Layers 1–3</option></select><button type="button" data-a="out" aria-label="Zoom out">−</button><button type="button" data-a="in" aria-label="Zoom in">+</button><button type="button" data-a="reset">Reset view</button></div><div class="rs-hint">Drag to turn · click a lever</div></div>
      <div class="rs-row"><div class="rs-status"></div><table><thead><tr>${spec.vars.map((v) => `<th>${v.replace(/[<&]/g, "")}</th>`).join("")}<th class="o">lamp</th></tr></thead><tbody></tbody></table></div><div class="rs-mats"></div>`;
    const cv = box.querySelector("canvas"), ctx = cv.getContext("2d"), stage = box.querySelector(".rs-stage3");
    const status = box.querySelector(".rs-status"), tbody = box.querySelector("tbody");
    const c = L.counts;
    box.querySelector(".rs-mats").innerHTML = `<b>Materials:</b> ${c.dust} redstone dust · ${c.torches} redstone torch${c.torches === 1 ? "" : "es"} · ${c.stone} stone · ${c.bricks} stone bricks${c.repeaters ? ` · ${c.repeaters} repeaters` : ""} · ${c.levers} lever${c.levers === 1 ? "" : "s"} · ${c.lamps} redstone lamp. <b>Size:</b> ${bb.x1 - bb.x0 + 1} × ${bb.z1 - bb.z0 + 1} blocks, ${bb.y1} high.${c.bricks ? " The raised rows of stone bricks are bridges: a wire goes up and over the lines below it, so no two dust lines touch." : L.kind === "compact" ? " Everything is on one level, no bridges." : ""}`;

    // ----- state -----
    const nv = spec.vars.length;
    let st = blockRest(sim, spec), timer = null, ticks = 0, moving = false;
    function apply() {
      const v = sim.view(st);
      for (const d of sim.dusts) d.lv = v.s.get(d);
      for (const t of sim.torches) t.lit = st.torch.get(t);
      for (const r of sim.reps) r.on = st.rep.get(r);
      for (const l of sim.levers) l.on = st.lever.get(l);
      for (const l of sim.lamps) l.lit = v.lamps.get(l);
    }
    const inputs = () => Object.fromEntries(sim.levers.map((l) => [l.name, st.lever.get(l) ? 1 : 0]));
    const table = [];
    if (spec.seq) box.querySelector("table").hidden = true;
    else for (let n = 0; n < 1 << nv; n++) { const val = {}; spec.vars.forEach((v, k) => (val[v] = (n >> (nv - 1 - k)) & 1)); const all = { ...val }; for (const g of spec.gates) all[g.name] = gv(g, all); table.push({ val, o: all[spec.out] }); }
    if (!spec.seq) tbody.innerHTML = table.map((r, n) => `<tr data-row="${n}">${spec.vars.map((v) => `<td>${r.val[v]}</td>`).join("")}<td class="o${r.o ? " y" : ""}">${r.o ? "ON" : "off"}</td></tr>`).join("");
    function info() {
      const i = inputs(), row = spec.vars.reduce((s, v) => s * 2 + i[v], 0), lit = sim.lamps.some((l) => l.lit);
      tbody.querySelectorAll("tr").forEach((tr) => tr.classList.toggle("cur", Number(tr.dataset.row) === row));
      status.innerHTML = (spec.seq ? `<b>Click the levers</b> in the picture. ${spec.note || ""} Bright dust is powered.` : `<b>Click a lever</b> in the picture (or a row of the table). Bright dust is powered; each torch is on only while nothing powers the block it hangs on.`) +
        (moving ? `<br><b>Tick ${ticks}</b>: the signal is on its way…` : `<br>Lamp is <b>${lit ? "ON" : "off"}</b>${ticks ? ` (after ${ticks} tick${ticks === 1 ? "" : "s"})` : ""}.`);
    }
    function setLevers(vals) {
      for (const l of sim.levers) st.lever.set(l, !!vals[l.name]);
      ticks = 0; moving = true; clearInterval(timer); apply(); info(); draw();
      timer = setInterval(() => {
        const r = sim.tick(st);
        if (!r.changed || !box.isConnected) { clearInterval(timer); timer = null; moving = false; apply(); info(); draw(); return; }
        st = r.st; ticks++; apply(); info(); draw();
      }, 220);
    }
    tbody.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => setLevers(table[Number(tr.dataset.row)].val)));

    // ----- view -----
    const ctr = [(bb.x0 + bb.x1 + 1) / 2, 1.5, (bb.z0 + bb.z1 + 1) / 2];
    const DEF = { yaw: 0.62, pitch: 0.7, zoom: 1, px: 0, py: 0 };
    let view = { ...DEF }, maxY = 9, fit = 1, dpr = 1, cw = 0, ch = 0;
    const fx0 = bb.x0 - 1, fx1 = bb.x1 + 2, fz0 = bb.z0 - 1, fz1 = bb.z1 + 2;
    function proj(p) {
      const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      const x = p[0] - ctr[0], y = p[1] - ctr[1], z = p[2] - ctr[2];
      const xr = x * cy - z * sy, zr = x * sy + z * cy, s = fit * view.zoom;
      return { x: cw / 2 + view.px * dpr + xr * s, y: ch / 2 + view.py * dpr + (zr * sp - y * cp) * s, d: y * sp + zr * cp };
    }
    function fitScale() {
      const save = { ...view }; view = { ...view, zoom: 1, px: 0, py: 0 }; fit = 1;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const x of [fx0, fx1]) for (const y of [0, bb.y1 + 1.5]) for (const z of [fz0, fz1]) { const q = proj([x, y, z]); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      view = save; fit = Math.min(cw / (x1 - x0), ch / (y1 - y0)) * 0.94;
    }
    // the ground: one big grass quad (and dirt edges) instead of thousands of tiny faces
    let ground = null;
    function groundTex() {
      const gw = fx1 - fx0, gd = fz1 - fz0, px = Math.max(4, Math.min(16, Math.floor(2400 / Math.max(gw, gd))));
      const c = document.createElement("canvas"); c.width = gw * px; c.height = gd * px;
      const g = c.getContext("2d"); g.imageSmoothingEnabled = false; const r = rng(7);
      for (let i = 0; i < gw; i++) for (let j = 0; j < gd; j++) g.drawImage(tex("grass_top" + Math.floor(r() * 4)), i * px, j * px, px, px);
      const side = (len) => { const s = document.createElement("canvas"); s.width = len * 16; s.height = 16; const sg = s.getContext("2d"); for (let i = 0; i < len; i++) sg.drawImage(tex("grass_side"), i * 16, 0); return s; };
      return { top: c, sx: side(gw), sz: side(gd) };
    }
    function drawImg(img, P0, P1, P3) {
      let ax = P1.x - P0.x, ay = P1.y - P0.y, bx = P3.x - P0.x, by = P3.y - P0.y;
      if (Math.abs(ax * by - ay * bx) < 0.5) return;
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1, ga = 0.55 / la, gb = 0.55 / lb;     // overlap a hair: no seams
      const ox = P0.x - ax * ga - bx * gb, oy = P0.y - ay * ga - by * gb;
      ax *= 1 + 2 * ga; ay *= 1 + 2 * ga; bx *= 1 + 2 * gb; by *= 1 + 2 * gb;
      ctx.setTransform(ax / img.width, ay / img.width, bx / img.height, by / img.height, ox, oy);
      ctx.drawImage(img, 0, 0);
    }
    const shadeOf = (n) => (n[1] > 0.5 ? 1 : n[1] < -0.5 ? 0.5 : Math.abs(n[2]) >= Math.abs(n[0]) ? 0.8 : 0.62);
    let leverHits = [];
    function draw() {
      if (!cw) return;
      if (!ground) ground = groundTex();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const sky = ctx.createLinearGradient(0, 0, 0, ch); sky.addColorStop(0, "#7fb6f5"); sky.addColorStop(1, "#cfe6ff");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      const vv = [cp * sy, sp, cp * cy], vis = (n) => n[0] * vv[0] + n[1] * vv[1] + n[2] * vv[2] > 1e-4;
      // ground sides, then its top
      const G = (x, y, z) => proj([x, y, z]);
      const sides = [[N, ground.sx, [fx1, 0, fz0], [fx0, 0, fz0]], [S, ground.sx, [fx0, 0, fz1], [fx1, 0, fz1]], [W, ground.sz, [fx0, 0, fz0], [fx0, 0, fz1]], [E, ground.sz, [fx1, 0, fz1], [fx1, 0, fz0]]];
      for (const [n, img, a, b] of sides) if (vis(n)) drawImg(sideShade(img, shadeOf(n)),G(a[0], 0, a[2]), G(b[0], 0, b[2]), G(a[0], -1, a[2]));
      if (vv[1] > 0) drawImg(ground.top, G(fx0, 0, fz0), G(fx1, 0, fz0), G(fx0, 0, fz1));
      // everything else, back to front
      const list = [];
      for (const f of scene.faces) {
        if (f.y > maxY || (f.show && !f.show()) || !vis(f.n)) continue;
        const P0 = proj(f.p0), P1 = proj(f.p1), P3 = proj(f.p3);
        const c = [(f.p1[0] + f.p3[0]) / 2, (f.p1[1] + f.p3[1]) / 2, (f.p1[2] + f.p3[2]) / 2];
        list.push({ f, P0, P1, P3, d: proj(c).d + (f.n === UP && f.e.t === "dust" ? 0.002 : 0) });
      }
      list.sort((a, b) => a.d - b.d);
      for (const it of list) drawImg(shaded(it.f.tex(), shadeOf(it.f.n)), it.P0, it.P1, it.P3);
      // glow from lit torches and the lamp
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "lighter";
      const s = fit * view.zoom;
      const glow = (q, r, col) => { const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r); g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(q.x - r, q.y - r, 2 * r, 2 * r); };
      for (const h of scene.heads) if (h.e.p[1] <= maxY && (h.e.t === "torch" ? h.e.lit : h.e.on)) glow(proj(h.at), s * (h.small ? 0.18 : 0.42), "rgba(255,70,30,0.55)");
      for (const l of sim.lamps) if (l.lit && l.p[1] <= maxY) glow(proj([l.p[0] + 0.5, l.p[1] + 0.5, l.p[2] + 0.5]), s * 1.1, "rgba(255,200,90,0.45)");
      ctx.globalCompositeOperation = "source-over";
      // labels
      ctx.font = `600 ${Math.round(12 * dpr)}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const lb of L.labels) {
        if (lb.at[1] - 1.5 > maxY) continue;
        const q = proj(lb.at), w = ctx.measureText(lb.text).width + 10 * dpr, h = 18 * dpr;
        ctx.fillStyle = "rgba(20,24,30,.72)"; ctx.beginPath(); (ctx.roundRect ? ctx.roundRect(q.x - w / 2, q.y - h / 2, w, h, 6 * dpr) : ctx.rect(q.x - w / 2, q.y - h / 2, w, h)); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.fillText(lb.text, q.x, q.y + 0.5);
      }
      leverHits = scene.levers.map((l) => ({ e: l.e, q: proj(l.at()), r: Math.max(14 * dpr, s * 0.45) }));
    }
    const SIDE = new Map();
    function sideShade(img, sh) { const k = img.width + "x" + sh + (img === ground.sx ? "x" : "z"); if (SIDE.has(k)) return SIDE.get(k); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); g.globalCompositeOperation = "source-atop"; g.fillStyle = `rgba(0,0,0,${1 - sh})`; g.fillRect(0, 0, c.width, c.height); SIDE.set(k, c); return c; }
    let lastW = 0;
    function resize(force) {
      const w = stage.clientWidth; if (!w || (w === lastW && force !== true)) return;
      lastW = w;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const h = Math.round(Math.max(260, Math.min(480, w * 0.68)));
      cv.style.height = h + "px"; cw = cv.width = Math.round(w * dpr); ch = cv.height = Math.round(h * dpr);
      fitScale(); draw();
    }
    new ResizeObserver(() => requestAnimationFrame(resize)).observe(stage);

    // ----- turning, zooming, clicking levers -----
    let drag = null;
    const hitLever = (ev) => { const r = cv.getBoundingClientRect(), x = (ev.clientX - r.left) * dpr, y = (ev.clientY - r.top) * dpr; let best = null, bd = 1e9; for (const h of leverHits) { const d = Math.hypot(h.q.x - x, h.q.y - y); if (d < h.r && d < bd) { bd = d; best = h.e; } } return best; };
    cv.addEventListener("pointerdown", (ev) => { drag = { x: ev.clientX, y: ev.clientY, moved: 0, pan: ev.shiftKey || ev.button === 2 }; try { cv.setPointerCapture(ev.pointerId); } catch {} });
    cv.addEventListener("pointermove", (ev) => {
      if (!drag) { cv.style.cursor = hitLever(ev) ? "pointer" : ""; return; }
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; drag.x = ev.clientX; drag.y = ev.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved < 4) return;
      cv.classList.add("drag");
      if (drag.pan) { view.px += dx; view.py += dy; } else { view.yaw += dx * 0.01; view.pitch = Math.max(0.12, Math.min(1.5, view.pitch + dy * 0.008)); }
      draw();
    });
    const end = (ev) => {
      if (!drag) return;
      cv.classList.remove("drag");
      if (drag.moved < 4) { const l = hitLever(ev); if (l) { const v = inputs(); v[l.name] = v[l.name] ? 0 : 1; setLevers(v); } }
      drag = null;
    };
    cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", () => { drag = null; cv.classList.remove("drag"); });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); view.zoom = Math.max(0.4, Math.min(6, view.zoom * (e.deltaY < 0 ? 1.12 : 0.89))); draw(); }, { passive: false });
    box.querySelector('[data-a="in"]').onclick = () => { view.zoom = Math.min(6, view.zoom * 1.25); draw(); };
    box.querySelector('[data-a="out"]').onclick = () => { view.zoom = Math.max(0.4, view.zoom / 1.25); draw(); };
    box.querySelector('[data-a="reset"]').onclick = () => { view = { ...DEF }; draw(); };
    box.querySelector("select").onchange = (e) => { maxY = Number(e.target.value); draw(); };
    apply(); info();
    box._resize = resize;
    return box;
  };
})();
