// The blue ocean planet from the old landing page, small enough to spin while a picture is being made.
// Every pixel shoots a camera ray at a sphere; the water is 3D noise over the whole globe (a slow swell plus
// layers of small drifting waves), lit by the sun with glitter, a fresnel sky reflection and an atmosphere glow.
// createPlanet(canvas) draws until the canvas leaves the page (or stop() is called).
(function () {
  const FS = `precision highp float;
uniform vec2 uRes; uniform vec3 uC; uniform float uTime, uTurn;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
// 3D simplex noise and its gradient (Ian McEwan / Stefan Gustavson, webgl-noise, MIT licence)
float snoiseG(vec3 v, out vec3 gradient){
  const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
  vec4 m2=m*m, m4=m2*m2;
  vec4 pdotx=vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3));
  vec4 temp=m2*m*pdotx;
  gradient=-8.*(temp.x*x0+temp.y*x1+temp.z*x2+temp.w*x3);
  gradient+=m4.x*p0+m4.y*p1+m4.z*p2+m4.w*p3;
  gradient*=42.;
  return 42.*dot(m4,pdotx);
}
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
float waves(vec3 q, float t, out vec3 grad){
  vec3 gg, gw;
  vec3 warp = .7 * vec3(snoiseG(q * 1.1 + t * .008, gw));
  float h = .5 * snoiseG(q * 1.3 + vec3(t * .02, 0., t * .015) + warp, gg);
  grad = .65 * gg;
  float a = .55, f = 3.2;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec3 dir = vec3(sin(fi * 2.1 + .3), cos(fi * 1.3), sin(fi * 3.7 + 1.));
    float n = snoiseG(q * f + dir * t * (.12 + .05 * fi), gg);
    float sq = sqrt(n * n + .03);
    h += a * (1. - sq); grad -= a * f * (n / sq) * gg;
    a *= .5; f *= 2.3;
  }
  for (int i = 2; i < 5; i++) {
    float fi = float(i);
    vec3 dir = vec3(sin(fi * 2.1 + .3), cos(fi * 1.3), sin(fi * 3.7 + 1.));
    h += a * snoiseG(q * f + dir * t * (.22 + .06 * fi), gg);
    grad += a * f * gg;
    a *= .36; f *= 2.13;
  }
  return h;
}
void main(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 d = (frag - uC.xy) / uC.z;
  float r = length(d);
  vec3 haloCol = vec3(.28, .58, 1.);
  if (r > 1.) { float g = exp(-(r - 1.) * 7.) * smoothstep(1.45, 1., r) * .8; gl_FragColor = vec4(haloCol * g, g); return; }
  const float D = 2.7; float tanA = 1. / sqrt(D * D - 1.);
  vec3 ro = vec3(0., 0., D), rd = normalize(vec3(d.x * tanA, -d.y * tanA, -1.));
  float b = dot(ro, rd), c = dot(ro, ro) - 1.;
  float tt = -b - sqrt(max(b * b - c, 0.));
  vec3 n0 = normalize(ro + rd * tt), V = -rd;
  vec3 L = normalize(vec3(-.55, .62, .56));
  mat3 R = rotX(.38) * rotY(uTurn);
  vec3 q = R * n0;
  vec3 g;
  float h0 = waves(q, uTime, g);
  g -= dot(g, q) * q;
  vec3 n = normalize(n0 - (g * R) * .012);
  float terminator = clamp(dot(n0, L) * 1.1 + .15, 0., 1.);
  float diff = max(dot(n, L), 0.);
  vec3 gc;
  float cur = .5 + .5 * snoiseG(q * 1.8 + vec3(0., uTime * .006, 0.), gc);
  vec3 deep = mix(vec3(.006, .04, .14), vec3(.025, .16, .40), cur);
  vec3 col = deep * (.05 + .95 * diff);
  col += vec3(0., .09, .16) * smoothstep(.15, .9, h0) * terminator * .7;
  float NV = max(dot(n, V), 0.);
  float F = .02 + .98 * pow(1. - NV, 5.);
  col = mix(col, vec3(.36, .62, 1.) * (.18 + .82 * terminator), F * .8);
  vec3 H = normalize(L + V); float NH = max(dot(n, H), 0.);
  col += vec3(1., .97, .9) * (pow(NH, 1100.) * 7. + pow(NH, 120.) * .35 + pow(NH, 18.) * .05) * terminator;
  float rim = pow(1. - max(dot(n0, V), 0.), 3.);
  col += vec3(.2, .5, 1.) * rim * (.2 + .9 * terminator);
  col = 1. - exp(-col * 1.7);
  float aa = smoothstep(1., 1. - 1.6 / uC.z, r);
  gl_FragColor = vec4(col * aa + haloCol * .8 * (1. - aa), mix(.8, 1., aa));
}`;

  window.createPlanet = function (cv) {
    const gl = cv.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
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
    const uRes = gl.getUniformLocation(prog, "uRes"), uC = gl.getUniformLocation(prog, "uC"), uTime = gl.getUniformLocation(prog, "uTime"), uTurn = gl.getUniformLocation(prog, "uTurn");
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let stopped = false;
    const frame = (now) => {
      if (stopped || !cv.isConnected) { gl.getExtension("WEBGL_lose_context")?.loseContext(); return; }
      const px = Math.min(1.5, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
      const w = Math.max(1, Math.round(W * px)), h = Math.max(1, Math.round(H * px));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
      const t = still ? 0 : (now - t0) / 1000;
      gl.uniform2f(uRes, w, h);
      gl.uniform3f(uC, w / 2, h * .44, Math.min(w, h) * .3);   // a little above the middle, leaving room for the progress text
      gl.uniform1f(uTime, 20 + t); gl.uniform1f(uTurn, t * .045);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return { stop() { stopped = true; } };
  };
})();
