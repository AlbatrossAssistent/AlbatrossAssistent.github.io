// The Jarvis orb, drawn in 3D by the graphics card (WebGL): a sphere with two curved eyes painted on its
// surface. The whole orb turns toward a point (the mouse), so the eyes move across the 3D surface, and it
// blinks every few seconds. White with dark eyes in dark mode, black with light eyes in light mode.
// Used by the landing page and by the Jarvis page in the app.
(function () {
  const FS = `precision highp float;
uniform vec2 uRes;      // canvas size in pixels
uniform vec3 uC;        // orb centre x, y (from the top) and radius, in canvas pixels
uniform vec2 uLook;     // yaw, pitch the orb is turned by
uniform float uOpen;    // 1 = eyes open, 0 = closed (blink)
uniform float uDark;    // 1 = dark page (white orb), 0 = light page (black orb)
uniform float uAlpha;
uniform float uMood;    // unused by the shader now: the JS turns it into uExpr
uniform float uPulse;   // 0..1 glow while busy
uniform float uEyes;    // 1 = eyes shown, 0 = hidden (something else is shown on the orb)
uniform vec4 uExpr;     // Jarvis expression: openness, curve, squint, width
uniform vec2 uExpr2;    // spacing, brow
uniform vec2 uEyeMove;  // the eyes' sideways offset (radius units) and scale, for sliding them off and on
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
// Jarvis's eyes, exactly as jarvis/render/geometry.py builds them: a rounded rectangle (half-size 0.196 x 0.272
// of the radius, corner 0.8 of the shorter half-side) whose points go through the app's warp - brow lowers the
// top edge, squint raises the lower lid, curve tapers the tips and lifts the middle. Here the warp is undone for
// each pixel (the inverse map), so the pixel can be tested against the plain rectangle. Coordinates are the face
// plane in radius units, y pointing down like the app's. Returns the distance in radius units (negative inside).
float jarvisEye(vec2 p, float side){
  float hw = .196 * uExpr.w, hh = .272 * clamp(uExpr.x * uOpen, .02, 2.);
  float curve = uExpr.y, squint = uExpr.z, brow = uExpr2.y;
  float t = clamp(p.x / hw, -1., 1.);
  float x = p.x, y = p.y;
  y += curve * hw * .44 * (1. - t * t);                         // undo: bend lifts the middle
  y /= 1. - min(abs(curve), 1.) * .5 * t * t;                   // undo: taper thins the tips
  if (squint > 0. && y > 0.) y /= 1. - clamp(squint, 0., 1.) * .62;   // undo: lower lid raised
  if (brow > 0. && y < 0.) y /= 1. - clamp(brow, 0., .85);       // undo: brow lowered
  float r = min(hw, hh) * .8;
  vec2 k = abs(vec2(x, y)) - vec2(hw, hh) + r;
  float d = length(max(k, 0.)) + min(max(k.x, k.y), 0.) - r;
  return d * (1. - min(abs(curve), 1.) * .5 * t * t);           // back to (roughly) screen distance
}
void main(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 d = (frag - uC.xy) / uC.z;
  float r = length(d);
  vec3 glowCol = mix(vec3(.05, .06, .09), vec3(.86, .9, 1.), uDark);
  if (r > 1.) {                                       // soft halo around the orb
    float g = exp(-(r - 1.) * 6.5) * smoothstep(1.6, 1., r) * mix(.16, .3 + .25 * uPulse, uDark);
    gl_FragColor = vec4(glowCol * g, g) * uAlpha;
    return;
  }
  const float D = 3.2; float tanA = 1. / sqrt(D * D - 1.);
  vec3 ro = vec3(0., 0., D), rd = normalize(vec3(d.x * tanA, -d.y * tanA, -1.));
  float bb = dot(ro, rd), cc = dot(ro, ro) - 1.;
  float tt = -bb - sqrt(max(bb * bb - cc, 0.));
  vec3 n = normalize(ro + rd * tt), V = -rd;
  vec3 q = rotX(-uLook.y) * rotY(-uLook.x) * n;       // into the orb's own frame (it turns toward the look point)
  float NV = max(dot(n, V), 0.);
  float px = 1. / uC.z / max(NV, .2);                  // one screen pixel, in sphere units, here
  // eyes
  // the face plane: the orb-frame point seen from the front (so the face wraps over the sphere as it turns)
  vec2 f = vec2(q.x, -q.y);
  f = vec2((f.x - uEyeMove.x) / uEyeMove.y, f.y / uEyeMove.y);
  float sep = .302 * uExpr2.x;
  float sd = min(jarvisEye(f - vec2(-sep, -.022), -1.), jarvisEye(f - vec2(sep, -.022), 1.)) * uEyeMove.y;
  float e = (q.z > .1 ? 1. - smoothstep(-px, px, sd) : 0.) * uEyes;
  // body lighting: key light upper left, soft fill from the right, a cool bounce from below
  vec3 K = normalize(vec3(-.55, .7, .55)), Fl = normalize(vec3(.8, .1, .6)), Bn = normalize(vec3(0., -1., .3));
  float key = max(dot(n, K), 0.), fill = max(dot(n, Fl), 0.), bounce = max(dot(n, Bn), 0.);
  float wrap = (dot(n, K) + .45) / 1.45;               // soft wrap-around, like a matte ceramic
  vec3 baseCol = mix(vec3(.063, .063, .067), vec3(.957, .957, .945), uDark);   // Noir #101011 / Paper #f4f4f1
  vec3 col = baseCol * (mix(.32, .58, uDark) + mix(.55, .4, uDark) * clamp(wrap, 0., 1.) + .12 * fill)
           + mix(vec3(.02, .03, .05), vec3(.08, .1, .14), uDark) * bounce;
  col *= mix(.62, 1., pow(NV, mix(.55, .3, uDark)));   // falls off towards the edge
  vec3 H = normalize(K + V);
  float NH = max(dot(n, H), 0.);
  float spec = pow(NH, 90.) * mix(1.1, .45, uDark) + pow(NH, 14.) * mix(.16, .07, uDark);
  float rim = pow(1. - NV, 3.2);
  col += vec3(spec) + glowCol * rim * mix(.3, .2, uDark);
  // eye colour: solid, like the app's flat themes - Paper #141414 on the white orb, Noir #f6f6f3 on the black one
  vec3 eyeCol = mix(vec3(.965, .965, .953) * (1. + .25 * uPulse), vec3(.078), uDark);
  col = mix(col, eyeCol, e);
  col = pow(col, vec3(.96));
  float aa = smoothstep(1., 1. - 1.6 / uC.z, r);
  gl_FragColor = vec4(col * aa + glowCol * mix(.16, .3, uDark) * (1. - aa), mix(mix(.16, .3, uDark), 1., aa)) * uAlpha;
}`;

  window.createOrb = function (canvas, opts = {}) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) return null;
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const prog = gl.createProgram();
    try {
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }"));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
    } catch (e) { console.error(e); return null; }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const u = { res: U("uRes"), c: U("uC"), look: U("uLook"), open: U("uOpen"), dark: U("uDark"), alpha: U("uAlpha"), mood: U("uMood"), pulse: U("uPulse"), eyes: U("uEyes"), expr: U("uExpr"), expr2: U("uExpr2"), move: U("uEyeMove") };
    // the app's expression presets (jarvis/core/expression.py): openness, curve, squint, width, spacing, brow
    const PRESETS = { 0: [1, .16, 0, 1, 1, 0], 1: [.5, 1, .3, 1.04, 1, 0], 2: [.7, .05, .5, .97, 1, .3], 3: [1.2, .2, 0, 1.03, 1.02, 0], 4: [.86, .5, .18, 1, 1, 0] };
    const ex = PRESETS[0].slice();
    const maxScale = opts.maxScale || Math.min(2.5, devicePixelRatio || 1);
    // blinking: every 2-6 s, sometimes twice; looking: eased toward the target, with small idle glances
    const st = { yaw: 0, pitch: 0, nextBlink: 1500, blinkAt: -1, double: false, glance: [0, 0], nextGlance: 3000 };
    function openness(t) {
      if (st.blinkAt < 0 && t > st.nextBlink) { st.blinkAt = t; st.double = Math.random() < .25; }
      if (st.blinkAt >= 0) {
        const k = (t - st.blinkAt) / 170;
        if (k >= 1) {
          if (st.double) { st.double = false; st.blinkAt = t + 90; }
          else { st.blinkAt = -1; st.nextBlink = t + 2000 + Math.random() * 4000; }
          return 1;
        }
        return k < 0 ? 1 : Math.abs(1 - 2 * k);
      }
      return 1;
    }
    return function draw({ W, H, cx, cy, R, t, look, dark, alpha = 1, mood = 0, pulse = 0, eyes = 1, eyeX = 0, eyeScale = 1 }) {
      const px = Math.min(maxScale, Math.sqrt((opts.budget || 9e6) / (W * H)));
      const w = Math.round(W * px), h = Math.round(H * px);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      // turn toward the look point (pixels); with none, drift and glance around now and then
      let ty = 0, tp = 0;
      if (look) { ty = Math.max(-1, Math.min(1, (look.x - cx) / (R * 3))) * .6; tp = Math.max(-1, Math.min(1, (look.y - cy) / (R * 3))) * .45; }
      else {
        if (t > st.nextGlance) { st.glance = [(Math.random() - .5) * .7, (Math.random() - .5) * .4]; st.nextGlance = t + 1800 + Math.random() * 3500; }
        [ty, tp] = st.glance;
      }
      st.yaw += (ty - st.yaw) * .09; st.pitch += (tp - st.pitch) * .09;
      gl.uniform2f(u.res, w, h); gl.uniform3f(u.c, cx * px, cy * px, Math.max(1, R * px));
      gl.uniform2f(u.look, st.yaw, st.pitch); gl.uniform1f(u.open, openness(t));
      gl.uniform1f(u.dark, dark ? 1 : 0); gl.uniform1f(u.alpha, alpha); gl.uniform1f(u.mood, mood); gl.uniform1f(u.pulse, pulse); gl.uniform1f(u.eyes, eyes);
      const target = PRESETS[mood] || PRESETS[0];
      for (let i = 0; i < 6; i++) ex[i] += (target[i] - ex[i]) * .12;   // melt from one expression into the next
      gl.uniform4f(u.expr, ex[0], ex[1], ex[2], ex[3]); gl.uniform2f(u.expr2, ex[4], ex[5]);
      gl.uniform2f(u.move, eyeX, Math.max(.05, eyeScale));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
  };
})();
