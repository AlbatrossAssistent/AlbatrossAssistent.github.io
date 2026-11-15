// Minecraft redstone circuit designer: the Agent's "redstone_design" tool (agent.js).
// A logic expression ("(a and b) or not c") is built from NOR gates only, because a NOR gate is the one thing redstone does natively:
// the inputs run into one dust line that powers a block, and a torch on the side of that block is the output (it inverts, 1 redstone tick).
// The netlist is then simulated with that delay to get the truth table and the signal delay. A "ring clock" (an odd number of torches
// in a loop) is simulated too, for its period and for the torch burnout check. Pure logic, nothing is sent anywhere.
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
  function build(ast) {
    const gates = [], memo = new Map(), vars = [];
    const gate = (ins) => {
      ins = [...ins].sort();
      const k = ins.join(",");
      if (!memo.has(k)) { memo.set(k, "g" + (gates.length + 1)); gates.push({ name: memo.get(k), ins }); }
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
    const out = go(ast);
    if (gates.length > MAX_GATES) throw new Error(`That needs ${gates.length} gates; keep it under ${MAX_GATES} or split it up.`);
    return { vars, gates, out };
  }

  // one redstone tick for every torch: each gate's next value is the NOR of its inputs now
  function settle(net, inputs) {
    const val = { ...inputs };
    for (const g of net.gates) val[g.name] = 0;
    let t = 0;
    for (; t < net.gates.length + 3; t++) {
      const nx = {};
      for (const g of net.gates) nx[g.name] = g.ins.some((x) => val[x]) ? 0 : 1;
      let same = true;
      for (const g of net.gates) if (nx[g.name] !== val[g.name]) same = false;
      Object.assign(val, nx);
      if (same) break;
    }
    return val;
  }
  function depth(net) {
    const d = {};
    for (const v of net.vars) d[v] = 0;
    for (const g of net.gates) d[g.name] = 1 + Math.max(...g.ins.map((x) => d[x]));   // gates are listed after their inputs
    return d[net.out] || 0;
  }

  function design(expr) {
    const ast = parse(expr), net = build(ast);
    if (net.vars.length > MAX_VARS) throw new Error(`Use at most ${MAX_VARS} inputs (you gave ${net.vars.length}).`);
    const rows = [];
    for (let n = 0; n < 1 << net.vars.length; n++) {
      const inp = {};
      net.vars.forEach((v, k) => (inp[v] = (n >> (net.vars.length - 1 - k)) & 1));
      rows.push(net.vars.map((v) => inp[v]).join(" ") + " | " + settle(net, inp)[net.out]);
    }
    const label = (x) => (net.vars.includes(x) ? x : "[" + x + "]");
    const wiring = net.gates.map((g) => `  ${g.name} = NOR(${g.ins.map(label).join(", ")})` + (g.name === net.out ? "   ← output" : "")).join("\n");
    const d = depth(net);
    return [
      `Circuit for: ${String(expr).trim()}`,
      net.gates.length ? `Inputs: ${net.vars.join(", ")}. ${net.gates.length} NOR gate${net.gates.length === 1 ? "" : "s"} (${net.gates.length} torches, ${net.gates.length} solid blocks), signal delay ${d} redstone tick${d === 1 ? "" : "s"} (${d * 2} game ticks, ${(d * 0.1).toFixed(1)} s).` : `The output is just the input ${net.out}: no gates needed.`,
      "",
      "Truth table (" + net.vars.join(" ") + " | output, after the signal has settled):",
      ...rows.map((r) => "  " + r),
      "",
      "Wiring: one NOR gate = every input's dust line runs into one dust piece that powers a solid block; a redstone torch on the side of that block is the gate's output (the torch is on while the block is NOT powered). Put 1 piece of dust after the torch, or on top of the block's neighbour, to carry the output. Inputs are levers/buttons/plates:",
      wiring,
      "",
      "Build: lay the gates in a row from the inputs to the output, in the order above. Leave one block between neighbouring torches so they don't power each other, and run a repeater when a dust line is longer than 15 blocks (a repeater adds 1 tick of delay). Test every row of the table with levers before you hide it. Gate layout is the same for Java and Bedrock; only quasi-connectivity (pistons, droppers and dispensers powered diagonally from above) differs, so keep pistons off the wiring.",
    ].join("\n");
  }

  // ---------- ring clock ----------
  function ringClock(n) {
    n = Math.round(Number(n) || 3);
    if (n < 3 || n % 2 === 0 || n > 31) throw new Error("A torch ring needs an odd number of torches, 3 to 31 (an even ring settles and never ticks).");
    let s = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
    const seen = new Map();
    let t = 0, period = 0, flips = 0;
    while (t < 1000) {
      const key = s.join("");
      if (seen.has(key)) { period = t - seen.get(key); break; }
      seen.set(key, t);
      const nx = s.map((_, i) => (s[(i + n - 1) % n] ? 0 : 1));
      if (nx[0] !== s[0]) flips++;
      s = nx; t++;
    }
    const perTorch = (30 / period) * 2;   // toggles per 30 redstone ticks (= 60 game ticks) for one torch
    const burn = perTorch > 8;
    return [
      `Torch ring clock with ${n} torches`,
      `Period: ${period} redstone ticks (${period * 2} game ticks, ${(period * 0.1).toFixed(1)} s); each torch is on for half of it.`,
      `Torch burnout (Java Edition: a torch that toggles more than 8 times within 60 game ticks burns out): each torch toggles about ${perTorch.toFixed(1)} times per 60 game ticks, so ${burn ? "THIS RING WILL BURN OUT after a few cycles. Use more torches (the period grows with the count), or slow it with repeaters." : "it stays within the limit and keeps running."}`,
      "",
      `Build: put ${n} torches in a loop, each torch on the side of a solid block, each block powered by the previous torch's dust (torch → 1 dust → block with the next torch). Tap the clock output from any one torch with a dust line. Start it by placing one torch last, or by briefly powering one block with a lever.`,
      "Longer period without more torches: put repeaters (1 to 4 ticks each) into the loop. Every repeater tick adds 2 redstone ticks to the period.",
    ].join("\n");
  }

  window.redstoneDesign = function (a) {
    a = a || {};
    const what = String(a.circuit || a.expression || "").trim();
    if (/^(ring )?(torch )?clock\b|^oscillator\b/i.test(what)) return ringClock(a.torches || (/(\d+)/.exec(what) || [])[1]);
    return design(what.replace(/^(gate|circuit|logic)\s*:\s*/i, ""));
  };
})();
