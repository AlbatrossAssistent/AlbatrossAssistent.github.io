"use strict";
// A small QR code maker (no library): text -> an SVG picture a phone camera can scan. Byte mode, error correction level M
// (about 15% of the code can be damaged), versions 1 to 10 (up to 213 bytes, plenty for a connect link), the mask with the
// lowest penalty. Used for the "scan to connect" codes in Settings → Connection and in the control center.
//   qrSvg(text, { dark, light }) -> "<svg …>"     qrMatrix(text) -> rows of true/false (for tests)
(function (root) {
  // per version (1-10): EC codewords per block, then [count, data codewords] for each block group (level M)
  const EC = [null, [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  // Galois field 256 for Reed-Solomon
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsRemainder(data, n) {
    let gen = [1];
    for (let i = 0; i < n; i++) { const next = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); } gen = next; }
    const rem = new Array(n).fill(0);
    for (const b of data) { const f = b ^ rem[0]; rem.shift(); rem.push(0); for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], f); }
    return rem;
  }
  const utf8 = (s) => Array.from(new TextEncoder().encode(String(s)));

  function qrMatrix(text) {
    const bytes = utf8(text);
    let v = 1;
    const capacity = (ver) => EC[ver].slice(1).reduce((s, [c, d]) => s + c * d, 0);
    while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > capacity(v) * 8) v++;
    if (v > 10) throw new Error("Text too long for a QR code");
    const total = capacity(v);
    // the bits: mode (byte), length, the bytes, terminator, then padding
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
    put(0, Math.min(4, total * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let p = 0; data.length < total; p++) data.push(p % 2 ? 0x11 : 0xec);
    // split into blocks, add error correction, interleave
    const ecLen = EC[v][0], blocks = [];
    let k = 0;
    for (const [count, len] of EC[v].slice(1)) for (let c = 0; c < count; c++) { const d = data.slice(k, k + len); k += len; blocks.push({ d, e: rsRemainder(d, ecLen) }); }
    const out = [];
    const maxD = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);

    const size = 17 + 4 * v;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));     // modules that aren't data
    const set = (x, y, dark) => { m[y][x] = !!dark; fn[y][x] = true; };
    // finder patterns with their separators
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4);
      }
    // timing lines
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // alignment patterns (not on top of the finders)
    const al = ALIGN[v];
    for (const ay of al) for (const ax of al) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al[al.length - 1]) || (ax === al[al.length - 1] && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // format (filled in after masking) and version areas are reserved now
    const formatBits = (mask) => { const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); return ((d << 10) | r) ^ 0x5412; };
    const drawFormat = (mask) => {
      const b = formatBits(mask), bit = (i) => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (v >= 7) {
      let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const b = (v << 12) | r;
      for (let i = 0; i < 18; i++) { const bit = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, bit); set(c, a, bit); }
    }
    // the data, in the zigzag from the bottom right, two columns at a time, skipping the timing column
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        m[y][x] = bi < out.length * 8 ? ((out[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1 : false; bi++;
      }
    }
    // try the 8 masks, keep the one with the lowest penalty
    const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    const apply = (mask) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASK[mask](x, y)) m[y][x] = !m[y][x]; };
    const penalty = () => {
      let p = 0, dark = 0;
      const line = (get) => { for (let a = 0; a < size; a++) { let run = 1; let s = ""; for (let b = 0; b < size; b++) { const c = get(a, b); s += c ? "1" : "0"; if (b && c === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } p += 40 * ((s.match(/(?=10111010000|00001011101)/g) || []).length); } };
      line((a, b) => m[a][b]); line((a, b) => m[b][a]);
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
      for (const row of m) for (const c of row) if (c) dark++;
      return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    };
    let best = 0, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) { apply(mask); drawFormat(mask); const p = penalty(); if (p < bestP) { bestP = p; best = mask; } apply(mask); }
    apply(best); drawFormat(best);
    return m;
  }

  function qrSvg(text, opt = {}) {
    const m = qrMatrix(text), n = m.length, q = 4, dark = opt.dark || "#000", light = opt.light || "#fff";
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }
  root.qrSvg = qrSvg; root.qrMatrix = qrMatrix;
  if (typeof module !== "undefined" && module.exports) module.exports = { qrSvg, qrMatrix };
})(typeof window !== "undefined" ? window : globalThis);
