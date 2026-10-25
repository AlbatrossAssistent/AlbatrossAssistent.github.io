/*
 * Liquid glass for Albatross: a plain-JavaScript port of the glass engine from liqui (https://liqui.design),
 * the package @liqui-design/glass 0.4.0 by Fan Li, used under the MIT License:
 *
 *   MIT License
 *   Copyright (c) 2026 Fan Li
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 *   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 *   the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 *   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 *   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * How it works (as in liqui): the edge of a surface bends what is behind it like the rim of a thick lens. A canvas draws a
 * displacement map for the surface's size (rounded-rectangle signed distance, eased toward the centre), an SVG filter
 * (feDisplacementMap) uses it as backdrop-filter, and a tint plus a light rim sit on top. Chromium browsers render the refraction;
 * Safari and Firefox ignore a backdrop-filter that names an SVG filter, so they get the frosted blur layer only.
 *
 * Here the layers are added to existing elements instead of wrapping them in a component:
 *   LiquidGlass.attach(el, { bezel, refraction, frost, ... })   or   LiquidGlass.auto([[selector, options], ...])
 */
(function (g) {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Refraction (backdrop-filter: url(#svg-filter)) only works in Chromium for now.
  const supportsRefraction = (() => {
    if (typeof CSS === "undefined" || !CSS.supports("backdrop-filter", "blur(1px)")) return false;
    const ua = navigator.userAgent;
    if (/firefox\/(\d+)/i.test(ua)) return false;
    if (/^((?!chrome|chromium|edg|android).)*safari/i.test(ua)) return false;
    return true;
  })();

  // ---- how hard the rim bends, by depth: a thick glass slab, Snell's law (n = 1.5) ----
  const LUT_SIZE = 128, lutCache = new Map();
  function surfaceLUT(profile) {
    if (lutCache.has(profile)) return lutCache.get(profile);
    const mag = new Float32Array(LUT_SIZE), n = 1.5, T = .6;
    const h = profile === "squircle" ? (t) => Math.pow(1 - Math.pow(1 - t, 4), .25) : profile === "convex" ? (t) => Math.sqrt(1 - (1 - t) * (1 - t)) : (t) => 1 - (1 - t) * (1 - t);
    const eps = 1 / 1024; let max = 0;
    for (let i = 0; i < LUT_SIZE; i++) {
      const t = Math.max(i / (LUT_SIZE - 1), eps), hi = Math.min(t + eps, 1), lo = Math.max(t - eps, 0);
      const slope = (h(hi) - h(lo)) / (hi - lo) * T;
      if (profile === "rim") mag[i] = (1 - t) * (1 - t);
      else { const thetaI = Math.atan(Math.abs(slope)), delta = thetaI - Math.asin(Math.sin(thetaI) / n); mag[i] = h(t) * T * Math.tan(delta); max = Math.max(max, mag[i]); }
    }
    if (max > 0) for (let i = 0; i < LUT_SIZE; i++) mag[i] /= max;
    lutCache.set(profile, mag);
    return mag;
  }
  // rim light: a key light toward the top-left, a dim counter-light bottom-right
  const THETA_KEY = Math.atan2(-.9, -.45), THETA_COUNTER = Math.atan2(.9, .5);

  // ---- the displacement map and the specular rim, drawn per size (cached; big ones at half resolution) ----
  const IMAGE_CACHE_MAX = 48, imageCache = new Map();
  function glassImages(fullW, fullH, fullRadius, fullBezel, profile) {
    const key = `${fullW}x${fullH}r${fullRadius}b${fullBezel}${profile}`;
    const hit = imageCache.get(key);
    if (hit) { imageCache.delete(key); imageCache.set(key, hit); return hit; }
    const scale = fullW * fullH > 32e3 ? .5 : 1;
    const w = Math.ceil(fullW * scale), h = Math.ceil(fullH * scale), radius = fullRadius * scale, bezel = Math.max(1, fullBezel * scale);
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d"), image = ctx.createImageData(w, h), data = image.data;
    const specCanvas = document.createElement("canvas"); specCanvas.width = w; specCanvas.height = h;
    const specCtx = specCanvas.getContext("2d"), specImage = specCtx.createImageData(w, h), spec = specImage.data;
    const lut = surfaceLUT(profile), r = Math.min(radius, w / 2, h / 2), bx = w / 2 - r, by = h / 2 - r;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x + .5 - w / 2, py = y + .5 - h / 2, qx = Math.abs(px) - bx, qy = Math.abs(py) - by;
      const depth = -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
      let nx = 0, ny = 0;
      if (qx > 0 && qy > 0) { const len = Math.hypot(qx, qy) || 1; nx = Math.sign(px) * qx / len; ny = Math.sign(py) * qy / len; }
      else if (qx > qy) nx = Math.sign(px); else ny = Math.sign(py);
      const d = depth / bezel, inRim = d < 1 && d >= 0;
      const mag = inRim ? lut[Math.min(Math.round(d * (LUT_SIZE - 1)), LUT_SIZE - 1)] : 0;
      const i = (y * w + x) * 4;
      data[i] = Math.round(128 - nx * mag * 127); data[i + 1] = 128; data[i + 2] = Math.round(128 - ny * mag * 127); data[i + 3] = 255;
      if (inRim) {
        // a thin line of light right at the edge (Albatross: narrower than liqui's wide band, which read as smudges on dark glass)
        const theta = Math.atan2(py, px), band = Math.exp(-(((d - .04) / .09) ** 2));
        const c1 = Math.max(Math.cos(theta - THETA_KEY), 0), c2 = Math.max(Math.cos(theta - THETA_COUNTER), 0);
        spec[i] = spec[i + 1] = spec[i + 2] = 255; spec[i + 3] = Math.round(Math.min(band * (1.15 * c1 ** 3 + .75 * c2 ** 3.5), 1) * 255);
      }
    }
    ctx.putImageData(image, 0, 0); specCtx.putImageData(specImage, 0, 0);
    const result = { map: canvas.toDataURL(), specular: specCanvas.toDataURL() };
    imageCache.set(key, result);
    if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    return result;
  }

  // ---- one hidden <svg> that holds every refraction filter, so a surface can reference it by id ----
  let host = null; const filterIds = new Map(); let nextId = 0; const FILTER_CACHE_MAX = 256;
  const ISOLATE = { R: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", G: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", B: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" };
  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElementNS(SVG_NS, "svg");
    host.setAttribute("width", "0"); host.setAttribute("height", "0"); host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:absolute;pointer-events:none";
    document.body.appendChild(host);
    return host;
  }
  const svgEl = (name, attrs) => { const n = document.createElementNS(SVG_NS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
  const displacement = (scale, result) => { const n = svgEl("feDisplacementMap", { in: "SourceGraphic", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "B" }); if (result) n.setAttribute("result", result); return n; };
  function ensureFilter({ w, h, mapHref, refraction, dispersion }) {
    const key = `${w}x${h}|r${refraction}|d${dispersion}|${mapHref.length}:${mapHref.slice(-24)}`;
    const existing = filterIds.get(key);
    if (existing) { filterIds.delete(key); filterIds.set(key, existing); return existing; }
    const id = `lq-refract-${nextId++}`;
    const filter = svgEl("filter", { id, x: 0, y: 0, width: w, height: h, filterUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });
    const image = svgEl("feImage", { x: 0, y: 0, width: w, height: h, result: "map" }); image.setAttribute("href", mapHref);
    filter.appendChild(image);
    if (dispersion > 0) {
      filter.appendChild(displacement(refraction * (1 - dispersion), "dispR")); filter.appendChild(svgEl("feColorMatrix", { in: "dispR", values: ISOLATE.R, result: "chR" }));
      filter.appendChild(displacement(refraction, "dispG")); filter.appendChild(svgEl("feColorMatrix", { in: "dispG", values: ISOLATE.G, result: "chG" }));
      filter.appendChild(displacement(refraction * (1 + dispersion), "dispB")); filter.appendChild(svgEl("feColorMatrix", { in: "dispB", values: ISOLATE.B, result: "chB" }));
      filter.appendChild(svgEl("feComposite", { in: "chR", in2: "chG", operator: "arithmetic", k2: 1, k3: 1, result: "chRG" }));
      filter.appendChild(svgEl("feComposite", { in: "chRG", in2: "chB", operator: "arithmetic", k2: 1, k3: 1 }));
    } else filter.appendChild(displacement(refraction));
    ensureHost().appendChild(filter);
    filterIds.set(key, id);
    if (filterIds.size > FILTER_CACHE_MAX) { const [k, oldId] = filterIds.entries().next().value; filterIds.delete(k); host.querySelector("#" + oldId)?.remove(); }
    return id;
  }

  // ---- the layers on an element ----
  const DEFAULTS = { material: "auto", profile: "squircle", refraction: 140, bezel: 26, frost: .35, blur: 1, saturation: 1.7, specular: .58, dispersion: 0 };
  const instances = new WeakMap();
  function attach(el, options = {}) {
    if (instances.has(el)) return instances.get(el);
    const o = { ...DEFAULTS, ...options };
    const mk = (cls) => { const s = document.createElement("span"); s.className = "lg-layer " + cls; s.setAttribute("aria-hidden", "true"); return s; };
    const L = { backdrop: mk("lg-backdrop"), refract: mk("lg-refract"), tint: mk("lg-tint"), spec: mk("lg-spec"), shine: mk("lg-shine") };
    el.classList.add("lg");
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.prepend(L.backdrop, L.refract, L.tint, L.spec, L.shine);
    const refract = o.material !== "frost" && supportsRefraction;
    el.classList.add(refract ? "lg-refract-on" : "lg-frost-on");
    let lastKey = "", raf = 0;
    const effBlur = o.blur + o.frost * 14;
    L.tint.style.opacity = String(.25 + .75 * o.frost);
    function update() {
      raf = 0;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (!w || !h) return;
      const cs = getComputedStyle(el);
      const radius = Math.max(1, Math.min(parseFloat(cs.borderTopLeftRadius) || 16, w / 2, h / 2));
      const bezel = Math.max(1, Math.min(o.bezel, Math.min(w, h) / 2));
      const key = `${w}x${h}r${radius}`;
      if (key === lastKey) return; lastKey = key;
      const bf = refract ? `blur(${effBlur}px) saturate(${o.saturation})` : `blur(${Math.max(effBlur * 2, 10)}px) saturate(${o.saturation})`;
      L.backdrop.style.backdropFilter = L.backdrop.style.webkitBackdropFilter = bf;
      if (!refract) return;
      const images = glassImages(w, h, radius, bezel, o.profile);
      const id = ensureFilter({ w, h, mapHref: images.map, refraction: o.refraction, dispersion: o.dispersion });
      L.refract.style.backdropFilter = L.refract.style.webkitBackdropFilter = `url(#${id})`;
      L.spec.style.backgroundImage = `url(${images.specular})`;
      L.spec.style.opacity = String(o.specular);
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    const ro = new ResizeObserver(schedule); ro.observe(el);
    schedule();
    const inst = { el, update: schedule, destroy() { ro.disconnect(); Object.values(L).forEach((n) => n.remove()); el.classList.remove("lg", "lg-refract-on", "lg-frost-on"); instances.delete(el); } };
    instances.set(el, inst);
    return inst;
  }

  // attach to everything that matches (now, and whenever it is added later)
  function auto(rules) {
    const scan = (root) => {
      for (const [sel, opt] of rules) {
        if (root.matches && root.matches(sel)) attach(root, opt);
        root.querySelectorAll && root.querySelectorAll(sel).forEach((n) => attach(n, opt));
      }
    };
    scan(document);
    new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && !n.classList.contains("lg-layer")) scan(n); })
      .observe(document.body, { childList: true, subtree: true });
  }
  // the light follows the pointer: the glass surface under it gets .lg-lit and --lx/--ly (where the pointer is on it)
  let lit = null, lastEv = null, lightRaf = 0;
  function light() {
    lightRaf = 0;
    const e = lastEv, el = e && e.target && e.target.closest ? e.target.closest(".lg") : null;
    if (lit && lit !== el) lit.classList.remove("lg-lit");
    lit = el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--lx", (e.clientX - r.left).toFixed(0) + "px"); el.style.setProperty("--ly", (e.clientY - r.top).toFixed(0) + "px");
    el.classList.add("lg-lit");
  }
  if (typeof addEventListener === "function") {
    addEventListener("pointermove", (e) => { if (e.pointerType === "touch") return; lastEv = e; if (!lightRaf) lightRaf = requestAnimationFrame(light); }, { passive: true });
    document.addEventListener("pointerout", (e) => { if (!e.relatedTarget && lit) { lit.classList.remove("lg-lit"); lit = null; } });
  }
  function setEnabled(on) { document.documentElement.classList.toggle("no-lg", !on); }

  g.LiquidGlass = { attach, auto, setEnabled, supportsRefraction };
})(window);
