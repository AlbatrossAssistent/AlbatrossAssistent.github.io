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
uniform float uMood;    // 0 neutral, 1 happy (eyes curve up), 2 thinking (narrow), 3 listening (wide)
uniform float uPulse;   // 0..1 glow while busy
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
// one eye: a rounded, slightly curved lozenge on the sphere around direction E
float eye(vec3 q, vec3 E, float px){
  if (dot(q, E) < .6) return 0.;
  vec3 t = normalize(cross(vec3(0., 1., 0.), E)), b = cross(E, t);
  vec3 d = q - E;
  float u = dot(d, t), v = dot(d, b);
  float w = .085 * (uMood > 2.5 ? 1.15 : 1.), h = .155 * max(uOpen, .06) * (uMood > 1.5 && uMood < 2.5 ? .45 : 1.) * (uMood > 2.5 ? 1.12 : 1.);
  float curve = uMood > .5 && uMood < 1.5 ? .9 : .18;            // happy: an upward arc
  v -= curve * h * (1. - pow(u / w, 2.)) * .45;
  float k = pow(abs(u) / w, 2.6) + pow(abs(v) / h, 2.6);
  float edge = px / min(w, h) * 2.2;
  return 1. - smoothstep(1. - edge, 1. + edge, k);
}
void main(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 d = (frag - uC.xy) / uC.z;
  float r = length(d);
  vec3 glowCol = mix(vec3(.05, .06, .09), vec3(.85, .9, 1.), uDark);
  if (r > 1.) {                                       // soft halo around the orb
    float g = exp(-(r - 1.) * 6.) * smoothstep(1.6, 1., r) * mix(.16, .32 + .25 * uPulse, uDark);
    gl_FragColor = vec4(glowCol * g, g) * uAlpha;
    return;
  }
  const float D = 2.8; float tanA = 1. / sqrt(D * D - 1.);
  vec3 ro = vec3(0., 0., D), rd = normalize(vec3(d.x * tanA, -d.y * tanA, -1.));
  float bb = dot(ro, rd), cc = dot(ro, ro) - 1.;
  float tt = -bb - sqrt(max(bb * bb - cc, 0.));
  vec3 n = normalize(ro + rd * tt), V = -rd;
  vec3 q = rotX(-uLook.y) * rotY(-uLook.x) * n;       // into the orb's own frame (it turns toward the look point)
  vec3 L = normalize(vec3(-.5, .65, .6));
  float diff = max(dot(n, L), 0.), NV = max(dot(n, V), 0.);
  float px = 1. / uC.z / max(NV, .25);
  float e = max(eye(q, normalize(vec3(-.3, .1, .95)), px), eye(q, normalize(vec3(.3, .1, .95)), px));
  // body: matte with a soft studio light, darker towards the edge, a glossy highlight on top
  vec3 baseCol = mix(vec3(.07, .075, .085), vec3(.95, .955, .965), uDark);
  vec3 col = baseCol * (mix(.55, .62, uDark) + mix(.6, .45, uDark) * diff);
  col *= mix(.55, 1., pow(NV, mix(.6, .35, uDark)));             // falls off towards the rim
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.), 60.) * mix(.9, .35, uDark) + pow(max(dot(n, H), 0.), 8.) * mix(.12, .05, uDark);
  float rim = pow(1. - NV, 3.);
  col += vec3(spec) + glowCol * rim * mix(.25, .18, uDark);
  // eyes: dark on the white orb, glowing light on the black one
  vec3 eyeCol = mix(vec3(.93, .96, 1.) * (1.05 + .3 * uPulse), vec3(.04, .045, .06), uDark);
  col = mix(col, eyeCol + vec3(spec) * .6, e);
  float aa = smoothstep(1., 1. - 1.6 / uC.z, r);
  gl_FragColor = vec4(col * aa + glowCol * mix(.16, .32, uDark) * (1. - aa), mix(mix(.16, .32, uDark), 1., aa)) * uAlpha;
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
    const u = { res: U("uRes"), c: U("uC"), look: U("uLook"), open: U("uOpen"), dark: U("uDark"), alpha: U("uAlpha"), mood: U("uMood"), pulse: U("uPulse") };
    const maxScale = opts.maxScale || Math.min(2, devicePixelRatio || 1);
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
    return function draw({ W, H, cx, cy, R, t, look, dark, alpha = 1, mood = 0, pulse = 0 }) {
      const px = Math.min(maxScale, Math.sqrt((opts.budget || 6e6) / (W * H)));
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
      gl.uniform1f(u.dark, dark ? 1 : 0); gl.uniform1f(u.alpha, alpha); gl.uniform1f(u.mood, mood); gl.uniform1f(u.pulse, pulse);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
  };
})();
