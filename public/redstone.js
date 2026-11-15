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
  function build(ast) {
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

  // one redstone tick: every torch's next value is the NOR of its inputs now
  function tick(net, val) {
    const nx = { ...val };
    for (const g of net.gates) nx[g.name] = g.ins.some((x) => val[x]) ? 0 : 1;
    return nx;
  }
  function settle(net, inputs, from) {
    let val = { ...(from || {}), ...inputs };
    for (const g of net.gates) if (!(g.name in val)) val[g.name] = 0;
    for (let t = 0; t < net.gates.length + 3; t++) {
      const nx = tick(net, val);
      if (net.gates.every((g) => nx[g.name] === val[g.name])) break;
      val = nx;
    }
    return val;
  }
  function depths(net) {
    const d = {};
    for (const v of net.vars) d[v] = 0;
    for (const g of net.gates) d[g.name] = 1 + Math.max(...g.ins.map((x) => d[x]));
    return d;
  }
  const inputsOf = (net, n) => { const o = {}; net.vars.forEach((v, k) => (o[v] = (n >> (net.vars.length - 1 - k)) & 1)); return o; };

  function design(expr) {
    const ast = parse(expr), net = build(ast);
    if (net.vars.length > MAX_VARS) throw new Error(`Use at most ${MAX_VARS} inputs (you gave ${net.vars.length}).`);
    const rows = [];
    for (let n = 0; n < 1 << net.vars.length; n++) { const inp = inputsOf(net, n); rows.push(net.vars.map((v) => inp[v]).join(" ") + " | " + settle(net, inp)[net.out]); }
    const wiring = net.gates.map((g) => `  ${g.name} = ${g.ins.length === 1 ? "NOT" : "NOR"}(${g.ins.join(", ")})` + (g.name === net.out ? "   ← output, to the lamp" : "")).join("\n");
    const d = depths(net)[net.out] || 0;
    const text = [
      `Circuit for: ${String(expr).trim()}`,
      net.gates.length ? `Inputs (levers): ${net.vars.join(", ")}. ${net.gates.length} torch${net.gates.length === 1 ? "" : "es"} on ${net.gates.length} solid block${net.gates.length === 1 ? "" : "s"}, signal delay ${d} redstone tick${d === 1 ? "" : "s"} (${d * 2} game ticks, ${(d * 0.1).toFixed(1)} s).` : `The output is just the input ${net.out}: no torches needed.`,
      "",
      "Truth table (" + net.vars.join(" ") + " | output, after the signal has settled):",
      ...rows.map((r) => "  " + r),
      "",
      "Torches (T1, T2, ...): each one is a solid block with a redstone torch on its side. The dust lines named in brackets run into that block. The torch is ON only while none of them is powered (one input = NOT, two = NOR). A torch's output is dust leading away from it:",
      wiring,
      "",
    ].join("\n");
    const spec = { kind: "logic", expr: String(expr).trim(), vars: net.vars, gates: net.gates, out: net.out };
    let built = "";
    try { built = window.redstoneLayoutText ? window.redstoneLayoutText(spec) : ""; } catch (e) { built = "(No 3D build for this one: " + e.message + " The schematic is shown instead.)"; }
    return { text: text + "\n\n" + (built ? built + "\n" : "") + "The user sees this circuit under the tool step: a 3D build they can turn and click (levers, dust lighting up tick by tick), a schematic tab and the truth table. Refer to it rather than redrawing it.", spec };
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
    return design(what.replace(/^(gate|circuit|logic)\s*:\s*/i, ""));
  }
  window.redstonePlan = plan;
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
    box.querySelector(".rs-sub").textContent = `${spec.gates.length} torch${spec.gates.length === 1 ? "" : "es"} · up to ${d} tick${d === 1 ? "" : "s"} delay (${(d * 0.1).toFixed(1)} s)`;
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
    const net = { vars: spec.vars, gates: spec.gates, out: spec.out };
    const dep = depths(net), maxD = Math.max(0, ...net.gates.map((g) => dep[g.name]));
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
    const outX = (n) => X(colOf(n)) + (isGate(net, n) ? 52 : 28);
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
      inner += `<g data-n="${esc(g.name)}">${g.ins.map((_, j) => `<circle class="port" data-p="${j}" cx="${x}" cy="${y + (j - (g.ins.length - 1) / 2) * 12}" r="3"/>`).join("")}${torchBlock(x, y)}</g>
        <text x="${x + 16}" y="${y + 32}" text-anchor="middle">${esc(g.name)}</text><text class="m" x="${x + 16}" y="${y + 45}" text-anchor="middle">${g.ins.length === 1 ? "NOT" : "NOR"}</text>`;
    }
    for (const v of net.vars) {
      const x = X(0), y = Y(slot[v]);
      inner += `<g class="lever" data-v="${esc(v)}" tabindex="0" role="switch" aria-checked="false" aria-label="Lever ${esc(v)}">${leverAt(x, y)}<rect x="${x - 6}" y="${y - 30}" width="36" height="46" fill="transparent"/></g><text x="${x + 12}" y="${y + 26}" text-anchor="middle">${esc(v)}</text>`;
    }
    inner += `<g data-lamp>${lampAt(X(lampCol), Y(slot[net.out]))}</g><text class="m" x="${X(lampCol) + 16}" y="${Y(slot[net.out]) + 32}" text-anchor="middle">output</text>`;

    const box = document.createElement("div"); box.className = "rs-vis";
    const d = dep[net.out] || 0;
    box.innerHTML = `<div class="rs-head"><b>Redstone circuit</b><code></code><span class="rs-sub"></span></div><div class="rs-stage">${svgEl(W, H, inner)}</div>
      <div class="rs-row"><div class="rs-status"></div><table><thead><tr>${net.vars.map((v) => `<th>${esc(v)}</th>`).join("")}<th class="o">lamp</th></tr></thead><tbody></tbody></table></div>`;
    box.querySelector("code").textContent = spec.expr;
    box.querySelector(".rs-sub").textContent = `${net.gates.length} torch${net.gates.length === 1 ? "" : "es"} · ${d} tick${d === 1 ? "" : "s"} delay (${(d * 0.1).toFixed(1)} s)`;
    const svg = box.querySelector("svg"); svg.setAttribute("aria-label", `Circuit diagram for ${spec.expr}: click the levers`);
    const status = box.querySelector(".rs-status"), tbody = box.querySelector("tbody");
    const table = [];
    for (let n = 0; n < 1 << net.vars.length; n++) { const inp = inputsOf(net, n); table.push(settle(net, inp)[net.out]); }
    tbody.innerHTML = table.map((o, n) => { const inp = inputsOf(net, n); return `<tr data-row="${n}">${net.vars.map((v) => `<td>${inp[v]}</td>`).join("")}<td class="o${o ? " y" : ""}">${o ? "ON" : "off"}</td></tr>`; }).join("");

    let inputs = Object.fromEntries(net.vars.map((v) => [v, 0])), val = settle(net, inputs), timer = null, ticks = 0;
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
      status.innerHTML = `<b>Click a lever</b> (or a row of the table) to switch it. Each torch is <b>on</b> only while <b>none</b> of the wires into its block is powered. ` +
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
