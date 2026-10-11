// Toolbox for the Challenge tool: the things you'd do by hand to dig a hidden word, message or flag out of a puzzle file
// (strings, hex view, decoders, simple ciphers, archives, PNG/JPEG details, hidden characters, image bits).
// Everything runs in your browser on the file you picked; the file itself never leaves your device.
// Each tool takes (ctx, args) and returns text for the AI to read: ctx = { bytes, root, name, outputs: [text of every step], entry }.
(function (g) {
  "use strict";
  const MAXOUT = 2200;
  const clip = (s, n = MAXOUT) => { s = String(s); return s.length > n ? s.slice(0, n) + `\n… (${s.length} characters in all, the rest is cut off; use @last or @<step number> to work with all of it)` : s; };
  const num = (v, d, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = d; return Math.max(lo, Math.min(hi, Math.trunc(v))); };
  const latin = (b, s = 0, e = b.length) => { let o = ""; for (let i = s; i < e; i += 8192) o += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192))); return o; };
  const fromLatin = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  const utf8 = (b) => new TextDecoder("utf-8").decode(b);
  const dots = (s) => String(s).replace(/[^\x20-\x7e]/g, "·");
  const hx = (n, w = 2) => n.toString(16).padStart(w, "0");
  // a readable peek at the bytes from `from`, saying so when it is cut off (so nobody mistakes half a word for the whole word)
  const peek = (b, from, n = 300) => dots(latin(b, from, Math.min(b.length, from + n))) + (from + n < b.length ? ` …[cut off: ${b.length - from - n} more bytes, use carve, strings or hexdump to see them]` : "");
  const printableRatio = (b, n = 4096) => { const m = Math.min(b.length, n); if (!m) return 0; let ok = 0; for (let i = 0; i < m; i++) { const c = b[i]; if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9 || c >= 128) ok++; } return ok / m; };
  const isTextLike = (b) => printableRatio(b) > 0.92 && !b.subarray(0, 4096).includes(0);

  const MAGIC = [
    ["PNG image", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], ["JPEG image", [0xff, 0xd8, 0xff]], ["GIF image", [0x47, 0x49, 0x46, 0x38]],
    ["ZIP archive (also docx, xlsx, jar, apk)", [0x50, 0x4b, 0x03, 0x04]], ["PDF document", [0x25, 0x50, 0x44, 0x46]], ["GZIP data", [0x1f, 0x8b, 0x08]],
    ["RAR archive", [0x52, 0x61, 0x72, 0x21]], ["7-Zip archive", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], ["Linux program (ELF)", [0x7f, 0x45, 0x4c, 0x46]],
    ["bzip2 data", [0x42, 0x5a, 0x68]], ["XZ data", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], ["SQLite database", [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66]],
    ["WAV/AVI (RIFF)", [0x52, 0x49, 0x46, 0x46]], ["MP3 (ID3)", [0x49, 0x44, 0x33]], ["Ogg", [0x4f, 0x67, 0x67, 0x53]], ["Java class", [0xca, 0xfe, 0xba, 0xbe]],
    ["Windows program (MZ)", [0x4d, 0x5a]], ["BMP image", [0x42, 0x4d]], ["TIFF image", [0x49, 0x49, 0x2a, 0x00]],
  ];
  const startsWith = (b, sig, at = 0) => { if (at + sig.length > b.length) return false; for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false; return true; };
  const typeOf = (b) => { for (const [n, s] of MAGIC) if (startsWith(b, s)) return n; return isTextLike(b) ? "plain text" : "unknown binary data"; };
  function indexOfSeq(b, sig, from = 0) { outer: for (let i = from; i <= b.length - sig.length; i++) { for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) continue outer; return i; } return -1; }
  function allOf(b, sig, max = 30) { const out = []; for (let i = indexOfSeq(b, sig, 0); i >= 0 && out.length < max; i = indexOfSeq(b, sig, i + 1)) out.push(i); return out; }
  function entropy(b) { if (!b.length) return 0; const c = new Array(256).fill(0); for (let i = 0; i < b.length; i++) c[b[i]]++; let e = 0; for (const n of c) if (n) { const p = n / b.length; e -= p * Math.log2(p); } return e; }

  // ---- how English a text looks (for caesar, xor, vigenere and the "auto" decoder) ----
  const EN = [8.17, 1.49, 2.78, 4.25, 12.7, 2.23, 2.02, 6.09, 6.97, 0.15, 0.77, 4.03, 2.41, 6.75, 7.51, 1.93, 0.1, 5.99, 6.33, 9.06, 2.76, 0.98, 2.36, 0.15, 1.97, 0.07];
  const COMMON = ["the", "and", "that", "with", "this", "have", "from", "flag", "password", "secret", "hidden", "word", "you", "are", "for", "not", "was", "your", "message", "is", "of", "to"];
  function englishScore(s) {
    if (!s.length) return 0;
    let ok = 0;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 97 && c <= 122) || c === 32 || (c >= 65 && c <= 90)) ok++; else if (c >= 33 && c <= 126) ok += 0.35; else if (c === 10 || c === 13 || c === 9) ok += 0.5; }
    const low = s.toLowerCase(); let hits = 0;
    for (const w of COMMON) if (low.includes(w)) hits++;
    return ok / s.length + Math.min(0.5, hits * 0.07);
  }
  function chi2(counts, total) { if (!total) return 1e9; let x = 0; for (let i = 0; i < 26; i++) { const e = EN[i] / 100 * total; x += (counts[i] - e) ** 2 / e; } return x; }
  const letterCounts = (s) => { const c = new Array(26).fill(0); let n = 0; for (const ch of s.toLowerCase()) { const k = ch.charCodeAt(0) - 97; if (k >= 0 && k < 26) { c[k]++; n++; } } return [c, n]; };
  const shiftLetters = (s, k) => s.replace(/[a-z]/gi, (ch) => { const base = ch <= "Z" ? 65 : 97; return String.fromCharCode((ch.charCodeAt(0) - base + k + 26 * 40) % 26 + base); });
  const showBytes = (b, n = 600) => {
    if (printableRatio(b, 2000) > 0.85) return clip(utf8(b.subarray(0, n * 3)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "·"), n);
    return `(${b.length} bytes of binary data) hex: ${Array.from(b.subarray(0, 48), (x) => hx(x)).join(" ")}${b.length > 48 ? " …" : ""}\n as text: ${peek(b, 0, 120)}`;
  };

  // ---- decoders: text in, text/bytes out (throw if the text isn't that kind of encoding) ----
  const MORSE = { ".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f", "--.": "g", "....": "h", "..": "i", ".---": "j", "-.-": "k", ".-..": "l", "--": "m", "-.": "n", "---": "o", ".--.": "p", "--.-": "q", ".-.": "r", "...": "s", "-": "t", "..-": "u", "...-": "v", ".--": "w", "-..-": "x", "-.--": "y", "--..": "z", "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4", ".....": "5", "-....": "6", "--...": "7", "---..": "8", "----.": "9" };
  const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const need = (ok, why) => { if (!ok) throw new Error(why); };
  const DECODERS = {
    base64(s) { s = s.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, ""); need(s.length >= 4 && s.length % 4 !== 1, "not base64"); while (s.length % 4) s += "="; return fromLatin(atob(s)); },
    base32(s) { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; s = s.toUpperCase().replace(/[^A-Z2-7]/g, ""); need(s.length >= 8, "not base32"); let bits = "", out = []; for (const ch of s) bits += A.indexOf(ch).toString(2).padStart(5, "0"); for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Uint8Array.from(out); },
    hex(s) { s = s.replace(/0x|\\x/gi, "").replace(/[^0-9a-f]/gi, ""); need(s.length >= 2, "not hex"); const o = []; for (let i = 0; i + 1 < s.length; i += 2) o.push(parseInt(s.slice(i, i + 2), 16)); return Uint8Array.from(o); },
    binary(s) { s = s.replace(/[^01]/g, ""); need(s.length >= 8, "not binary"); const w = s.length % 8 === 0 ? 8 : s.length % 7 === 0 ? 7 : 8; const o = []; for (let i = 0; i + w <= s.length; i += w) o.push(parseInt(s.slice(i, i + w), 2)); return Uint8Array.from(o); },
    decimal(s) { const n = (s.match(/\d+/g) || []).map(Number); need(n.length >= 2, "not numbers"); return n.every((x) => x < 256) ? Uint8Array.from(n) : new TextEncoder().encode(String.fromCodePoint(...n.filter((x) => x <= 0x10ffff))); },
    octal(s) { const n = (s.match(/[0-7]+/g) || []).map((x) => parseInt(x, 8)); need(n.length >= 2 && n.every((x) => x < 256), "not octal"); return Uint8Array.from(n); },
    url(s) { need(/%[0-9a-f]{2}/i.test(s), "no %xx in it"); try { return new TextEncoder().encode(decodeURIComponent(s.replace(/\+/g, " "))); } catch { return fromLatin(s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))); } },
    rot13(s) { return shiftLetters(s, 13); },
    rot47(s) { return s.replace(/[!-~]/g, (c) => String.fromCharCode(33 + (c.charCodeAt(0) - 33 + 47) % 94)); },
    atbash(s) { return s.replace(/[a-z]/gi, (c) => { const b = c <= "Z" ? 65 : 97; return String.fromCharCode(b + 25 - (c.charCodeAt(0) - b)); }); },
    reverse(s) { return Array.from(s).reverse().join(""); },
    morse(s) { const t = s.trim().replace(/[·•]/g, ".").replace(/[−–—_]/g, "-").split(/\s*\/\s*|\s{3,}|\|/); need(/^[.\-\s/|]+$/.test(s.trim()), "not morse"); return t.map((w) => w.trim().split(/\s+/).map((c) => MORSE[c] ?? "?").join("")).join(" "); },
    html(s) { need(/&#?\w+;/.test(s), "no entities"); return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&(\w+);/g, (m, n) => NAMED[n] ?? m); },
    unicode(s) { need(/\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|\\u\{/i.test(s), "no escapes"); return s.replace(/\\u\{([0-9a-f]+)\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); },
    a1z26(s) { const n = (s.match(/\d+/g) || []).map(Number); need(n.length >= 3 && n.every((x) => x >= 1 && x <= 26), "not 1-26"); return n.map((x) => String.fromCharCode(96 + x)).join(""); },
    bacon(s) { const t = s.toUpperCase().replace(/[^AB01]/g, "").replace(/0/g, "A").replace(/1/g, "B"); need(t.length >= 10, "not bacon"); let o = ""; for (let i = 0; i + 5 <= t.length; i += 5) o += String.fromCharCode(97 + parseInt(t.slice(i, i + 5).replace(/A/g, "0").replace(/B/g, "1"), 2) % 26); return o; },
  };
  const asText = (r) => typeof r === "string" ? r : showBytes(r, 1500);
  function autoDecode(text) {
    const src = text.slice(0, 6000), base = englishScore(src), found = [];
    for (const [name, fn] of Object.entries(DECODERS)) {
      let r; try { r = fn(src); } catch { continue; }
      const str = typeof r === "string" ? r : (printableRatio(r, 3000) > 0.9 ? utf8(r) : "");
      if (!str || str.length < 3 || str === src) continue;
      const sc = englishScore(str.slice(0, 2000)), flag = /\w{2,15}\{[ -~]{3,100}\}/.test(str);
      if (flag || sc > Math.max(0.85, base + 0.12)) found.push({ name, sc: sc + (flag ? 1 : 0), str });
    }
    found.sort((a, b) => b.sc - a.sc);
    return found;
  }

  // ---- reading the file ----
  const fileText = (ctx) => (isTextLike(ctx.bytes) ? utf8(ctx.bytes) : latin(ctx.bytes));
  function textArg(ctx, args) {
    const t = String(args.text ?? "");
    const k = t.trim();
    if (/^@last$/i.test(k)) return ctx.outputs[ctx.outputs.length - 1] ?? "";
    let m = k.match(/^@(\d+)$/); if (m) return ctx.outputs[Number(m[1]) - 1] ?? "";
    if (/^@file$/i.test(k)) return fileText(ctx);
    if (k) return t;
    if (num(args.length, 0, 0, 1e9) > 0 || num(args.offset, 0, 0, 1e9) > 0) { const o = num(args.offset, 0, 0, ctx.bytes.length), l = num(args.length, 0, 0, ctx.bytes.length) || ctx.bytes.length - o; return latin(ctx.bytes, o, Math.min(ctx.bytes.length, o + l)); }
    return isTextLike(ctx.bytes) || !ctx.outputs.length ? fileText(ctx) : ctx.outputs[ctx.outputs.length - 1];
  }
  async function inflate(u8, fmt) {
    if (typeof DecompressionStream === "undefined") throw new Error("this browser can't unpack compressed data");
    const ds = new DecompressionStream(fmt);
    const w = ds.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {});
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  function zipEntries(b) {
    let e = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 65600); i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { e = i; break; }
    if (e < 0) return null;
    const total = u16(b, e + 10), cdSize = u32(b, e + 12), cdOff = u32(b, e + 16);
    const shift = e - cdSize - cdOff;                       // the zip may sit behind other data (a picture with a zip glued on)
    const out = []; let p = cdOff + shift;
    for (let i = 0; i < total && p + 46 <= b.length && u32(b, p) === 0x02014b50; i++) {
      const nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32);
      out.push({ name: utf8(b.subarray(p + 46, p + 46 + nl)), flags: u16(b, p + 8), method: u16(b, p + 10), csize: u32(b, p + 20), size: u32(b, p + 24), local: u32(b, p + 42) + shift });
      p += 46 + nl + xl + cl;
    }
    return out;
  }

  // ---- the tools ----
  const T = {};
  T.info = async (ctx) => {
    const b = ctx.bytes, parts = [`Name: ${ctx.name}${ctx.bytes !== ctx.root ? " (a piece cut out of the file)" : ""}`, `Size: ${b.length} bytes`, `Looks like: ${typeOf(b)}`, `Printable characters: ${Math.round(printableRatio(b, b.length) * 100)}%`, `Randomness (entropy): ${entropy(b).toFixed(2)} of 8 bits per byte${entropy(b) > 7.5 ? " (very high: compressed or encrypted)" : ""}`];
    if (b.length > 8192) { const n = 8, sz = Math.floor(b.length / n), es = []; for (let i = 0; i < n; i++) es.push(entropy(b.subarray(i * sz, (i + 1) * sz)).toFixed(1)); parts.push(`Entropy by eighths: ${es.join(" ")}`); }
    if (isTextLike(b)) parts.push(`Lines: ${(latin(b).match(/\n/g) || []).length + 1}`);
    try { const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b)); parts.push("SHA-256: " + Array.from(h, (x) => hx(x)).join("")); } catch {}
    return parts.join("\n");
  };
  T.strings = (ctx, a) => {
    const min = num(a.min, 5, 3, 30), limit = num(a.limit, 40, 5, 80), b = ctx.bytes;
    let re = null; if (String(a.pattern || "").trim()) { try { re = new RegExp(a.pattern, "i"); } catch { re = new RegExp(String(a.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); } }
    const out = []; let start = -1;
    const flush = (end) => { if (start >= 0 && end - start >= min) { const s = latin(b, start, end); if (!re || re.test(s)) out.push(`${start}: ${s.length > 140 ? s.slice(0, 140) + "…" : s}`); } start = -1; };
    for (let i = 0; i < b.length && out.length < limit; i++) { const c = b[i]; if ((c >= 32 && c < 127) || c === 9) { if (start < 0) start = i; } else flush(i); }
    flush(b.length);
    // text stored with two bytes per character (Windows style)
    if (out.length < limit) for (let i = 0; i + 2 * min < b.length && out.length < limit; i++) {
      if (b[i] >= 32 && b[i] < 127 && b[i + 1] === 0) { let j = i, s = ""; while (j + 1 < b.length && b[j] >= 32 && b[j] < 127 && b[j + 1] === 0) { s += String.fromCharCode(b[j]); j += 2; } if (s.length >= min && (!re || re.test(s))) out.push(`${i}: [wide] ${s.slice(0, 140)}`); i = j; }
    }
    return out.length ? `${out.length} strings of ${min}+ characters (offset: text):\n${out.join("\n")}` : "No readable strings found with those settings.";
  };
  T.hexdump = (ctx, a) => {
    const b = ctx.bytes, off = num(a.offset, 0, 0, Math.max(0, b.length - 1)), len = num(a.length, 160, 16, 320), rows = [];
    for (let i = off; i < Math.min(b.length, off + len); i += 16) { const row = b.subarray(i, Math.min(b.length, i + 16)); rows.push(`${hx(i, 6)}  ${Array.from(row, (x) => hx(x)).join(" ").padEnd(47)}  ${dots(latin(row))}`); }
    return rows.join("\n") || "Nothing there (offset past the end).";
  };
  T.view_text = (ctx, a) => {
    const b = ctx.bytes, off = num(a.offset, 0, 0, b.length), len = num(a.length, 1500, 100, 4000);
    return (off ? `(from byte ${off})\n` : "") + utf8(b.subarray(off, Math.min(b.length, off + len))).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "·");
  };
  T.search = (ctx, a) => {
    const b = ctx.bytes, pat = String(a.pattern || a.text || ""); if (!pat) return "Give a pattern to look for.";
    const hits = [];
    if (/^hex:/i.test(pat)) { const sig = Array.from(DECODERS.hex(pat.slice(4))); for (const i of allOf(b, sig, 15)) hits.push(`${i}: ${Array.from(b.subarray(Math.max(0, i - 8), i + sig.length + 24), (x) => hx(x)).join(" ")}`); }
    else {
      const s = latin(b); let re; try { re = a.regex ? new RegExp(pat, "gi") : new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); } catch (e) { return "That isn't a valid pattern: " + e.message; }
      for (let m; (m = re.exec(s)) && hits.length < 15;) { hits.push(`${m.index}: …${dots(s.slice(Math.max(0, m.index - 40), m.index))}[${dots(m[0])}]${dots(s.slice(m.index + m[0].length, m.index + m[0].length + 60))}…`); if (m[0] === "") re.lastIndex++; }
    }
    return hits.length ? `${hits.length} match${hits.length > 1 ? "es" : ""} (offset: context):\n${hits.join("\n")}` : "No matches.";
  };
  T.flags = (ctx) => {
    const s = latin(ctx.bytes), out = [];
    const seen = new Set();
    for (const m of s.matchAll(/[A-Za-z0-9_]{2,15}\{[ -~]{3,100}?\}/g)) if (!seen.has(m[0]) && out.length < 12) { seen.add(m[0]); out.push(`format NAME{...} at ${m.index}: ${m[0]}`); }
    for (const m of s.matchAll(/[^\n]{0,60}(flag|password|passwd|secret|token|key is|the word|answer)[^\n]{0,80}/gi)) if (out.length < 20 && !seen.has(m[0])) { seen.add(m[0]); out.push(`keyword at ${m.index}: ${dots(m[0].trim())}`); }
    for (const m of s.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
      if (out.length >= 30) break;
      try { const d = DECODERS.base64(m[0]); if (printableRatio(d, 400) > 0.9 && d.length >= 6) out.push(`base64 at ${m.index} decodes to: ${dots(utf8(d).slice(0, 120))}`); } catch {}
    }
    for (const m of s.matchAll(/(?:[0-9a-fA-F]{2}){8,}/g)) {
      if (out.length >= 34) break;
      const d = DECODERS.hex(m[0]); if (printableRatio(d, 400) > 0.9) out.push(`hex at ${m.index} decodes to: ${dots(utf8(d).slice(0, 120))}`);
    }
    return out.length ? out.join("\n") : "No flag-like text, keywords, base64 or hex words found in the plain data.";
  };
  T.signatures = (ctx) => {
    const b = ctx.bytes, out = [], skip = new Set(["Windows program (MZ)", "BMP image", "WAV/AVI (RIFF)", "MP3 (ID3)", "bzip2 data"]);
    for (const [name, sig] of MAGIC) { if (skip.has(name) && sig.length < 4) continue; for (const i of allOf(b, sig, 6)) if (i > 0 || !startsWith(b, sig)) out.push(`${name} at byte ${i}`); }
    if (startsWith(b, MAGIC[0][1])) { const i = indexOfSeq(b, [0x49, 0x45, 0x4e, 0x44]); if (i >= 0 && i + 8 < b.length) out.push(`${b.length - (i + 8)} bytes of extra data after the end of the PNG (from byte ${i + 8})`); }
    if (startsWith(b, MAGIC[1][1])) { let e = -1; for (let i = b.length - 2; i > 1; i--) if (b[i] === 0xff && b[i + 1] === 0xd9) { e = i; break; } if (e >= 0 && e + 2 < b.length) out.push(`${b.length - e - 2} bytes of extra data after the end of the JPEG (from byte ${e + 2})`); }
    if (startsWith(b, MAGIC[2][1]) && b[b.length - 1] !== 0x3b) { const i = b.lastIndexOf(0x3b); if (i > 0 && i + 1 < b.length) out.push(`${b.length - i - 1} bytes after the last ';' of the GIF (from byte ${i + 1})`); }
    const zip = zipEntries(b); if (zip && zip.length) out.push(`a readable ZIP with ${zip.length} file${zip.length > 1 ? "s" : ""} (use zip_list)`);
    return out.length ? out.slice(0, 40).join("\n") + "\nTip: carve{offset} cuts a piece out so you can look at it on its own." : `Only the start of the file is recognised (${typeOf(b)}); no other known file types and no extra data at the end.`;
  };
  T.carve = (ctx, a) => {
    const off = num(a.offset, 0, 0, ctx.bytes.length), len = num(a.length, 0, 0, ctx.bytes.length) || ctx.bytes.length - off;
    ctx.bytes = ctx.bytes.slice(off, Math.min(ctx.bytes.length, off + len));
    return `Now looking at ${ctx.bytes.length} bytes cut out from byte ${off}. Looks like: ${typeOf(ctx.bytes)}. Start (hex): ${Array.from(ctx.bytes.subarray(0, 24), (x) => hx(x)).join(" ")}\n(use reset to go back to the whole file)`;
  };
  T.reset = (ctx) => { ctx.bytes = ctx.root; return `Back to the whole file (${ctx.root.length} bytes).`; };
  T.png_chunks = async (ctx) => {
    const b = ctx.bytes; if (!startsWith(b, MAGIC[0][1])) return "This isn't a PNG picture.";
    const out = []; let p = 8, n = 0, idat = 0;
    while (p + 12 <= b.length && n++ < 400) {
      const len = be32(b, p), type = latin(b, p + 4, p + 8), data = b.subarray(p + 8, Math.min(b.length, p + 8 + len));
      let line = `${type} (${len} bytes)`;
      try {
        if (type === "tEXt") { const z = data.indexOf(0); line += `: ${latin(data, 0, z)} = ${dots(latin(data, z + 1))}`; }
        else if (type === "zTXt") { const z = data.indexOf(0); line += `: ${latin(data, 0, z)} = ${dots(utf8(await inflate(data.subarray(z + 2), "deflate")))}`; }
        else if (type === "iTXt") { const z = data.indexOf(0); const comp = data[z + 1]; let q = z + 3; q = data.indexOf(0, q) + 1; q = data.indexOf(0, q) + 1; const txt = comp ? utf8(await inflate(data.subarray(q), "deflate")) : utf8(data.subarray(q)); line += `: ${latin(data, 0, z)} = ${txt.slice(0, 300)}`; }
        else if (type === "IHDR") line += `: ${be32(data, 0)}x${be32(data, 4)} pixels, bit depth ${data[8]}, colour type ${data[9]}`;
        else if (!/^(IDAT|IEND|PLTE|pHYs|sRGB|gAMA|cHRM|tIME|bKGD|sBIT|tRNS|iCCP|sPLT|hIST)$/.test(type)) line += ` (unusual chunk) ${peek(data, 0, 200)}`;
        else if (type === "tIME") line += `: ${(data[0] << 8) | data[1]}-${data[2]}-${data[3]} ${data[4]}:${data[5]}:${data[6]}`;
      } catch (e) { line += " (couldn't read: " + e.message + ")"; }
      if (type === "IDAT") { idat++; p += 12 + len; continue; }
      if (idat) { out.push(`IDAT x${idat} (the picture itself)`); idat = 0; }
      out.push(line);
      p += 12 + len; if (type === "IEND") break;
    }
    if (idat) out.push(`IDAT x${idat} (the picture itself)`);
    if (p < b.length) out.push(`EXTRA: ${b.length - p} bytes after IEND (from byte ${p}): ${peek(b, p)}`);
    return out.join("\n");
  };
  T.jpeg_segments = (ctx) => {
    const b = ctx.bytes; if (!startsWith(b, MAGIC[1][1])) return "This isn't a JPEG picture.";
    const out = []; let p = 2;
    while (p + 4 <= b.length && b[p] === 0xff && out.length < 60) {
      const m = b[p + 1]; if (m === 0xda) { out.push("SOS (picture data starts)"); break; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      const len = (b[p + 2] << 8) | b[p + 3], seg = b.subarray(p + 4, p + 2 + len);
      const name = m === 0xfe ? "COM (comment)" : m >= 0xe0 && m <= 0xef ? "APP" + (m - 0xe0) : "FF" + hx(m);
      let extra = ""; if (m === 0xfe) extra = ": " + dots(utf8(seg)); else if (m >= 0xe0 && m <= 0xef) { const st = (latin(seg).match(/[ -~]{4,}/g) || []).slice(0, 8).join(" | "); extra = st ? ": " + st.slice(0, 300) : ""; }
      out.push(`${name} (${len} bytes)${extra}`); p += 2 + len;
    }
    let e = -1; for (let i = b.length - 2; i > 1; i--) if (b[i] === 0xff && b[i + 1] === 0xd9) { e = i; break; }
    if (e >= 0 && e + 2 < b.length) out.push(`EXTRA: ${b.length - e - 2} bytes after the end of the picture (from byte ${e + 2}): ${peek(b, e + 2)}`);
    return out.join("\n");
  };
  T.zip_list = (ctx) => {
    const z = zipEntries(ctx.bytes); if (!z) return "No readable ZIP archive in here (try signatures to see where one may start, then carve).";
    return z.map((e, i) => `${i + 1}. ${e.name} (${e.size} bytes${e.flags & 1 ? ", PASSWORD-PROTECTED" : ""}${e.method !== 0 && e.method !== 8 ? ", unusual compression " + e.method : ""})`).join("\n");
  };
  T.zip_read = async (ctx, a) => {
    const z = zipEntries(ctx.bytes); if (!z) return "No readable ZIP archive in here.";
    const want = String(a.name || "").toLowerCase().trim(), e = z.find((x) => x.name.toLowerCase() === want) || z.find((x) => x.name.toLowerCase().includes(want)) || (!want && z.length === 1 ? z[0] : null);
    if (!e) return "No such file in the ZIP. Files: " + z.map((x) => x.name).join(", ");
    if (e.flags & 1) return `${e.name} is password-protected, so it can't be opened here. Look for the password elsewhere in the file (strings, comments, other steps).`;
    const b = ctx.bytes; if (u32(b, e.local) !== 0x04034b50) return "The ZIP entry is damaged.";
    const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28), raw = b.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw : e.method === 8 ? await inflate(raw, "deflate-raw") : null;
    if (!data) return "Unsupported compression.";
    ctx.entry = data;
    return `${e.name} (${data.length} bytes, ${typeOf(data)}):\n${showBytes(data, 1500)}\n(use use_entry to analyze this file further)`;
  };
  T.use_entry = (ctx) => { if (!ctx.entry) return "Nothing opened yet. Use zip_read first."; ctx.bytes = ctx.entry; return `Now looking at the opened file (${ctx.bytes.length} bytes, ${typeOf(ctx.bytes)}). Use reset to go back.`; };
  T.decode = (ctx, a) => {
    const m = String(a.method || "auto").toLowerCase().replace(/[^a-z0-9]/g, ""), text = textArg(ctx, a);
    if (!text) return "There is no text to decode.";
    if (m === "auto") {
      const f = autoDecode(text);
      return f.length ? "Decodings that make sense:\n" + f.slice(0, 6).map((x) => `- ${x.name}: ${clip(x.str.replace(/\s+/g, " ").slice(0, 400), 400)}`).join("\n") : "None of the simple decoders (base64, base32, hex, binary, decimal, octal, url, rot13, rot47, atbash, reverse, morse, html, unicode escapes, a1z26, bacon) turned this into readable text.";
    }
    if (m === "rotn" || m === "rot" || m === "caesar") return shiftLetters(text, num(a.n, 13, 1, 25));
    const fn = DECODERS[m]; if (!fn) return "Unknown method. Use one of: auto, " + Object.keys(DECODERS).join(", ") + ", rotn.";
    try { return asText(fn(text)); } catch (e) { return `That doesn't look like ${m} (${e.message}).`; }
  };
  T.caesar = (ctx, a) => {
    const text = textArg(ctx, a).slice(0, 4000), rows = [];
    for (let k = 1; k < 26; k++) { const s = shiftLetters(text, k), [c, n] = letterCounts(s); rows.push({ k, s, x: chi2(c, n) + (englishScore(s) > 0.9 ? -50 : 0) }); }
    rows.sort((x, y) => x.x - y.x);
    return "Best shifts (shift: text):\n" + rows.slice(0, 4).map((r) => `${r.k}: ${r.s.slice(0, 200).replace(/\n/g, " ")}`).join("\n");
  };
  T.xor = (ctx, a) => {
    const b = ctx.bytes, off = num(a.offset, 0, 0, b.length), len = num(a.length, 0, 0, b.length) || Math.min(b.length - off, 4096), reg = b.subarray(off, off + len), k = String(a.key ?? "").trim();
    if (k) {
      const key = /^0x[0-9a-f]+$/i.test(k) || /^[0-9a-f]{2}([\s,][0-9a-f]{2})+$/i.test(k) || /^[0-9a-f]{2}$/i.test(k) ? DECODERS.hex(k) : new TextEncoder().encode(k);
      const out = reg.map((x, i) => x ^ key[i % key.length]);
      return `XOR with key ${Array.from(key, (x) => hx(x)).join("")}:\n${showBytes(out, 1200)}`;
    }
    const rows = [];
    for (let key = 1; key < 256; key++) { const o = reg.map((x) => x ^ key), s = latin(o, 0, Math.min(o.length, 600)); rows.push({ key, sc: englishScore(s), s }); }
    rows.sort((x, y) => y.sc - x.sc);
    return "Best single-byte XOR keys (key: text):\n" + rows.slice(0, 5).map((r) => `0x${hx(r.key)} (${String.fromCharCode(r.key) >= " " && r.key < 127 ? "'" + String.fromCharCode(r.key) + "'" : "-"}): ${dots(r.s.slice(0, 120))}`).join("\n");
  };
  T.vigenere = (ctx, a) => {
    const text = textArg(ctx, a), key = String(a.key || "").toLowerCase().replace(/[^a-z]/g, "");
    const dec = (s, kk) => { let i = 0; return s.replace(/[a-z]/gi, (ch) => { const base = ch <= "Z" ? 65 : 97, sh = kk.charCodeAt(i++ % kk.length) - 97; return String.fromCharCode((ch.charCodeAt(0) - base - sh + 26) % 26 + base); }); };
    if (key) return "Decrypted with key '" + key + "':\n" + dec(text, key).slice(0, 1500);
    const letters = text.toLowerCase().replace(/[^a-z]/g, ""); if (letters.length < 30) return "Needs at least about 30 letters of text to guess the key.";
    const ic = (s) => { const [c, n] = letterCounts(s); return n > 1 ? c.reduce((x, y) => x + y * (y - 1), 0) / (n * (n - 1)) : 0; };
    const res = [];
    for (let L = 1; L <= 14; L++) { let sum = 0; for (let j = 0; j < L; j++) { let col = ""; for (let i = j; i < letters.length; i += L) col += letters[i]; sum += ic(col); } res.push({ L, ic: sum / L }); }
    const top = Math.max(...res.map((r) => r.ic)), best = res.find((r) => r.ic > top - 0.008);
    let k = ""; for (let j = 0; j < best.L; j++) { let col = ""; for (let i = j; i < letters.length; i += best.L) col += letters[i]; let bs = 0, bx = 1e12; for (let s = 0; s < 26; s++) { const [c, n] = letterCounts(shiftLetters(col, -s)); const x = chi2(c, n); if (x < bx) { bx = x; bs = s; } } k += String.fromCharCode(97 + bs); }
    return `Index of coincidence by key length: ${res.slice(0, 10).map((r) => r.L + ":" + r.ic.toFixed(3)).join(" ")} (English ≈ 0.066, mixed up by a keyword ≈ 0.04)\nLikeliest key: '${k}' (length ${best.L})\n${dec(text, k).slice(0, 1200)}`;
  };
  T.frequency = (ctx, a) => {
    const text = textArg(ctx, a), [c, n] = letterCounts(text);
    if (n < 10) return "Not enough letters to count.";
    const ic = c.reduce((x, y) => x + y * (y - 1), 0) / (n * (n - 1)), top = c.map((v, i) => [String.fromCharCode(97 + i), v]).sort((x, y) => y[1] - x[1]).slice(0, 8);
    return `${n} letters. Most common: ${top.map(([l, v]) => `${l}=${(v / n * 100).toFixed(1)}%`).join(" ")}\nIndex of coincidence ${ic.toFixed(3)}: ${ic > 0.06 ? "like normal text (plain, shifted or swapped letters: try caesar or a letter swap)" : ic > 0.045 ? "in between" : "flat like random letters (a keyword cipher such as vigenere, or something that isn't letters)"}`;
  };
  T.acrostic = (ctx, a) => {
    const text = textArg(ctx, a), lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), clean = (s) => s.replace(/^[^\p{L}\p{N}]+/u, "");
    const words = text.split(/\s+/).map(clean).filter(Boolean), sent = text.split(/(?<=[.!?])\s+/).map(clean).filter(Boolean);
    const first = (arr) => arr.map((x) => Array.from(x)[0] ?? "").join(""), last = (arr) => arr.map((x) => { const t = x.replace(/[^\p{L}\p{N}]+$/u, ""); return Array.from(t).pop() ?? ""; }).join("");
    return [`First letter of each line (${lines.length}): ${first(lines).slice(0, 300)}`, `Last letter of each line: ${last(lines).slice(0, 300)}`, `First letter of each word (${words.length}): ${first(words).slice(0, 300)}`, `First letter of each sentence (${sent.length}): ${first(sent).slice(0, 300)}`, `First word of each line: ${lines.map((l) => clean(l).split(/\s+/)[0]).join(" ").slice(0, 300)}`, `Last word of each line: ${lines.map((l) => l.split(/\s+/).pop().replace(/[^\p{L}\p{N}]+$/u, "")).join(" ").slice(0, 300)}`].join("\n");
  };
  T.nth_chars = (ctx, a) => {
    const text = textArg(ctx, a), n = num(a.n, 2, 2, 200), arr = Array.from(text), out = [];
    for (let s = 0; s < Math.min(n, 3); s++) { let r = ""; for (let i = s; i < arr.length; i += n) r += arr[i]; out.push(`every ${n}th character starting at ${s + 1}: ${r.slice(0, 300)}`); }
    return out.join("\n");
  };
  T.invisible = (ctx) => {
    const text = isTextLike(ctx.bytes) ? utf8(ctx.bytes) : latin(ctx.bytes), out = [];
    const zw = text.match(/[​‌‍⁠﻿᠎]/g) || [];
    if (zw.length) {
      const kinds = {}; for (const c of zw) kinds[c.charCodeAt(0).toString(16)] = (kinds[c.charCodeAt(0).toString(16)] || 0) + 1;
      out.push(`${zw.length} zero-width characters (${Object.entries(kinds).map(([k, v]) => "U+" + k + " x" + v).join(", ")})`);
      const types = Object.keys(kinds).sort((x, y) => kinds[y] - kinds[x]);
      if (types.length >= 2) for (const [z, o] of [[types[0], types[1]], [types[1], types[0]]]) {
        const bits = [...text].filter((c) => { const h = c.codePointAt(0).toString(16); return h === z || h === o; }).map((c) => c.codePointAt(0).toString(16) === z ? "0" : "1").join("");
        const d = DECODERS.binary(bits.length >= 8 ? bits : "00000000"); if (printableRatio(d, 400) > 0.8) out.push(`as bits (U+${z}=0, U+${o}=1): ${dots(latin(d, 0, 200))}`);
      }
    }
    const lines = text.split(/\r?\n/), tw = lines.filter((l) => /[ \t]+$/.test(l));
    if (tw.length >= 4) {
      out.push(`${tw.length} lines end in spaces or tabs`);
      const bits = lines.map((l) => { const m = l.match(/([ \t]+)$/); return m ? (m[1].endsWith("\t") ? "1" : "0") : ""; }).join("");
      if (bits.length >= 8) { const d = DECODERS.binary(bits); out.push(`as bits (space=0, tab=1): ${dots(latin(d, 0, 200))}`); }
      const cnt = lines.map((l) => (l.match(/[ \t]+$/) || [""])[0].length); out.push(`length of the trailing whitespace per line: ${cnt.slice(0, 60).join(",")}`);
    }
    const caps = text.replace(/[^A-Za-z]/g, ""); if (caps.length >= 16 && caps.length <= 4000 && /[a-z]/.test(caps) && /[A-Z]/.test(caps)) {
      const bits = caps.replace(/[A-Z]/g, "1").replace(/[a-z]/g, "0"), d = DECODERS.binary(bits); if (printableRatio(d, 200) > 0.85) out.push(`upper/lower case as bits: ${dots(latin(d, 0, 120))}`);
    }
    const odd = (text.match(/[^\u0000-ÿ‘’“”–—…​-‍⁠﻿]/g) || []); if (odd.length && odd.length < 200) out.push(`unusual characters: ${[...new Set(odd)].slice(0, 30).join(" ")}`);
    return out.length ? out.join("\n") : "No zero-width characters, whitespace patterns or case patterns found.";
  };
  T.image_lsb = async (ctx, a) => {
    if (typeof createImageBitmap === "undefined") return "Reading picture pixels needs a browser.";
    let bmp; try { bmp = await createImageBitmap(new Blob([ctx.bytes])); } catch { return "This isn't a picture the browser can open (PNG, JPEG, GIF, BMP or WebP). Try signatures to find one inside."; }
    const w = bmp.width, h = bmp.height; if (w * h > 16e6) return `The picture is too big (${w}x${h}).`;
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(bmp, 0, 0); const px = cx.getImageData(0, 0, w, h).data;
    const grab = (chs, bit, col) => {
      const idx = [...chs].map((c) => "rgba".indexOf(c)), bits = []; const n = w * h;
      for (let t = 0; t < n; t++) { const p = col ? ((t % h) * w + Math.floor(t / h)) : t; for (const i of idx) bits.push((px[p * 4 + i] >> bit) & 1); }
      const out = new Uint8Array(bits.length >> 3); for (let i = 0; i < out.length; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; out[i] = v; } return out;
    };
    const given = String(a.channels || "").toLowerCase().replace(/[^rgba]/g, "");
    const tries = given ? [[given, num(a.bit ?? a.n, 0, 0, 7), false]] : [["rgb", 0, false], ["r", 0, false], ["g", 0, false], ["b", 0, false], ["rgba", 0, false], ["rgb", 1, false], ["rgb", 0, true]];
    const res = tries.map(([c, bit, col]) => { const d = grab(c, bit, col); return { c, bit, col, d, sc: englishScore(latin(d, 0, 400)) + (printableRatio(d, 400) > 0.9 ? 0.3 : 0) }; }).sort((x, y) => y.sc - x.sc);
    return `Picture ${w}x${h}. Hidden bits read from the lowest colour bits (channels, bit${given ? "" : ", best first"}):\n` + res.slice(0, given ? 1 : 4).map((r) => `${r.c.toUpperCase()} bit ${r.bit}${r.col ? " column by column" : ""}: ${printableRatio(r.d, 400) > 0.8 ? dots(latin(r.d, 0, 160)) : "(no readable text) " + Array.from(r.d.subarray(0, 16), (x) => hx(x)).join(" ")}`).join("\n");
  };

  // what the AI is told it can do ("args" lists the fields that matter for that tool)
  const ACTIONS = [
    ["info", "", "Size, type, randomness and fingerprint of the file."],
    ["strings", "min, limit, pattern", "Readable text hidden inside any file (with the byte position of each piece)."],
    ["view_text", "offset, length", "Show the file as text."],
    ["hexdump", "offset, length", "Raw bytes, 16 per row, with the text next to them."],
    ["search", "pattern", "Find a word or text (or 'hex:41 42') in the file; shows the surroundings."],
    ["flags", "", "Look for flag-like words such as flag{...}, keywords like password or secret, and base64/hex words that decode to text."],
    ["signatures", "", "Find files hidden inside the file (zip, png, jpg, pdf…) and extra data after the end of a picture."],
    ["carve", "offset, length", "Cut a piece out of the file (length 0 = to the end) and look at it on its own. reset goes back."],
    ["reset", "", "Go back to looking at the whole file."],
    ["png_chunks", "", "PNG picture: the metadata chunks, text comments, odd chunks and extra data after the end."],
    ["jpeg_segments", "", "JPEG picture: comments, metadata strings and extra data after the end."],
    ["image_lsb", "channels, n (bit 0-7)", "Read hidden data from the lowest colour bits of a picture (leave channels empty to try the usual ones)."],
    ["zip_list", "", "List the files in a ZIP archive (also one glued onto the end of another file)."],
    ["zip_read", "name", "Read one file out of the ZIP. use_entry then makes it the thing you analyze."],
    ["use_entry", "", "Analyze the file opened by zip_read."],
    ["decode", "method, text, n", "Decode text: auto tries everything (base64, base32, hex, binary, decimal, octal, url, rot13, rot47, atbash, reverse, morse, html, unicode, a1z26, bacon); rotn uses n as the shift."],
    ["caesar", "text", "Try all 25 shifts of a Caesar cipher and show the most English-looking ones."],
    ["vigenere", "text, key", "Vigenère cipher: decrypt with a key, or guess the key when none is given."],
    ["xor", "key, offset, length", "XOR bytes with a key (text or hex), or find the best single-byte key when no key is given."],
    ["frequency", "text", "Letter counts and index of coincidence, to tell which kind of cipher it might be."],
    ["acrostic", "text", "First and last letters or words of every line, word and sentence (hidden words in poems and lists)."],
    ["nth_chars", "n, text", "Every n-th character of the text."],
    ["invisible", "", "Zero-width characters, spaces and tabs at line ends, upper/lower-case patterns and odd characters that carry hidden bits."],
  ];

  async function run(name, args, ctx) {
    const fn = T[name]; if (!fn) throw new Error("Unknown tool " + name);
    let out; try { out = await fn(ctx, args || {}); } catch (e) { out = "That failed: " + e.message; }
    out = String(out);
    ctx.outputs.push(out);
    return out;
  }
  const newCtx = (bytes, name) => ({ bytes, root: bytes, name: name || "file", outputs: [], entry: null });
  g.Puzzle = { ACTIONS, run, newCtx, clip, typeOf, isTextLike, englishScore, DECODERS };
  if (typeof module !== "undefined") module.exports = g.Puzzle;
})(typeof self !== "undefined" ? self : globalThis);
