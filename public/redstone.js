// Minecraft redstone circuit designer: the Agent's "redstone_design" tool (agent.js).
// A logic expression ("(a and b) or not c") is built from NOR gates only, because a NOR gate is the one thing redstone does natively:
// the inputs run into one dust line that powers a block, and a torch on the side of that block is the output (it inverts, 1 redstone tick).
// The netlist is then simulated with that delay to get the truth table and the signal delay. A "ring clock" (an odd number of torches
// in a loop) is simulated too, for its period and for the torch burnout check. Pure logic, nothing is sent anywhere.
// redstonePlan() gives the text for the model plus a small spec; redstoneVisual(spec) draws it for the user: levers to click, wires
// that light up tick by tick, a truth table; for a clock, the ring of torches ticking (and burning out when it's too fast).
(function () {
  const MAX_VARS = 6, MAX_GATES = 60;

  // ---------- parsing ----------
  const WORDS = { and: "and", or: "or", xor: "xor", not: "not", nand: "nand", nor: "nor", xnor: "xnor" };
  const SYMS = { "&": "and", "&&": "and", "*": "and", "|": "or", "||": "or", "+": "or", "^": "xor", "!": "not", "~": "not" };
  function tokenize(src) {
    const out = [], re = /\s*(&&|\|\||[()&|^!~*+]|[A-Za-z_][A-Za-z0-9_]*)/gy;
    let m, last = 0;
    while (last < src.length && (m = re.exec(src))) { out.push(m[1]); last = re.lastIndex; }
    if (src.slice(last).trim()) throw new Error("Can't read “" + src.slice(last).trim().slice(0, 20) + "” in the expression.");
    return out;
  }
  function parse(src) {
    const t = tokenize(String(src || "")).map((x) => (WORDS[x.toLowerCase()] ? WORDS[x.toLowerCase()] : SYMS[x] || x));
    let i = 0;
    const peek = () => t[i], next = () => t[i++];
    const BIN = [["or", "nor"], ["xor", "xnor"], ["and", "nand"]];
    function level(n) {
      if (n === BIN.length) return unary();
      let l = level(n + 1);
      while (BIN[n].includes(peek())) { const op = next(); l = { op, a: l, b: level(n + 1) }; }
      return l;
    }
    function unary() {
      const x = next();
      if (x === undefined) throw new Error("The expression ends too early.");
      if (x === "not") return { op: "not", a: unary() };
      if (x === "(") { const e = level(0); if (next() !== ")") throw new Error("A closing ) is missing."); return e; }
      if (/^[A-Za-z_]\w*$/.test(x) && !WORDS[x]) return { v: x };
      throw new Error("Didn't expect “" + x + "”.");
    }
    if (!t.length) throw new Error("Give an expression like \"a xor b\".");
    const e = level(0);
    if (i < t.length) throw new Error("Didn't expect “" + t[i] + "”.");
    return e;
  }

  // ---------- NOR-only netlist ----------
  function buildNaive(ast) {
    const gates = [], memo = new Map(), vars = [];
    const gate = (ins) => {
      ins = [...new Set(ins)].sort();      // "a and a": both inputs the same wire is one input
      const k = ins.join(",");
      if (!memo.has(k)) { memo.set(k, "T" + (gates.length + 1)); gates.push({ name: memo.get(k), ins }); }
      return memo.get(k);
    };
    const byName = (n) => gates.find((g) => g.name === n);
    const NOT = (x) => { const g = byName(x); return g && g.ins.length === 1 ? g.ins[0] : gate([x]); };   // NOT(NOT x) = x
    const OR = (a, b) => NOT(gate([a, b]));
    const AND = (a, b) => gate([NOT(a), NOT(b)]);
    const XOR = (a, b) => gate([AND(a, b), gate([a, b])]);
    function go(n) {
      if (n.v) { if (!vars.includes(n.v)) vars.push(n.v); return n.v; }
      const a = go(n.a), b = n.b ? go(n.b) : null;
      switch (n.op) {
        case "not": return NOT(a);
        case "and": return AND(a, b);
        case "or": return OR(a, b);
        case "nor": return gate([a, b]);
        case "nand": return NOT(AND(a, b));
        case "xor": return XOR(a, b);
        case "xnor": return NOT(XOR(a, b));
      }
    }
    let out = go(ast);
    // keep only the torches the output needs ("not not a" leaves one behind), numbered T1, T2, ... again
    const need = new Set(), mark = (x) => { if (need.has(x)) return; need.add(x); const g = byName(x); if (g) g.ins.forEach(mark); };
    mark(out);
    const kept = gates.filter((g) => need.has(g.name)), rename = {};
    kept.forEach((g, i) => (rename[g.name] = "T" + (i + 1)));
    const rn = (x) => rename[x] || x;
    gates.length = 0; for (const g of kept) gates.push({ name: rn(g.name), ins: g.ins.map(rn) });
    out = rn(out);
    if (gates.length > MAX_GATES) throw new Error(`That needs ${gates.length} gates; keep it under ${MAX_GATES} or split it up.`);
    return { vars, gates, out };
  }
  // in the order gates are listed, every gate comes after its inputs (input names are never gate names, which start with "T" + digit)
  const isGate = (net, x) => !net.vars.includes(x);

  // A "gate" is a redstone torch (it inverts: NOT, or NOR when several wires run into its block) or, with merge: true, wires that simply
  // meet and join: an OR that costs no torch and no time.
  const gateVal = (g, val) => { const any = g.ins.some((x) => val[x]); return g.merge ? (any ? 1 : 0) : any ? 0 : 1; };
  // one redstone tick: every torch's next value follows its inputs now (a join follows at once)
  function tick(net, val) {
    const nx = { ...val };
    for (const g of net.gates) nx[g.name] = gateVal(g, val);
    return nx;
  }
  function settle(net, inputs, from) {
    let val = { ...(from || {}), ...inputs };
    for (const g of net.gates) if (!(g.name in val)) val[g.name] = 0;
    for (let t = 0; t < net.gates.length + 3 || (net.seq && t < 80); t++) {
      const nx = tick(net, val);
      if (net.gates.every((g) => nx[g.name] === val[g.name])) break;
      val = nx;
    }
    return val;
  }
  // ticks from the levers to each signal; a join adds none (for the drawing it takes a column of its own)
  function depths(net, forDrawing) {
    const d = {};
    for (const v of net.vars) d[v] = 0;
    for (let pass = 0; pass < net.gates.length + 2; pass++)
      for (const g of net.gates) { const m = Math.max(0, ...g.ins.map((x) => (x in d ? d[x] : 0))); d[g.name] = g.merge && !forDrawing ? m : m + 1; }
    return d;
  }
  const inputsOf = (net, n) => { const o = {}; net.vars.forEach((v, k) => (o[v] = (n >> (net.vars.length - 1 - k)) & 1)); return o; };
  const torchCount = (net) => net.gates.filter((g) => !g.merge).length;
  // circuits that remember (a latch) start from a known state: this lever pattern first, then everything released
  function restState(net) {
    if (!net.seq) return settle(net, Object.fromEntries(net.vars.map((v) => [v, 0])));
    let val = Object.fromEntries(net.gates.map((g) => [g.name, 1]));
    for (const phase of [net.init || {}, {}]) {
      const inp = Object.fromEntries(net.vars.map((v) => [v, phase[v] ? 1 : 0]));
      val = settle(net, inp, val);
    }
    return val;
  }

  // ---------- the practical way: the fewest torches ----------
  // What redstone does for free: wires that meet are an OR; a torch inverts. So  a OR b  needs no torch at all, NAND is two torches,
  // and XOR needs three. Every candidate below is a different way to write the same function, built with those rules; the one with
  // the fewest torches (then the shortest delay) wins. buildNaive (NOR gates only) is only kept to say how much that saves.
  const varsOf = (n, acc = []) => { if (n.v) { if (!acc.includes(n.v)) acc.push(n.v); } else { varsOf(n.a, acc); if (n.b) varsOf(n.b, acc); } return acc; };
  const evalAst = (n, env) => {
    if (n.v) return !!env[n.v];
    const a = evalAst(n.a, env), b = n.b ? evalAst(n.b, env) : false;
    switch (n.op) { case "not": return !a; case "and": return a && b; case "or": return a || b; case "xor": return a !== b; case "nand": return !(a && b); case "nor": return !(a || b); case "xnor": return a === b; }
    return false;
  };
  function structural(ast, vars) {
    const gates = [], memo = new Map();
    const torch = (parts) => { parts = [...new Set(parts)].sort(); const k = parts.join(","); if (!memo.has(k)) { memo.set(k, "T" + (gates.length + 1)); gates.push({ name: memo.get(k), ins: parts }); } return memo.get(k); };
    // a signal is known as a bundle of joined wires, for the function (p) or for its opposite (n); the other one costs one torch
    const flip = (a) => ({ get p() { return a.n; }, set p(v) { a.n = v; }, get n() { return a.p; }, set n(v) { a.p = v; } });
    const POS = (a) => a.p || (a.p = [torch(a.n)]);
    const NEG = (a) => a.n || (a.n = [torch(a.p)]);
    const go = (n) => {
      if (n.v) return { p: [n.v], n: null };
      const a = go(n.a), b = n.b ? go(n.b) : null;
      switch (n.op) {
        case "not": return flip(a);
        case "or": return { p: [...POS(a), ...POS(b)], n: null };
        case "nor": return flip({ p: [...POS(a), ...POS(b)], n: null });
        case "and": return { p: null, n: [...NEG(a), ...NEG(b)] };
        case "nand": return flip({ p: null, n: [...NEG(a), ...NEG(b)] });
        case "xor": case "xnor": {            // a XOR b = (a NOR (a NOR b)) joined with (b NOR (a NOR b)): three torches
          const ap = POS(a), bp = POS(b), t1 = torch([...ap, ...bp]);
          const x = { p: [torch([...ap, t1]), torch([...bp, t1])], n: null };
          return n.op === "xor" ? x : flip(x);
        }
      }
    };
    const parts = POS(go(ast));
    const used = new Set(), mark = (x) => { if (used.has(x)) return; used.add(x); const g = gates.find((q) => q.name === x); if (g) g.ins.forEach(mark); };
    parts.forEach(mark);
    const kept = gates.filter((g) => used.has(g.name)), rename = {};
    kept.forEach((g, i) => (rename[g.name] = "T" + (i + 1)));
    const rn = (x) => rename[x] || x, out = kept.map((g) => ({ name: rn(g.name), ins: g.ins.map(rn) }));
    let outName;
    if (parts.length === 1) outName = rn(parts[0]); else { out.push({ name: "OUT", ins: parts.map(rn), merge: true }); outName = "OUT"; }
    return { vars, gates: out, out: outName };
  }
  // Quine-McCluskey: the smallest sum of products (as the bit patterns of the inputs)
  function implicants(nv, ones) {
    let cur = new Map(ones.map((t) => [t + ":0", { v: t, m: 0 }])), primes = [];
    while (cur.size) {
      const arr = [...cur.values()], used = new Set(), nxt = new Map();
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j]; if (a.m !== b.m) continue;
        const d = a.v ^ b.v; if (d && (d & (d - 1)) === 0) { used.add(i); used.add(j); const m = a.m | d, v = a.v & ~d; nxt.set(v + ":" + m, { v, m }); }
      }
      arr.forEach((x, i) => { if (!used.has(i)) primes.push(x); });
      cur = nxt;
    }
    const covers = (p, t) => (t & ~p.m) === p.v, lits = (p) => nv - p.m.toString(2).split("1").length + 1;
    const left = new Set(ones), pick = [];
    for (const t of ones) { const c = primes.filter((p) => covers(p, t)); if (c.length === 1 && !pick.includes(c[0])) pick.push(c[0]); }
    for (const p of pick) for (const t of [...left]) if (covers(p, t)) left.delete(t);
    while (left.size) {
      let best = null, bs = -1;
      for (const p of primes) { const s = [...left].filter((t) => covers(p, t)).length * 10 - lits(p); if (s > bs) { bs = s; best = p; } }
      pick.push(best); for (const t of [...left]) if (covers(best, t)) left.delete(t);
    }
    return pick;
  }
  const fold = (items, op) => items.reduce((a, b) => ({ op, a, b }));
  function sumOfProducts(vars, ones, invert) {      // invert: the product-of-sums form (the SOP of the opposite function, complemented)
    const nv = vars.length, lit = (i, positive) => (positive ? { v: vars[i] } : { op: "not", a: { v: vars[i] } });
    const terms = implicants(nv, ones).map((p) => {
      const ls = []; for (let i = 0; i < nv; i++) { const bit = nv - 1 - i; if (p.m >> bit & 1) continue; ls.push(lit(i, invert ? !(p.v >> bit & 1) : !!(p.v >> bit & 1))); }
      return fold(ls, invert ? "or" : "and");
    });
    return fold(terms, invert ? "and" : "or");
  }
  function optimize(ast) {
    const vars = varsOf(ast), nv = vars.length, rowsN = 1 << nv, ones = [], zeros = [];
    for (let r = 0; r < rowsN; r++) { const env = {}; vars.forEach((v, k) => (env[v] = (r >> (nv - 1 - k)) & 1)); (evalAst(ast, env) ? ones : zeros).push(r); }
    if (!ones.length) throw new Error("That circuit is never on, whatever the levers do, so there is nothing to build.");
    if (!zeros.length) throw new Error("That circuit is always on, whatever the levers do, so there is nothing to build (a block of redstone does that).");
    const cands = [structural(ast, vars), structural(sumOfProducts(vars, ones, false), vars), structural(sumOfProducts(vars, zeros, true), vars)];
    let best = null, bs = Infinity;
    cands.forEach((c, idx) => { const s = torchCount(c) * 1000 + idx * 50 + (depths(c)[c.out] || 0); if (s < bs) { bs = s; best = c; } });
    return best;
  }

  const gateText = (g, isOut) => (g.merge ? `  ${g.name} = ${g.ins.join(" + ")}   (just join these dust lines: an OR, no torch)` : `  ${g.name} = ${g.ins.length === 1 ? "NOT" : "NOR"}(${g.ins.join(", ")})`) + (g.name === isOut ? "   ← the output, to the lamp" : "");
  const delayText = (d) => `${d} redstone tick${d === 1 ? "" : "s"} (${d * 2} game ticks, ${(d * 0.1).toFixed(1)} s)`;
  function describe(net, spec, expr, how, extra) {
    const nT = torchCount(net), d = depths(net)[net.out] || 0;
    const rows = [];
    if (!net.seq) for (let n = 0; n < 1 << net.vars.length; n++) { const inp = inputsOf(net, n); rows.push(net.vars.map((v) => inp[v]).join(" ") + " | " + settle(net, inp)[net.out]); }
    const text = [
      `Circuit for: ${expr}`,
      nT ? `Inputs (levers): ${net.vars.join(", ")}. ${nT} redstone torch${nT === 1 ? "" : "es"}, signal delay ${delayText(d)}.` : `Inputs (levers): ${net.vars.join(", ")}. No torches at all: just wires.`,
      how,
      "",
      ...(rows.length ? ["Truth table (" + net.vars.join(" ") + " | output, after the signal has settled):", ...rows.map((r) => "  " + r), ""] : []),
      "Wiring (each torch sits on the side of a solid block; every wire named in brackets runs into that block, and the torch is ON only while none of them is powered):",
      ...net.gates.map((g) => gateText(g, net.out)),
      ...(extra ? ["", extra] : []),
    ].join("\n");
    let built = "";
    try { built = window.redstoneLayoutText ? window.redstoneLayoutText(spec) : ""; } catch (e) { built = "(No 3D build for this one: " + e.message + " The schematic is shown instead.)"; }
    return { text: text + "\n\n" + (built ? built + "\n" : "") + "The user sees this circuit under the tool step: a 3D build they can turn and click (levers, dust lighting up tick by tick), a schematic tab" + (rows.length ? " and the truth table" : "") + ". Refer to it rather than redrawing it. Say how many torches it needs; it is already the smallest the app could find.", spec };
  }

  function design(expr) {
    const ast = parse(expr);
    const vars = varsOf(ast);
    if (vars.length > MAX_VARS) throw new Error(`Use at most ${MAX_VARS} inputs (you gave ${vars.length}).`);
    let net = optimize(ast);
    if (net.gates.length > MAX_GATES) throw new Error(`That needs ${net.gates.length} gates; keep it under ${MAX_GATES} or split it up.`);
    // a compact hand-made layout, if this function has one: the circuit is then named exactly like the picture
    let shape = null;
    if (window.redstoneTemplate) {
      const tt = []; for (let n = 0; n < 1 << net.vars.length; n++) tt.push(settle(net, inputsOf(net, n))[net.out] ? 1 : 0);
      const tpl = window.redstoneTemplate(net.vars, tt);
      if (tpl && torchCount({ gates: tpl.net.gates }) <= torchCount(net)) { net = { vars: net.vars, gates: tpl.net.gates, out: tpl.net.out }; shape = tpl.shape; }
    }
    let naive = net; try { naive = buildNaive(ast); } catch {}
    const nT = torchCount(net), nN = torchCount(naive);
    const how = nN > nT ? `Built the practical way: wires that meet are an OR (free) and a torch inverts, so this needs ${nT} torch${nT === 1 ? "" : "es"} where a plain NOR-only build would need ${nN}.` : `Built the practical way (wires that meet are an OR, a torch inverts): ${nT} torch${nT === 1 ? "" : "es"}, the fewest the app could find.`;
    const spec = { kind: "logic", expr: String(expr).trim(), vars: net.vars, gates: net.gates, out: net.out, naive: nN, ...(shape ? { shape } : {}) };
    return describe(net, spec, String(expr).trim(), how);
  }

  // circuits that remember or react to a change: written out gate by gate
  function sequential(name) {
    if (/latch|flip[- ]?flop|memory|\bsr\b|\brs\b/i.test(name)) {
      const net = { vars: ["S", "R"], gates: [{ name: "T1", ins: ["R", "T2"] }, { name: "T2", ins: ["S", "T1"] }], out: "T1", seq: true, init: { R: 1 }, test: [{ S: 0, R: 0 }, { S: 1, R: 0 }, { S: 0, R: 0 }, { S: 0, R: 1 }, { S: 0, R: 0 }, { S: 1, R: 0 }, { S: 0, R: 0 }] };
      const spec = { kind: "logic", expr: "RS latch", ...net, shape: { t: "latch" }, note: "Click S: the lamp turns on and stays on. Click R: it turns off and stays off." };
      return describe(net, spec, "RS latch (a one-bit memory)", "Two torches that feed each other: the lamp is the memory. Switch S on and off again: the lamp comes on and STAYS on. Switch R on and off again: it goes off and stays off. Don't switch S and R on at the same time.", "How it works: T1 is the output. T1 is on unless R or T2 is on; T2 is on unless S or T1 is on. Whichever one is on keeps the other off, so the state holds without any lever.");
    }
    if (/pulse|edge|one[- ]?shot|monostable/i.test(name)) {
      const net = { vars: ["a"], gates: [{ name: "T1", ins: ["a"] }, { name: "T2", ins: ["T1"] }, { name: "T3", ins: ["T1", "T2"] }], out: "T3", seq: true, init: {}, pulse: true, test: [{ a: 0 }, { a: 1 }, { a: 0 }] };
      const spec = { kind: "logic", expr: "Pulse generator", ...net, shape: { t: "pulse" }, note: "Switch the lever on: the lamp blinks once, for one redstone tick, however long the lever stays on." };
      return describe(net, spec, "Pulse generator (rising-edge detector)", "Turns a lever or button being switched ON into one short pulse (1 redstone tick = 0.1 s), however long it stays on. Use it to fire a piston or a dropper exactly once.", "How it works: T2 is the opposite of T1, but one tick later. For that single tick T1 and T2 are both off, so T3 (the output) turns on; then T2 comes on and T3 goes off again.");
    }
    return null;
  }

  // ---------- ring clock ----------
  const BURN_TICKS = 30, BURN_FLIPS = 8;     // Java: more than 8 toggles within 60 game ticks (30 redstone ticks) burns a torch out
  function ringStep(s) { const n = s.length; return s.map((_, i) => (s[(i + n - 1) % n] ? 0 : 1)); }
  const ringStart = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
  function ringClock(n) {
    n = Math.round(Number(n) || 3);
    if (n < 3 || n % 2 === 0 || n > 31) throw new Error("A torch ring needs an odd number of torches, 3 to 31 (an even ring settles and never ticks).");
    let s = ringStart(n);
    const seen = new Map();
    let t = 0, period = 0;
    while (t < 1000) {
      const key = s.join("");
      if (seen.has(key)) { period = t - seen.get(key); break; }
      seen.set(key, t); s = ringStep(s); t++;
    }
    const perTorch = (BURN_TICKS / period) * 2;
    const burn = perTorch > BURN_FLIPS;
    const text = [
      `Torch ring clock with ${n} torches`,
      `Period: ${period} redstone ticks (${period * 2} game ticks, ${(period * 0.1).toFixed(1)} s); each torch is on for half of it.`,
      `Torch burnout (Java Edition: a torch that toggles more than ${BURN_FLIPS} times within 60 game ticks burns out): each torch toggles about ${perTorch.toFixed(1)} times per 60 game ticks, so ${burn ? "THIS RING WILL BURN OUT after a few cycles. Use more torches (the period grows with the count), or slow it with repeaters." : "it stays within the limit and keeps running."}`,
      "",
      `Build: put ${n} torches in a loop, each torch on the side of a solid block, each block powered by the previous torch's dust (torch → 1 dust → block with the next torch). Tap the clock output from any one torch with a dust line. Start it by placing one torch last, or by briefly powering one block with a lever.`,
      "Longer period without more torches: put repeaters (1 to 4 ticks each) into the loop. Every repeater tick adds 2 redstone ticks to the period.",
      "The user sees the ring ticking in an animated diagram under the tool step.",
    ].join("\n");
    return { text, spec: { kind: "clock", n, period, burn } };
  }

  function plan(a) {
    a = a || {};
    const what = String(a.circuit || a.expression || "").trim();
    if (/^(ring )?(torch )?clock\b|^oscillator\b/i.test(what)) return ringClock(a.torches || (/(\d+)/.exec(what) || [])[1]);
    const q = sequential(what);
    if (q) return q;
    return design(what.replace(/^(gate|circuit|logic)\s*:\s*/i, ""));
  }
  window.redstonePlan = plan;
  window.redstoneTest = { parse, evalAst, optimize, buildNaive };   // for the self-test
  window.redstoneDesign = (a) => plan(a).text;

  // ====================================================================== the picture ======================================================================
  const NS = "http://www.w3.org/2000/svg";
  const CSS = `
.rs-vis { --rs-on: #ff3b2f; --rs-off: #6e1d16; --rs-stone: #8d8d8d; --rs-stone-d: #5f5f5f; --rs-stick: #8a6a3a; --rs-lamp-on: #ffd27a; --rs-lamp-off: #5e4429;
  border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px 12px; background: var(--soft); color: var(--fg); font-size: 13px; min-width: 0; }
.rs-vis .rs-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.rs-vis .rs-head b { font-size: 14px; }
.rs-vis .rs-head code { font-size: 13px; padding: 1px 6px; border-radius: 6px; background: var(--soft); }
.rs-vis .rs-sub { color: var(--muted); font-size: 12px; }
.rs-vis .rs-stage { overflow-x: auto; margin: 0 -4px; padding: 0 4px; }
.rs-vis svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.rs-vis svg text { fill: var(--fg); font: 600 12px system-ui, sans-serif; }
.rs-vis svg text.m { fill: var(--muted); font-weight: 500; font-size: 11px; }
.rs-vis .w { fill: none; stroke: var(--rs-off); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; transition: stroke .08s; }
.rs-vis .on .w, .rs-vis .w.on { stroke: var(--rs-on); filter: drop-shadow(0 0 3px rgba(255,59,47,.75)); }
.rs-vis .blk { fill: var(--rs-stone); stroke: var(--rs-stone-d); stroke-width: 2; }
.rs-vis .blk-in { fill: none; stroke: rgba(0,0,0,.18); stroke-width: 1; }
.rs-vis .stick { stroke: var(--rs-stick); stroke-width: 4; stroke-linecap: round; }
.rs-vis .flame { fill: var(--rs-off); transition: fill .08s; }
.rs-vis .on .flame { fill: var(--rs-on); filter: drop-shadow(0 0 5px rgba(255,59,47,.95)); }
.rs-vis .burnt .flame { fill: #2a2a2a; filter: none; }
.rs-vis .lamp { fill: var(--rs-lamp-off); stroke: #3d2b18; stroke-width: 2; transition: fill .08s; }
.rs-vis .on .lamp { fill: var(--rs-lamp-on); filter: drop-shadow(0 0 8px rgba(255,200,90,.95)); }
.rs-vis .lamp-g { stroke: rgba(0,0,0,.22); stroke-width: 1.5; }
.rs-vis .lever { cursor: pointer; outline: none; }
.rs-vis .lever .base { fill: #7a7a7a; stroke: #4a4a4a; stroke-width: 2; }
.rs-vis .lever .handle { stroke: #6b4f2a; stroke-width: 4; stroke-linecap: round; transition: transform .12s; transform-box: view-box; }
.rs-vis .lever .knob { fill: var(--rs-off); transition: fill .08s; }
.rs-vis .lever.on .knob { fill: var(--rs-on); }
.rs-vis .lever:focus-visible .base { stroke: var(--accent); stroke-width: 3; }
.rs-vis .lever:hover .base { fill: #8a8a8a; }
.rs-vis .port { fill: var(--rs-off); }
.rs-vis .mj { fill: var(--rs-off); stroke: #3a0d0a; stroke-width: 2; transition: fill .08s; }
.rs-vis .on .mj { fill: var(--rs-on); filter: drop-shadow(0 0 4px rgba(255,59,47,.8)); }
.rs-vis .on .port, .rs-vis .port.on { fill: var(--rs-on); }
.rs-vis .rs-row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; margin-top: 8px; }
.rs-vis .rs-status { flex: 1 1 180px; min-width: 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
.rs-vis .rs-status b { color: var(--fg); }
.rs-vis table { border-collapse: collapse; font: 12px ui-monospace, Consolas, monospace; }
.rs-vis th, .rs-vis td { padding: 2px 8px; text-align: center; border-bottom: 1px solid var(--line); }
.rs-vis th { color: var(--muted); font-weight: 600; }
.rs-vis th.o, .rs-vis td.o { border-left: 1px solid var(--line); }
.rs-vis tbody tr { cursor: pointer; }
.rs-vis tbody tr:hover { background: var(--soft); }
.rs-vis tbody tr.cur { background: var(--accent-soft); }
.rs-vis td.o.y { color: var(--rs-on); font-weight: 700; }
.rs-vis .rs-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.rs-vis .rs-legend span { display: inline-flex; align-items: center; gap: 6px; }
.rs-vis .rs-legend svg { margin: 0; }
.rs-vis .rs-ctl { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.rs-vis .rs-warn { color: var(--danger); font-weight: 600; }
.rs-vis .rs-inner { border: 0; padding: 0; background: none; }
.rs-vis .rs-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--soft); }
.rs-vis .rs-tabs button { font: 600 12px system-ui, sans-serif; border: 0; background: none; color: var(--muted); padding: 4px 10px; border-radius: 7px; cursor: pointer; }
.rs-vis .rs-tabs button[aria-selected="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
`;
  function styleOnce() {
    if (document.getElementById("rs-style")) return;
    const s = document.createElement("style"); s.id = "rs-style"; s.textContent = CSS; document.head.appendChild(s);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const svgEl = (w, h, inner) => `<svg xmlns="${NS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">${inner}</svg>`;
  // a block with a redstone torch on its right side; (x, y) = the block's left edge, middle
  const torchBlock = (x, y) => `<rect class="blk" x="${x}" y="${y - 16}" width="32" height="32" rx="2"/><path class="blk-in" d="M${x + 6} ${y - 8}h8M${x + 18} ${y + 4}h8M${x + 8} ${y + 9}h5"/>
    <line class="stick" x1="${x + 33}" y1="${y + 2}" x2="${x + 43}" y2="${y - 9}"/><circle class="flame" cx="${x + 45}" cy="${y - 11}" r="5"/>`;
  const lampAt = (x, y) => `<rect class="lamp" x="${x}" y="${y - 16}" width="32" height="32" rx="3"/><path class="lamp-g" d="M${x + 10.7} ${y - 16}v32M${x + 21.3} ${y - 16}v32M${x} ${y - 5.3}h32M${x} ${y + 5.3}h32"/>`;
  const leverAt = (x, y) => `<rect class="base" x="${x}" y="${y - 6}" width="24" height="14" rx="2"/><g class="handle-g"><line class="handle" x1="${x + 12}" y1="${y}" x2="${x + 12}" y2="${y - 18}"/><circle class="knob" cx="${x + 12}" cy="${y - 19}" r="4"/></g>`;

  function legend(items) {
    const box = document.createElement("div"); box.className = "rs-legend";
    for (const [pic, w, h, label] of items) { const s = document.createElement("span"); s.innerHTML = svgEl(w, h, pic); s.append(label); box.appendChild(s); }
    return box;
  }

  // ---------- logic circuit: the 3D build (redstone3d.js) and the schematic, in two tabs ----------
  function logicVisual(spec) {
    const d3 = window.redstone3D ? window.redstone3D(spec) : null, sch = schematic(spec);
    if (!d3) return sch;
    const box = document.createElement("div"); box.className = "rs-vis";
    let d = depths({ vars: spec.vars, gates: spec.gates, out: spec.out })[spec.out] || 0;
    try { d = window.redstoneLayout(spec).delay; } catch {}      // the build's own delay, repeaters included
    box.innerHTML = `<div class="rs-head"><b>Redstone circuit</b><code></code><span class="rs-sub"></span><span style="flex:1"></span><span class="rs-tabs" role="tablist"><button type="button" role="tab" data-t="3d" aria-selected="true">3D build</button><button type="button" role="tab" data-t="sch" aria-selected="false">Schematic</button></span></div>`;
    box.querySelector("code").textContent = spec.expr;
    const nT = spec.gates.filter((g) => !g.merge).length;
    box.querySelector(".rs-sub").textContent = `${nT} torch${nT === 1 ? "" : "es"}${spec.naive > nT ? ` (a plain NOR-only build: ${spec.naive})` : ""} · up to ${d} tick${d === 1 ? "" : "s"} delay (${(d * 0.1).toFixed(1)} s)`;
    sch.classList.add("rs-inner"); sch.querySelector(".rs-head").remove(); sch.hidden = true;
    box.append(d3, sch);
    box.querySelectorAll(".rs-tabs button").forEach((b) => (b.onclick = () => {
      const t = b.dataset.t;
      box.querySelectorAll(".rs-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      d3.hidden = t !== "3d"; sch.hidden = t !== "sch";
      if (t === "3d" && d3._resize) d3._resize();
    }));
    return box;
  }
  function schematic(spec) {
    const net = { vars: spec.vars, gates: spec.gates, out: spec.out, seq: spec.seq, init: spec.init };
    const dep = depths(net, true), maxD = Math.max(0, ...net.gates.map((g) => dep[g.name]));
    const COLW = 150, ROWH = 84, LEFT = 22, TOP = 62;
    // columns: levers, then the torches by how many ticks from the levers they are, then the lamp
    const cols = [net.vars.slice()];
    for (let k = 1; k <= maxD; k++) cols.push(net.gates.filter((g) => dep[g.name] === k).map((g) => g.name));
    const lampCol = maxD + 1;
    const rows = Math.max(1, ...cols.map((c) => c.length));
    const slot = {};
    cols.forEach((c, k) => {
      if (k > 0) {
        const mean = (n) => { const g = net.gates.find((x) => x.name === n); return g.ins.reduce((s, x) => s + slot[x], 0) / g.ins.length; };
        c.sort((p, q) => mean(p) - mean(q));
      }
      const off = Math.floor((rows - c.length) / 2);
      c.forEach((n, i) => (slot[n] = off + i));
    });
    const colOf = (n) => dep[n] || 0;
    const X = (c) => LEFT + c * COLW, Y = (s) => TOP + s * ROWH;
    const outX = (n) => X(colOf(n)) + (!isGate(net, n) ? 28 : (net.gates.find((g) => g.name === n) || {}).merge ? 34 : 52);
    const W = X(lampCol) + 34 + LEFT, H = Y(rows - 1) + 46;
    // wires: from a source's output to a torch block's left side (or to the lamp). One column apart: through the gap between the
    // columns. Further: up into the free strip between rows, across, then down into the block, so no wire runs through a block.
    const lanes = {}, gapLanes = {};
    const lane = (k) => (lanes[k] = (lanes[k] || 0) + 1) - 1;
    const wires = [];
    function wire(src, dc, dy, key) {
      const sx = outX(src), sy = Y(slot[src]), dx = X(dc), sc = colOf(src);
      let d;
      if (dc - sc === 1) { const cx = dx - 14 - lane(dc) * 7; d = `M${sx} ${sy}H${cx}V${dy}H${dx}`; }
      else {
        const c1 = sx + 10 + lane(sc + 1) * 7, gk = Math.round((dy - TOP) / ROWH);
        const gy = TOP + (gk - 0.5) * ROWH + ((gapLanes[gk] = (gapLanes[gk] || 0) + 1) - 1) * 5, c2 = dx - 14 - lane(dc) * 7;
        d = `M${sx} ${sy}H${c1}V${gy}H${c2}V${dy}H${dx}`;
      }
      wires.push({ src, d, key });
    }
    for (const g of net.gates) g.ins.forEach((x, j) => wire(x, colOf(g.name), Y(slot[g.name]) + (j - (g.ins.length - 1) / 2) * 12, g.name));
    wire(net.out, lampCol, Y(slot[net.out]), "lamp");

    let inner = `<text class="m" x="${X(0)}" y="18">Levers</text>` + (maxD ? `<text class="m" x="${X(1)}" y="18">Torches →  1 tick per column</text>` : "") + `<text class="m" x="${X(lampCol) - 4}" y="18">Lamp</text>`;
    inner += wires.map((w, i) => `<g data-w="${i}"><path class="w" d="${w.d}"/></g>`).join("");
    for (const g of net.gates) {
      const x = X(colOf(g.name)), y = Y(slot[g.name]);
      inner += `<g data-n="${esc(g.name)}">${g.ins.map((_, j) => `<circle class="port" data-p="${j}" cx="${x}" cy="${y + (j - (g.ins.length - 1) / 2) * 12}" r="3"/>`).join("")}${g.merge ? `<path class="w" d="M${x} ${y}H${x + 34}"/><circle class="mj" cx="${x + 17}" cy="${y}" r="8"/>` : torchBlock(x, y)}</g>
        <text x="${x + 16}" y="${y + 32}" text-anchor="middle">${g.merge ? "join" : esc(g.name)}</text><text class="m" x="${x + 16}" y="${y + 45}" text-anchor="middle">${g.merge ? "wires meet = OR" : g.ins.length === 1 ? "NOT" : "NOR"}</text>`;
    }
    for (const v of net.vars) {
      const x = X(0), y = Y(slot[v]);
      inner += `<g class="lever" data-v="${esc(v)}" tabindex="0" role="switch" aria-checked="false" aria-label="Lever ${esc(v)}">${leverAt(x, y)}<rect x="${x - 6}" y="${y - 30}" width="36" height="46" fill="transparent"/></g><text x="${x + 12}" y="${y + 26}" text-anchor="middle">${esc(v)}</text>`;
    }
    inner += `<g data-lamp>${lampAt(X(lampCol), Y(slot[net.out]))}</g><text class="m" x="${X(lampCol) + 16}" y="${Y(slot[net.out]) + 32}" text-anchor="middle">output</text>`;

    const box = document.createElement("div"); box.className = "rs-vis";
    const d = depths(net)[net.out] || 0;
    box.innerHTML = `<div class="rs-head"><b>Redstone circuit</b><code></code><span class="rs-sub"></span></div><div class="rs-stage">${svgEl(W, H, inner)}</div>
      <div class="rs-row"><div class="rs-status"></div><table><thead><tr>${net.vars.map((v) => `<th>${esc(v)}</th>`).join("")}<th class="o">lamp</th></tr></thead><tbody></tbody></table></div>`;
    box.querySelector("code").textContent = spec.expr;
    { const nT = net.gates.filter((g) => !g.merge).length; box.querySelector(".rs-sub").textContent = `${nT} torch${nT === 1 ? "" : "es"} · ${d} tick${d === 1 ? "" : "s"} delay (${(d * 0.1).toFixed(1)} s)`; }
    const svg = box.querySelector("svg"); svg.setAttribute("aria-label", `Circuit diagram for ${spec.expr}: click the levers`);
    const status = box.querySelector(".rs-status"), tbody = box.querySelector("tbody");
    const table = [];
    if (net.seq) box.querySelector("table").hidden = true;
    else for (let n = 0; n < 1 << net.vars.length; n++) { const inp = inputsOf(net, n); table.push(settle(net, inp)[net.out]); }
    if (!net.seq) tbody.innerHTML = table.map((o, n) => { const inp = inputsOf(net, n); return `<tr data-row="${n}">${net.vars.map((v) => `<td>${inp[v]}</td>`).join("")}<td class="o${o ? " y" : ""}">${o ? "ON" : "off"}</td></tr>`; }).join("");

    let inputs = Object.fromEntries(net.vars.map((v) => [v, 0])), val = restState(net), timer = null, ticks = 0;
    const rowNo = () => net.vars.reduce((s, v) => s * 2 + inputs[v], 0);
    function paint(settling) {
      wires.forEach((w, i) => svg.querySelector(`[data-w="${i}"]`).classList.toggle("on", !!val[w.src]));
      for (const g of net.gates) {
        const el = svg.querySelector(`[data-n="${g.name}"]`);
        el.classList.toggle("on", !!val[g.name]);
        g.ins.forEach((x, j) => el.querySelector(`[data-p="${j}"]`).classList.toggle("on", !!val[x]));
      }
      for (const v of net.vars) {
        const el = svg.querySelector(`[data-v="${v}"]`), on = !!inputs[v];
        el.classList.toggle("on", on); el.setAttribute("aria-checked", String(on));
        el.querySelector(".handle-g").setAttribute("transform", `rotate(${on ? 35 : -35} ${X(0) + 12} ${Y(slot[v])})`);
      }
      svg.querySelector("[data-lamp]").classList.toggle("on", !!val[net.out]);
      const r = rowNo();
      tbody.querySelectorAll("tr").forEach((tr) => tr.classList.toggle("cur", Number(tr.dataset.row) === r));
      const lit = net.gates.filter((g) => val[g.name]).map((g) => g.name);
      status.innerHTML = (net.seq ? `<b>Click the levers</b>. ${spec.note || ""} ` : `<b>Click a lever</b> (or a row of the table) to switch it. Each torch is <b>on</b> only while <b>none</b> of the wires into its block is powered. `) +
        (settling ? `<br><b>Tick ${ticks}</b>: the signal is still moving…` : `<br>Lamp is <b>${val[net.out] ? "ON" : "off"}</b>${ticks ? ` (settled after ${ticks} tick${ticks === 1 ? "" : "s"})` : ""}. Lit torches: ${lit.length ? lit.join(", ") : "none"}.`);
    }
    // the levers change at once; the torches follow one redstone tick at a time, slowed down so you can watch it travel
    function setInputs(next) {
      inputs = next; ticks = 0; clearInterval(timer);
      const run = () => {
        const nx = tick(net, { ...val, ...inputs });
        const moving = net.gates.some((g) => nx[g.name] !== val[g.name]) || net.vars.some((v) => val[v] !== inputs[v]);
        if (!moving || !box.isConnected) { clearInterval(timer); timer = null; val = { ...val, ...inputs }; paint(false); return; }
        val = nx; ticks++; paint(true);
      };
      val = { ...val, ...inputs }; paint(true); timer = setInterval(run, 260);
    }
    svg.querySelectorAll(".lever").forEach((el) => {
      const flip = () => setInputs({ ...inputs, [el.dataset.v]: inputs[el.dataset.v] ? 0 : 1 });
      el.addEventListener("click", flip);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
    });
    tbody.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => setInputs(inputsOf(net, Number(tr.dataset.row)))));
    paint(false);

    box.appendChild(legend([
      [`<g class="lever on" style="pointer-events:none">${leverAt(4, 24)}</g>`, 32, 30, "Lever: an input (click the ones in the diagram)"],
      [torchBlock(2, 18), 54, 34, "Block + redstone torch: a NOT gate (NOR with two wires in)"],
      [`<path class="w" d="M2 10H30"/><path class="w on" d="M38 10H66"/>`, 68, 20, "Redstone dust: dark = off, bright = powered"],
      [lampAt(2, 18), 36, 36, "Redstone lamp: the output"],
    ]));
    return box;
  }

  // ---------- ring clock ----------
  function clockVisual(spec) {
    const n = spec.n, R = Math.max(70, n * 13), C = R + 44, size = C * 2;
    const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const pt = (i, r) => [C + r * Math.cos(ang(i)), C + r * Math.sin(ang(i))];
    let inner = "";
    for (let i = 0; i < n; i++) {   // the dust from torch i to the block of torch i+1, along the ring
      const [x1, y1] = pt(i, R), [x2, y2] = pt((i + 1) % n, R);
      inner += `<g data-w="${i}"><path class="w" d="M${x1.toFixed(1)} ${y1.toFixed(1)}A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}"/></g>`;
    }
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i, R), deg = (ang(i) * 180) / Math.PI + 90;
      inner += `<g data-t="${i}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)}) scale(.8) translate(-22 0)">${torchBlock(-6, 0)}</g>`;
    }
    inner += `<text x="${C}" y="${C - 4}" text-anchor="middle">${n} torches</text><text class="m" x="${C}" y="${C + 14}" text-anchor="middle">period ${spec.period} ticks</text>`;
    const box = document.createElement("div"); box.className = "rs-vis";
    box.innerHTML = `<div class="rs-head"><b>Torch ring clock</b><span class="rs-sub"></span></div><div class="rs-stage">${svgEl(size, size, inner)}</div>
      <div class="rs-row"><div class="rs-status"></div><div class="rs-ctl"><button type="button" class="btn small" data-a="play">Pause</button><button type="button" class="btn small" data-a="speed">Real speed</button><button type="button" class="btn small" data-a="reset">Restart</button></div></div>`;
    box.querySelector(".rs-sub").textContent = `${spec.period} redstone ticks per cycle = ${(spec.period * 0.1).toFixed(1)} s`;
    const svg = box.querySelector("svg"); svg.setAttribute("aria-label", `A ring of ${n} redstone torches, each powering the next one's block`);
    const status = box.querySelector(".rs-status"), bPlay = box.querySelector('[data-a="play"]'), bSpeed = box.querySelector('[data-a="speed"]');
    let s, t, flips, burnt, timer = null, playing = true, slow = true;
    function reset() { s = ringStart(n); t = 0; flips = Array.from({ length: n }, () => []); burnt = Array(n).fill(false); paint(); }
    function paint() {
      for (let i = 0; i < n; i++) {
        svg.querySelector(`[data-t="${i}"]`).classList.toggle("on", !!s[i] && !burnt[i]);
        svg.querySelector(`[data-t="${i}"]`).classList.toggle("burnt", burnt[i]);
        svg.querySelector(`[data-w="${i}"]`).classList.toggle("on", !!s[i] && !burnt[i]);
      }
      const gone = burnt.filter(Boolean).length;
      status.innerHTML = `Each torch powers the <b>next</b> torch's block, which turns that torch <b>off</b>; an odd count never settles, so it keeps flipping around the ring. Tick ${t}.` +
        (gone ? `<br><span class="rs-warn">A torch burned out</span> (it toggled more than ${BURN_FLIPS} times in 60 game ticks) and the clock stopped. Use more torches, or repeaters in the ring.`
          : spec.burn ? `<br><span class="rs-warn">This ring is too fast: a torch will burn out in a moment.</span>` : `<br>Slow enough: no torch burns out.`);
    }
    function step() {
      if (!box.isConnected) { clearInterval(timer); timer = null; return; }
      if (burnt.some(Boolean)) return;
      const nx = ringStep(s); t++;
      for (let i = 0; i < n; i++) if (nx[i] !== s[i]) { flips[i].push(t); flips[i] = flips[i].filter((x) => x > t - BURN_TICKS); if (flips[i].length > BURN_FLIPS) burnt[i] = true; }
      s = nx.map((v, i) => (burnt[i] ? 0 : v)); paint();
      if (burnt.some(Boolean)) { playing = false; bPlay.textContent = "Play"; clearInterval(timer); timer = null; }
    }
    function start() { clearInterval(timer); timer = playing ? setInterval(step, slow ? 400 : 100) : null; }
    bPlay.onclick = () => { if (burnt.some(Boolean)) reset(); playing = !playing; bPlay.textContent = playing ? "Pause" : "Play"; start(); };
    bSpeed.onclick = () => { slow = !slow; bSpeed.textContent = slow ? "Real speed" : "Slow motion"; start(); };
    box.querySelector('[data-a="reset"]').onclick = () => { reset(); playing = true; bPlay.textContent = "Pause"; start(); };
    box._resume = () => { if (playing && !timer) start(); };
    reset(); start();
    box.appendChild(legend([
      [torchBlock(2, 18), 54, 34, "Block + redstone torch"],
      [`<path class="w" d="M2 10H30"/><path class="w on" d="M38 10H66"/>`, 68, 20, "Redstone dust: dark = off, bright = powered"],
    ]));
    return box;
  }

  // one picture per spec, kept while the chat card is redrawn so the levers you set stay set
  const made = new WeakMap();
  window.redstoneVisual = function (spec) {
    if (!spec || typeof document === "undefined") return null;
    styleOnce();
    let el = made.get(spec);
    if (!el) { el = spec.kind === "clock" ? clockVisual(spec) : logicVisual(spec); made.set(spec, el); }
    else if (el._resume) setTimeout(el._resume, 0);
    return el;
  };
})();
