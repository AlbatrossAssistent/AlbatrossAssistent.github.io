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
uniform float uEyes;    // 1 = eyes shown, 0 = hidden (something else is shown on the orb)
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
// Jarvis's eyes: rounded rectangles (proportions from the desktop app: half-size 0.196 x 0.272 of the radius,
// 0.302 apart), drawn as a signed distance on the sphere's surface so edges stay crisp at any size.
// Returns the distance (negative inside) in sphere units.
float eyeSD(vec3 q, vec3 E, out vec2 uv){
  vec3 t = normalize(cross(vec3(0., 1., 0.), E)), b = cross(E, t);
  vec3 d = q - E * dot(q, E);                        // onto the eye's tangent plane
  uv = vec2(dot(d, t), dot(d, b));
  if (dot(q, E) < .55) return 1.;
  float hw = .196 * (uMood > 2.5 ? 1.1 : 1.), hh = .272 * max(uOpen, .05);
  if (uMood > 1.5 && uMood < 2.5) hh *= .5;            // thinking: narrowed
  if (uMood > 2.5) hh *= 1.08;                         // listening: a little wider open
  vec2 p = uv;
  if (uMood > .5 && uMood < 1.5) p.y -= .55 * hh * (1. - pow(clamp(p.x / hw, -1., 1.), 2.));   // happy: bowed into an arc
  float r = min(hw, hh) * .42;                         // corner: squarish, like the app
  vec2 k = abs(p) - vec2(hw, hh) + r;
  return length(max(k, 0.)) + min(max(k.x, k.y), 0.) - r;
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
  vec2 uv1, uv2;
  float s1 = eyeSD(q, normalize(vec3(-.302, .022, .953)), uv1), s2 = eyeSD(q, normalize(vec3(.302, .022, .953)), uv2);
  float sd = min(s1, s2); vec2 uv = s1 < s2 ? uv1 : uv2;
  float e = (1. - smoothstep(-px, px, sd)) * uEyes;
  // body lighting: key light upper left, soft fill from the right, a cool bounce from below
  vec3 K = normalize(vec3(-.55, .7, .55)), Fl = normalize(vec3(.8, .1, .6)), Bn = normalize(vec3(0., -1., .3));
  float key = max(dot(n, K), 0.), fill = max(dot(n, Fl), 0.), bounce = max(dot(n, Bn), 0.);
  float wrap = (dot(n, K) + .45) / 1.45;               // soft wrap-around, like a matte ceramic
  vec3 baseCol = mix(vec3(.055, .058, .068), vec3(.955, .958, .965), uDark);
  vec3 col = baseCol * (mix(.32, .58, uDark) + mix(.55, .4, uDark) * clamp(wrap, 0., 1.) + .12 * fill)
           + mix(vec3(.02, .03, .05), vec3(.08, .1, .14), uDark) * bounce;
  col *= mix(.62, 1., pow(NV, mix(.55, .3, uDark)));   // falls off towards the edge
  // eyes sit slightly into the surface: a soft dark ring around them on the white orb
  float ring = exp(-max(sd, 0.) / (px * 3. + .012)) * (1. - e) * uEyes;
  col *= 1. - ring * mix(.18, .06, uDark);
  vec3 H = normalize(K + V);
  float NH = max(dot(n, H), 0.);
  float spec = pow(NH, 90.) * mix(1.1, .45, uDark) + pow(NH, 14.) * mix(.16, .07, uDark);
  float rim = pow(1. - NV, 3.2);
  col += vec3(spec) + glowCol * rim * mix(.3, .2, uDark);
  // eye colour, with a little depth and a soft highlight in the upper corner, like the app's
  vec3 eyeCol = mix(vec3(.94, .97, 1.) * (1.04 + .3 * uPulse), vec3(.035, .04, .052), uDark);
  float inner = smoothstep(0., -.08, sd);
  eyeCol *= mix(1., mix(.9, 1.25, uDark) , 1. - inner);
  float hl = exp(-dot(uv - vec2(-.07, .12), uv - vec2(-.07, .12)) / .0016);
  eyeCol += vec3(hl) * mix(.15, .55, uDark);
  col = mix(col, eyeCol + vec3(spec) * .5, e);
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
    const u = { res: U("uRes"), c: U("uC"), look: U("uLook"), open: U("uOpen"), dark: U("uDark"), alpha: U("uAlpha"), mood: U("uMood"), pulse: U("uPulse"), eyes: U("uEyes") };
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
    return function draw({ W, H, cx, cy, R, t, look, dark, alpha = 1, mood = 0, pulse = 0, eyes = 1 }) {
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
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
  };
})();
