// Sunny world: an endless glide over a luminous sea of clouds.
//
// Technique: the cloud deck is one large plane shaded from a tiling fbm
// texture (height + precomputed gradient for relief lighting). Towers,
// floating cumulus and deck bumps are camera-facing soft puffs drawn as a
// single instanced mesh. The CPU moves, recycles and depth-sorts the puffs
// each frame (insertion sort on an almost-sorted list is O(n)), so blending
// is correct without any render targets. Fog, sky and clouds share one sky
// colour function, so distant clouds melt into the horizon haze.

const FAR = 2600;            // depth of the cloud field; haze reaches the sky colour here
const BEHIND = 220;          // clouds are recycled this far behind the camera
const HALF_W = FAR * 1.15;   // lateral half-width of the cloud field
const DECK_PERIOD = 2400;    // world size of the largest deck noise tile
const SKY_RADIUS = 6000;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const TOWER = 0;
const FLOATER = 1;
const DECK = 2;

// Art-directed palettes (sRGB hex). lit/shade: sunlit and shadowed cloud.
const PALETTES = {
  day: {
    zenith: 0x1f5fc4, horizon: 0xc4dcf2, ground: 0x7d9cc2, glow: 0xfff1d8, light: 0xfff4e4,
    lit: 0xf4f7fc, shade: 0x8aa2c6, glowAmt: 1.0, exposure: 0.86, sun: 1, night: 0,
  },
  dawn: {
    zenith: 0x36478c, horizon: 0xf4b48c, ground: 0x7a6c94, glow: 0xffb06c, light: 0xffc590,
    lit: 0xffd6b4, shade: 0x77699c, glowAmt: 1.45, exposure: 0.9, sun: 1, night: 0,
  },
  dusk: {
    zenith: 0x272c6c, horizon: 0xee8c62, ground: 0x5c4a74, glow: 0xff8644, light: 0xffa068,
    lit: 0xffbe96, shade: 0x67528a, glowAmt: 1.6, exposure: 0.9, sun: 1, night: 0,
  },
  night: {
    zenith: 0x030817, horizon: 0x15233f, ground: 0x0a1226, glow: 0x9db6e8, light: 0xc6d4f4,
    lit: 0x8c9ec6, shade: 0x1b2544, glowAmt: 0.55, exposure: 1.0, sun: 0, night: 1,
  },
};
const COLOR_KEYS = ['zenith', 'horizon', 'ground', 'glow', 'light', 'lit', 'shade'];
const SCALAR_KEYS = ['glowAmt', 'exposure', 'sun', 'night'];

// ---------------------------------------------------------------- noise

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Periodic value noise: repeats every `period` lattice cells.
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x, y, basePeriod, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * period, y * period, period, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

function normalize01(field) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.length; i++) {
    lo = Math.min(lo, field[i]);
    hi = Math.max(hi, field[i]);
  }
  const span = hi - lo || 1;
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - lo) / span;
}

const GRAD_ENCODE = 12; // gradients are stored as 0.5 + d/dtexel * GRAD_ENCODE

function writeTexel(out, i, r, g, gx, gy) {
  const o = i * 4;
  out[o] = Math.round(Math.min(1, Math.max(0, r)) * 255);
  out[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
  out[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + gx * GRAD_ENCODE)) * 255);
  out[o + 3] = Math.round(Math.min(1, Math.max(0, 0.5 + gy * GRAD_ENCODE)) * 255);
}

// Tiling deck noise. R: fbm height, G: second fbm, BA: gradient of R.
function buildDeckNoise(size) {
  const height = new Float32Array(size * size);
  const other = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Billowy: fold the noise so it reads as rounded heaps, not marble.
      const n = fbm(u, v, 4, 6, 11);
      height[y * size + x] = 1 - Math.abs(n * 2 - 1) * 0.55 + n * 0.45;
      other[y * size + x] = fbm(u, v, 3, 5, 97);
    }
  }
  normalize01(height);
  normalize01(other);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const gx = (height[y * size + ((x + 1) % size)] - height[y * size + ((x - 1 + size) % size)]) * 0.5;
      const gy = (height[((y + 1) % size) * size + x] - height[((y - 1 + size) % size) * size + x]) * 0.5;
      writeTexel(out, i, height[i], other[i], gx, gy);
    }
  }
  return out;
}

// 2x2 atlas of lumpy cumulus puffs. R: density, G: bump height, BA: bump gradient.
function buildPuffAtlas(cell) {
  const size = cell * 2;
  const density = new Float32Array(size * size);
  const bump = new Float32Array(size * size);
  const rng = mulberry32(7);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * cell;
    const oy = Math.floor(v / 2) * cell;
    const lobes = [];
    const count = 5 + (v % 3);
    for (let k = 0; k < count; k++) {
      const a = rng() * TAU;
      const d = k === 0 ? 0 : 0.18 + rng() * 0.28;
      lobes.push([Math.cos(a) * d, Math.sin(a) * d, 0.28 + rng() * 0.2]);
    }
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const px = ((x + 0.5) / cell) * 2 - 1;
        const py = ((y + 0.5) / cell) * 2 - 1;
        const r = Math.hypot(px, py);
        let s = 0;
        for (const [cx, cy, cr] of lobes) {
          const dx = px - cx;
          const dy = py - cy;
          s = Math.max(s, Math.exp(-((dx * dx + dy * dy) / (cr * cr)) * 1.6));
        }
        const n = fbm(px * 0.5 + v * 3.1, py * 0.5 + v * 1.7, 4, 4, 5 + v);
        const edge = 1 - smooth(0.72, 0.98, r);
        const i = (oy + y) * size + ox + x;
        density[i] = Math.min(1, Math.max(0, (s * 1.05 - 0.3 + (n - 0.5) * 0.7) * 2.1)) * edge;
        bump[i] = Math.min(1, Math.max(0, s * 0.75 + (n - 0.5) * 0.5 + 0.1)) * edge;
      }
    }
  }
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xl = Math.max(0, x - 1);
      const xr = Math.min(size - 1, x + 1);
      const yd = Math.max(0, y - 1);
      const yu = Math.min(size - 1, y + 1);
      const gx = (bump[y * size + xr] - bump[y * size + xl]) * 0.5;
      const gy = (bump[yu * size + x] - bump[yd * size + x]) * 0.5;
      writeTexel(out, i, density[i], bump[i], gx, gy);
    }
  }
  return out;
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Texture pixels are generated once per page and reused by later worlds.
let texelCache = null;
function texels() {
  texelCache ??= { deck: buildDeckNoise(256), puffs: buildPuffAtlas(128) };
  return texelCache;
}

// ---------------------------------------------------------------- shaders

const COMMON = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform vec3 uLightDir;
uniform vec3 uLight;
uniform vec3 uLit;
uniform vec3 uShade;
uniform float uFogFar;
uniform float uExposure;
uniform float uTime;
uniform sampler2D uNoise;
uniform vec2 uShift;
uniform float uCoverage;
uniform float uDeckY;

vec3 skyColor(vec3 d) {
  float y = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.55));
  col = mix(col, uHorizon * 1.06, exp(-abs(y) * 22.0) * 0.5);
  col = mix(col, uGround, smoothstep(0.0, -0.24, y));
  float mu = max(dot(d, uLightDir), 0.0);
  float band = exp(-abs(y - uLightDir.y) * 2.5);
  col += uGlow * uGlowAmt * (0.22 * mu * mu * band + 0.3 * pow(mu, 14.0) + 0.5 * pow(mu, 160.0));
  return col;
}

float fogAmount(float dist) {
  float x = dist / uFogFar;
  return max(1.0 - exp(-x * x * 2.2 - x * 0.45), smoothstep(0.95, 1.35, x));
}

float dither(vec2 p) {
  return (fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
${COMMON}
uniform float uSunAmt;
uniform float uMoonAmt;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = skyColor(d);
  float mu = dot(d, uLightDir);
  col += uLight * smoothstep(0.99994, 0.99996, mu) * 40.0 * uSunAmt;

  // Moon: mottled disc with a soft gibbous terminator.
  const float moonR = 0.021;
  vec3 t1 = normalize(cross(uLightDir, vec3(0.0, 1.0, 0.0)));
  vec3 t2 = cross(t1, uLightDir);
  vec2 q = vec2(dot(d, t1), dot(d, t2)) / moonR;
  float disc = (1.0 - smoothstep(0.93, 1.0, length(q))) * step(0.0, mu);
  float maria = textureLod(uNoise, q * 0.16 + 0.31, 0.0).g;
  float lit = smoothstep(-0.75, -0.35, q.x + 0.25 * q.y * q.y);
  col += vec3(1.0, 0.97, 0.9) * disc * lit * (1.6 + 0.9 * smoothstep(0.35, 0.75, maria)) * uMoonAmt;

  gl_FragColor = vec4(col * uExposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb += dither(gl_FragCoord.xy);
}`;

const STAR_VERT = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform float uPixelRatio;
attribute vec2 aStar; // x: size, y: seed
varying float vAlpha;
void main() {
  vec3 d = normalize(position);
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.3 + aStar.y * 2.7) + aStar.y * 40.0);
  vAlpha = uNight * twinkle * smoothstep(0.03, 0.25, d.y);
  gl_PointSize = aStar.x * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const STAR_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, r) * vAlpha;
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, 1.0);
  #include <colorspace_fragment>
}`;

const DECK_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const DECK_FRAG = /* glsl */ `
${COMMON}
varying vec3 vWorld;
void main() {
  vec2 p = vWorld.xz - uShift;
  vec4 a = texture(uNoise, p / ${DECK_PERIOD.toFixed(1)});
  vec4 b = texture(uNoise, p / ${(DECK_PERIOD / 3).toFixed(1)} + vec2(0.37, 0.11));
  float h = a.r * 0.62 + b.r * 0.38;
  vec2 g = (a.ba - 0.5) * (0.62 * 256.0 / ${DECK_PERIOD.toFixed(1)}) + (b.ba - 0.5) * (0.38 * 256.0 / ${(DECK_PERIOD / 3).toFixed(1)});
#if DECK_DETAIL
  vec4 c = texture(uNoise, p / ${(DECK_PERIOD / 10).toFixed(1)} + vec2(0.71, 0.53));
  h = h * 0.84 + c.r * 0.16;
  g = g * 0.84 + (c.ba - 0.5) * (0.16 * 256.0 / ${(DECK_PERIOD / 10).toFixed(1)});
#endif
  g /= ${GRAD_ENCODE.toFixed(1)};

  vec3 V = vWorld - cameraPosition;
  float dist = length(V);
  vec3 vd = V / dist;
  float cover = smoothstep(uCoverage, uCoverage + 0.17, h);

  // Relief: the deck height field spans roughly 110 world units.
  vec3 n = normalize(vec3(-g.x * 110.0, 1.0, -g.y * 110.0));
  float slope = clamp(0.55 + (dot(n, uLightDir) - uLightDir.y) * 2.6, 0.0, 1.0);
  float tops = smoothstep(uCoverage, uCoverage + 0.5, h);
  vec3 col = mix(uShade, uLit, slope * mix(0.55, 1.0, tops));
  col += uZenith * 0.05 * (1.0 - tops);

  // Sea of light toward the sun; thin edges glow.
  float mu = max(dot(vd, uLightDir), 0.0);
  col += uLight * pow(mu, 6.0) * (0.22 + 0.4 * (1.0 - cover));

  col = mix(col, skyColor(vd), fogAmount(dist));
  gl_FragColor = vec4(col * uExposure, cover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb += dither(gl_FragCoord.xy);
}`;

const PUFF_VERT = /* glsl */ `
${COMMON}
uniform vec3 uCamRight;
uniform vec3 uCamUp;
attribute vec4 aPuff;   // xyz: centre, w: radius
attribute vec4 aInfo;   // x: height within its cloud, y: rotation, z: opacity, w: vertical aspect
varying vec2 vQ;
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vInfo;     // x: height, y: opacity, z: fog, w: deck puff
varying vec3 vFogCol;
varying vec3 vView;
varying float vY;

float deckHeight(vec2 p) {
  float a = textureLod(uNoise, p / ${DECK_PERIOD.toFixed(1)}, 2.0).r;
  float b = textureLod(uNoise, p / ${(DECK_PERIOD / 3).toFixed(1)} + vec2(0.37, 0.11), 2.0).r;
  return a * 0.62 + b * 0.38;
}

void main() {
  vec3 center = aPuff.xyz;
  float size = aPuff.w;
  vec3 toC = center - cameraPosition;
  float dist = length(toC);
  vView = toC / dist;
  vQ = position.xy;
  vec3 wp = center + (uCamRight * position.x + uCamUp * (position.y * aInfo.w)) * size;

  float c = cos(aInfo.y);
  float s = sin(aInfo.y);
  vRot = vec2(c, s);
  vec2 r = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  float cell = floor(fract(aInfo.y * 0.618034) * 4.0);
  vUv = (vec2(mod(cell, 2.0), floor(cell * 0.5)) + r * 0.5 + 0.5) * 0.5;

  float deck = step(aInfo.w, 0.75);
  // Fade out when very close (flying through becomes a soft whiteout) and at the far edge.
  float alpha = aInfo.z * smoothstep(0.35, 1.05, dist / size) * (1.0 - smoothstep(0.92, 1.08, dist / uFogFar));
  if (deck > 0.5) alpha *= smoothstep(uCoverage - 0.04, uCoverage + 0.16, deckHeight(center.xz - uShift));

  vInfo = vec4(aInfo.x, alpha, fogAmount(dist), deck);
  vFogCol = skyColor(vView);
  vY = wp.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const PUFF_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform sampler2D uPuffTex;
varying vec2 vQ;
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vInfo;
varying vec3 vFogCol;
varying vec3 vView;
varying float vY;

void main() {
  float r2 = dot(vQ, vQ);
  if (r2 >= 1.0) discard;
  vec4 t = texture(uPuffTex, vUv);
  float a = t.r * vInfo.y;
  // Melt the bases of clouds softly into the deck instead of cutting through it.
  a *= vInfo.w > 0.5 ? smoothstep(uDeckY - 40.0, uDeckY + 6.0, vY) : smoothstep(uDeckY - 6.0, uDeckY + 40.0, vY);
  if (a < 0.003) discard;

  // Fake sphere normal, perturbed by the puff's bumps (gradient un-rotated to quad space).
  vec2 g = (t.ba - 0.5) * (64.0 / ${GRAD_ENCODE.toFixed(1)});
  g = vec2(vRot.x * g.x + vRot.y * g.y, -vRot.y * g.x + vRot.x * g.y);
  float nz = sqrt(1.0 - r2);
  vec3 n = normalize(uCamRight * (vQ.x - g.x * 0.35) + uCamUp * (vQ.y - g.y * 0.35) - vView * nz);

  float ndl = dot(n, uLightDir);
  float height = clamp(vInfo.x + vQ.y * 0.12, 0.0, 1.0);
  float light = clamp(ndl * 0.55 + 0.5, 0.0, 1.0) * mix(0.5, 1.0, smoothstep(0.0, 0.85, height));
  vec3 col = mix(uShade, uLit, light);
  col += uZenith * 0.06 * (n.y * 0.5 + 0.5);

  // Silver lining when looking toward the light, warm rim on the lit side.
  float mu = max(dot(vView, uLightDir), 0.0);
  col += uLight * (pow(mu, 10.0) * (1.0 - t.r) * 1.1 + pow(mu, 3.0) * 0.1);
  col += uLight * pow(1.0 - nz, 2.0) * max(ndl, 0.0) * 0.3;

  col = mix(col, vFogCol, vInfo.z);
  gl_FragColor = vec4(col * uExposure, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const GLARE_VERT = /* glsl */ `
uniform vec3 uLightDir;
uniform float uGlareSize;
varying vec2 vQ;
void main() {
  vQ = position.xy;
  vec4 c = viewMatrix * vec4(cameraPosition + uLightDir * 4000.0, 1.0);
  c.xy += position.xy * uGlareSize;
  gl_Position = projectionMatrix * c;
}`;

const GLARE_FRAG = /* glsl */ `
uniform vec3 uLight;
uniform float uExposure;
uniform float uTime;
uniform float uGlareAmt;
uniform float uRays;
varying vec2 vQ;
void main() {
  float r = length(vQ);
  float halo = exp(-r * 26.0) * 1.1 + exp(-r * 8.0) * 0.28 + exp(-r * 2.8) * 0.08;
  // Faint god-ray shafts: integer angular frequencies keep atan's seam invisible.
  float ang = atan(vQ.y, vQ.x);
  float rays = 0.5 + 0.5 * sin(ang * 11.0 + 2.0 * sin(ang * 3.0 + uTime * 0.05));
  rays *= 0.5 + 0.5 * sin(ang * 17.0 - uTime * 0.03);
  rays = rays * rays * rays * exp(-r * 3.4) * smoothstep(0.03, 0.14, r);
  float fade = 1.0 - smoothstep(0.6, 1.0, r);
  gl_FragColor = vec4(uLight * (halo * uGlareAmt + rays * uRays) * fade * uExposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const BIRD_VERT = /* glsl */ `
${COMMON}
uniform vec3 uFlock;
uniform float uBirdScale;
attribute vec4 aBird;   // xyz: offset in the flock, w: phase
varying float vFog;
varying vec3 vFogCol;
void main() {
  vec3 p = position;
  float along = abs(p.x) * 2.0;
  float flap = sin(uTime * (6.5 + fract(aBird.w * 7.0) * 2.0) + aBird.w * 6.2832);
  p.y += flap * 0.34 * along * (0.5 + 0.5 * along);
  vec3 wp = uFlock + aBird.xyz + p * uBirdScale;
  vec3 toP = wp - cameraPosition;
  float d = length(toP);
  vFog = fogAmount(d) * 0.8;
  vFogCol = skyColor(toP / d);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const BIRD_FRAG = /* glsl */ `
uniform vec3 uShade;
uniform float uExposure;
uniform float uFlockAlpha;
varying float vFog;
varying vec3 vFogCol;
void main() {
  gl_FragColor = vec4(mix(uShade * 0.22, vFogCol, vFog) * uExposure, uFlockAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const METEOR_VERT = /* glsl */ `
uniform vec3 uHead;
uniform vec3 uTail;
varying vec2 vQ;
void main() {
  vQ = vec2(position.x + 0.5, position.y * 2.0);
  vec4 h = viewMatrix * vec4(uHead, 1.0);
  vec4 t = viewMatrix * vec4(uTail, 1.0);
  vec4 p = mix(t, h, vQ.x);
  vec2 dir = normalize(h.xy - t.xy);
  p.xy += vec2(-dir.y, dir.x) * vQ.y * 5.0 * (0.3 + 0.7 * vQ.x);
  gl_Position = projectionMatrix * p;
}`;

const METEOR_FRAG = /* glsl */ `
uniform float uMeteor;
varying vec2 vQ;
void main() {
  float a = pow(vQ.x, 2.5) * (1.0 - abs(vQ.y)) * uMeteor;
  gl_FragColor = vec4(vec3(0.85, 0.92, 1.0) * a * 1.4, 1.0);
  #include <colorspace_fragment>
}`;

const VEIL_VERT = /* glsl */ `
varying vec2 vQ;
void main() {
  vQ = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const VEIL_FRAG = /* glsl */ `
uniform vec3 uVeilColor;
uniform float uVeil;
varying vec2 vQ;
void main() {
  float a = uVeil * (0.82 + 0.18 * smoothstep(1.4, 0.0, length(vQ)));
  gl_FragColor = vec4(uVeilColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- world

export function create(engine) {
  const { THREE, renderer, quality, isMobile } = engine;
  const density = quality.density;
  const disposables = [];
  const keep = (thing) => {
    disposables.push(thing);
    return thing;
  };

  const rng = mulberry32(20261116);
  const rand = (a, b) => a + (b - a) * rng();
  const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 1, 9000);
  camera.rotation.order = 'YXZ';

  // ---- textures
  const pixels = texels();
  const deckTex = keep(new THREE.DataTexture(pixels.deck, 256, 256, THREE.RGBAFormat));
  deckTex.wrapS = deckTex.wrapT = THREE.RepeatWrapping;
  deckTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const puffTex = keep(new THREE.DataTexture(pixels.puffs, 256, 256, THREE.RGBAFormat));
  for (const tex of [deckTex, puffTex]) {
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  }

  // ---- palette state (cur eases toward tgt)
  const makePalette = (src) => {
    const p = {};
    for (const k of COLOR_KEYS) p[k] = new THREE.Color(src ? src[k] : 0);
    for (const k of SCALAR_KEYS) p[k] = src ? src[k] : 0;
    return p;
  };
  const palettes = {};
  for (const name of Object.keys(PALETTES)) palettes[name] = makePalette(PALETTES[name]);
  const cur = makePalette(PALETTES.day);
  const tgt = makePalette(PALETTES.day);
  const grey = new THREE.Color(0x9aa3b0);
  const warmHaze = new THREE.Color(0xf4dcc0);
  const coolHaze = new THREE.Color(0xd6e6ff);

  const U = {
    uZenith: { value: cur.zenith },
    uHorizon: { value: cur.horizon },
    uGround: { value: cur.ground },
    uGlow: { value: cur.glow },
    uGlowAmt: { value: 1 },
    uLightDir: { value: new THREE.Vector3(0.3, 0.3, -0.9).normalize() },
    uLight: { value: cur.light },
    uLit: { value: cur.lit },
    uShade: { value: cur.shade },
    uFogFar: { value: FAR },
    uExposure: { value: 1 },
    uTime: { value: 0 },
    uNoise: { value: deckTex },
    uShift: { value: new THREE.Vector2() },
    uCoverage: { value: 0.3 },
    uDeckY: { value: -120 },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
  };

  const material = (opts) => keep(new THREE.ShaderMaterial({ depthWrite: false, ...opts }));

  // ---- sky dome
  const skyU = { ...U, uSunAmt: { value: 1 }, uMoonAmt: { value: 0 } };
  const sky = new THREE.Mesh(
    keep(new THREE.SphereGeometry(SKY_RADIUS, 48, 24)),
    material({ uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthTest: false }),
  );
  sky.renderOrder = 0;
  sky.frustumCulled = false;
  scene.add(sky);

  // ---- stars
  const starCount = Math.round((isMobile ? 650 : 1000) * (0.6 + 0.4 * density));
  const starPos = new Float32Array(starCount * 3);
  const starInfo = new Float32Array(starCount * 2);
  for (let i = 0; i < starCount; i++) {
    const y = 0.02 + 0.98 * Math.pow(rng(), 0.8);
    const a = rng() * TAU;
    const rr = Math.sqrt(1 - y * y);
    starPos.set([Math.cos(a) * rr * 5000, y * 5000, Math.sin(a) * rr * 5000], i * 3);
    const bright = rng();
    starInfo.set([1.2 + bright * bright * bright * 2.6, rng()], i * 2);
  }
  const starGeo = keep(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aStar', new THREE.BufferAttribute(starInfo, 2));
  const starU = { uTime: U.uTime, uNight: { value: 0 }, uPixelRatio: { value: 1 } };
  const stars = new THREE.Points(
    starGeo,
    material({ uniforms: starU, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, depthTest: false, transparent: true, blending: THREE.AdditiveBlending }),
  );
  stars.renderOrder = 1;
  stars.frustumCulled = false;
  scene.add(stars);

  // ---- shooting star
  const meteorU = { uHead: { value: new THREE.Vector3() }, uTail: { value: new THREE.Vector3() }, uMeteor: { value: 0 } };
  const meteor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(1, 1)),
    material({ uniforms: meteorU, vertexShader: METEOR_VERT, fragmentShader: METEOR_FRAG, depthTest: false, transparent: true, blending: THREE.AdditiveBlending }),
  );
  meteor.renderOrder = 1;
  meteor.frustumCulled = false;
  meteor.visible = false;
  scene.add(meteor);
  const meteorState = { t: 0, life: 0, wait: rand(4, 9), head: new THREE.Vector3(), vel: new THREE.Vector3() };

  // ---- cloud deck
  const deck = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(HALF_W * 2.6, FAR * 2.2)),
    material({
      uniforms: U,
      vertexShader: DECK_VERT,
      fragmentShader: DECK_FRAG,
      transparent: true,
      depthTest: false,
      defines: { DECK_DETAIL: quality.level === 'low' ? 0 : 1 },
    }),
  );
  deck.rotation.x = -Math.PI / 2;
  deck.position.z = -FAR * 0.5;
  deck.renderOrder = 2;
  deck.frustumCulled = false;
  scene.add(deck);

  // ---- birds (one tiny flock now and then, by day)
  const birdCount = 11;
  const wing = [
    [0, 0.035], [0, -0.05], [0.2, -0.015],
    [0, 0.035], [0.2, -0.015], [0.22, 0.03],
    [0.22, 0.03], [0.2, -0.015], [0.5, 0],
  ];
  const birdVerts = [];
  for (const side of [-1, 1]) for (const [x, y] of wing) birdVerts.push(x * side, y, 0);
  const birdGeo = keep(new THREE.InstancedBufferGeometry());
  birdGeo.setAttribute('position', new THREE.Float32BufferAttribute(birdVerts, 3));
  const birdData = new Float32Array(birdCount * 4);
  for (let k = 0; k < birdCount; k++) {
    const side = k % 2 ? 1 : -1;
    const row = Math.ceil(k / 2);
    birdData.set([side * row * 6 + rand(-1.5, 1.5), -row * 0.9 + rand(-1.2, 1.2), row * 5 + rand(-2, 2), rng()], k * 4);
  }
  birdGeo.setAttribute('aBird', new THREE.InstancedBufferAttribute(birdData, 4));
  birdGeo.instanceCount = birdCount;
  const birdU = { ...U, uFlock: { value: new THREE.Vector3() }, uBirdScale: { value: 3.6 }, uFlockAlpha: { value: 0 } };
  const birds = new THREE.Mesh(
    birdGeo,
    material({ uniforms: birdU, vertexShader: BIRD_VERT, fragmentShader: BIRD_FRAG, transparent: true, depthWrite: true, side: THREE.DoubleSide }),
  );
  birds.renderOrder = 3;
  birds.frustumCulled = false;
  birds.visible = false;
  scene.add(birds);
  const flock = { t: 0, life: 0, wait: rand(6, 12), vx: 0 };

  // ---- cloud puffs
  const counts = { [TOWER]: Math.round(44 * density), [FLOATER]: Math.round(36 * density), [DECK]: Math.round(64 * density) };
  const clusters = [];
  let puffTotal = 0;
  for (const type of [TOWER, FLOATER, DECK]) {
    for (let k = 0; k < counts[type]; k++) {
      const n = type === TOWER ? 18 + Math.floor(rng() * 12) : type === FLOATER ? 8 + Math.floor(rng() * 6) : 6 + Math.floor(rng() * 3);
      clusters.push({ type, start: puffTotal, count: n, x: 0, y: 0, z: 0, r: 0, h: 0, rank: 0, fade: 0 });
      puffTotal += n;
    }
  }
  const lx = new Float32Array(puffTotal);
  const ly = new Float32Array(puffTotal);
  const lz = new Float32Array(puffTotal);
  const psize = new Float32Array(puffTotal);
  const phf = new Float32Array(puffTotal);
  const prot = new Float32Array(puffTotal);
  const paspect = new Float32Array(puffTotal);
  const pcluster = new Uint16Array(puffTotal);
  const wx = new Float32Array(puffTotal);
  const wy = new Float32Array(puffTotal);
  const wz = new Float32Array(puffTotal);
  const key = new Float32Array(puffTotal);
  const order = new Uint16Array(puffTotal);
  for (let i = 0; i < puffTotal; i++) order[i] = i;
  for (let ci = 0; ci < clusters.length; ci++) pcluster.fill(ci, clusters[ci].start, clusters[ci].start + clusters[ci].count);

  const puffA = new Float32Array(puffTotal * 4);
  const puffB = new Float32Array(puffTotal * 4);
  const quad = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  const puffGeo = keep(new THREE.InstancedBufferGeometry());
  puffGeo.setIndex([0, 1, 2, 0, 2, 3]);
  puffGeo.setAttribute('position', new THREE.Float32BufferAttribute(quad, 3));
  const attrA = new THREE.InstancedBufferAttribute(puffA, 4).setUsage(THREE.DynamicDrawUsage);
  const attrB = new THREE.InstancedBufferAttribute(puffB, 4).setUsage(THREE.DynamicDrawUsage);
  puffGeo.setAttribute('aPuff', attrA);
  puffGeo.setAttribute('aInfo', attrB);
  puffGeo.instanceCount = 0;
  const puffs = new THREE.Mesh(
    puffGeo,
    material({ uniforms: { ...U, uPuffTex: { value: puffTex } }, vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, transparent: true }),
  );
  puffs.renderOrder = 4;
  puffs.frustumCulled = false;
  scene.add(puffs);

  // ---- sun / moon glare and god rays (additive, over everything)
  const glareU = {
    uLightDir: U.uLightDir, uLight: U.uLight, uExposure: U.uExposure, uTime: U.uTime,
    uGlareSize: { value: 2800 }, uGlareAmt: { value: 1 }, uRays: { value: 0.3 },
  };
  const glare = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(2, 2)),
    material({ uniforms: glareU, vertexShader: GLARE_VERT, fragmentShader: GLARE_FRAG, transparent: true, depthTest: false, blending: THREE.AdditiveBlending }),
  );
  glare.renderOrder = 5;
  glare.frustumCulled = false;
  scene.add(glare);

  // ---- whiteout veil while inside a cloud
  const veilGeo = keep(new THREE.BufferGeometry());
  veilGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const veilU = { uVeilColor: { value: new THREE.Color(1, 1, 1) }, uVeil: { value: 0 } };
  const veil = new THREE.Mesh(
    veilGeo,
    material({ uniforms: veilU, vertexShader: VEIL_VERT, fragmentShader: VEIL_FRAG, transparent: true, depthTest: false }),
  );
  veil.renderOrder = 6;
  veil.frustumCulled = false;
  veil.visible = false;
  scene.add(veil);

  // ---------------------------------------------------------------- state

  const want = { intensity: 0.45, wind: 0, windSpeed: 12, storm: 0, timeOfDay: 'day', sunProgress: 0.35, temperature: 18 };
  const eased = { intensity: 0.45, wind: 0, windSpeed: 12, storm: 0 };
  const lightTarget = new THREE.Vector3().copy(U.uLightDir.value);
  const fwd = new THREE.Vector3();
  const upWorld = new THREE.Vector3(0, 1, 0);
  const amount = { [TOWER]: 0, [FLOATER]: 0, [DECK]: 0 };
  const flight = { swoop: rand(0, 100), x: 0, y: 0, baseFov: 55, fov: 55 };
  let deckY = -150;
  let heightScale = 1;
  let veilAmt = 0;
  let occlusion = 0;
  let started = false;

  function shapeCluster(c) {
    const { start, count } = c;
    if (c.type === TOWER) {
      const R = rand(80, 210);
      c.r = R;
      c.h = R * rand(0.8, 1.7);
      for (let k = 0; k < count; k++) {
        const i = start + k;
        const t = Math.min(1, (k + rng()) / count);
        const env = 1 - 0.6 * Math.pow(t, 1.6);           // narrows toward the crown
        const a = rng() * TAU;
        const rr = R * env * (0.3 + 0.6 * Math.sqrt(rng()));
        lx[i] = Math.cos(a) * rr;
        lz[i] = Math.sin(a) * rr * 0.85;
        ly[i] = t * c.h * 0.85;
        psize[i] = R * (0.55 - 0.25 * t) * rand(0.85, 1.15);
        phf[i] = t;
        paspect[i] = rand(0.85, 1);
      }
    } else if (c.type === FLOATER) {
      const R = rand(45, 120);
      c.r = R;
      c.h = R * rand(0.35, 0.7);
      for (let k = 0; k < count; k++) {
        const i = start + k;
        const t = Math.min(1, (k + rng()) / count);
        const a = rng() * TAU;
        const rr = R * (1 - 0.45 * Math.pow(t, 1.3)) * (0.25 + 0.65 * Math.sqrt(rng()));
        lx[i] = Math.cos(a) * rr;
        lz[i] = Math.sin(a) * rr * 0.8;
        ly[i] = t * c.h;
        psize[i] = R * (0.5 - 0.18 * t) * rand(0.85, 1.15);
        phf[i] = 0.15 + 0.85 * t;
        paspect[i] = rand(0.8, 0.95);
      }
    } else {
      c.r = 200;
      c.h = 20;
      for (let k = 0; k < count; k++) {
        const i = start + k;
        const a = rng() * TAU;
        const rr = rand(0, 190);
        lx[i] = Math.cos(a) * rr;
        lz[i] = Math.sin(a) * rr;
        ly[i] = rand(0, 14);
        psize[i] = rand(65, 130);
        phf[i] = rand(0.55, 1);
        paspect[i] = rand(0.42, 0.58);
      }
    }
    for (let k = 0; k < count; k++) prot[start + k] = rng() * TAU;
  }

  function spawn(c, z) {
    c.z = z;
    c.rank = rng();
    // Some clouds are placed on the flight path so we glide straight through them.
    const onPath = c.type !== DECK && rng() < (c.type === FLOATER ? 0.2 : 0.08);
    c.x = onPath ? flight.x + rand(-50, 50) : flight.x + rand(-HALF_W, HALF_W);
    c.y = c.type === FLOATER ? (onPath ? rand(-35, 5) : rand(-50, 70)) : 0;
    shapeCluster(c);
  }

  for (let i = 0; i < clusters.length; i++) spawn(clusters[i], rand(-FAR, BEHIND));

  // Light direction: keep the sun (or moon) ahead and in the upper-right part of the view.
  function aimLight() {
    const vHalf = (flight.baseFov * DEG) / 2;
    const hTan = Math.tan(vHalf) * camera.aspect;
    const az = Math.atan(hTan * 0.5);
    const maxEl = Math.min(26 * DEG, vHalf * 0.62);
    let el;
    if (want.timeOfDay === 'night' || want.sunProgress === null) {
      el = maxEl * 0.8;
    } else {
      const p = Math.min(1, Math.max(0, want.sunProgress));
      el = 3 * DEG + (maxEl - 3 * DEG) * Math.sin(Math.PI * p);
    }
    lightTarget.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  }

  function choosePalette() {
    const tod = PALETTES[want.timeOfDay] ? want.timeOfDay : 'day';
    const base = palettes[tod];
    for (const k of COLOR_KEYS) tgt[k].copy(base[k]);
    for (const k of SCALAR_KEYS) tgt[k] = base[k];
    // A low sun in the daytime borrows some of the twilight warmth.
    if (tod === 'day' && want.sunProgress !== null) {
      const p = want.sunProgress;
      const low = 1 - smooth(0.06, 0.22, Math.min(p, 1 - p));
      if (low > 0) {
        const twilight = palettes[p < 0.5 ? 'dawn' : 'dusk'];
        for (const k of COLOR_KEYS) tgt[k].lerp(twilight[k], low * 0.5);
      }
    }
    if (want.temperature > 28) tgt.horizon.lerp(warmHaze, Math.min(0.2, (want.temperature - 28) * 0.03));
    if (want.temperature < 2) tgt.horizon.lerp(coolHaze, Math.min(0.2, (2 - want.temperature) * 0.03));
  }

  function setParams(p) {
    if (!p) return;
    want.intensity = Math.min(1, Math.max(0, Number(p.intensity) || 0));
    want.wind = Math.min(1, Math.max(-1, Number(p.wind) || 0));
    want.windSpeed = Math.max(0, Number(p.windSpeed) || 0);
    want.storm = p.storm ? 1 : 0;
    want.temperature = Number.isFinite(p.temperature) ? p.temperature : 18;
    want.timeOfDay = p.timeOfDay || 'day';
    want.sunProgress = typeof p.sunProgress === 'number' ? p.sunProgress : null;
    choosePalette();
    aimLight();
    if (!started) snap();
  }

  // Before the first frame there is nothing to ease from.
  function snap() {
    for (const k of ['intensity', 'wind', 'windSpeed', 'storm']) eased[k] = want[k];
    for (const k of COLOR_KEYS) cur[k].copy(tgt[k]);
    for (const k of SCALAR_KEYS) cur[k] = tgt[k];
    U.uLightDir.value.copy(lightTarget);
    applyIntensity(1);
  }

  function applyIntensity(k) {
    const I = eased.intensity;
    amount[TOWER] = 0.12 + 0.88 * I;
    amount[FLOATER] = 0.05 + 0.95 * I;
    amount[DECK] = 0.35 + 0.65 * I;
    heightScale += (0.55 + 0.7 * I - heightScale) * k;
    deckY += (-190 + 95 * I - deckY) * k;
    U.uDeckY.value = deckY;
    U.uCoverage.value = 0.6 - 0.42 * I;
  }

  function resize(width, height) {
    camera.aspect = width / Math.max(1, height);
    const portrait = Math.min(1, Math.max(0, (1 - camera.aspect) / 0.55));
    flight.baseFov = 52 + 20 * portrait;
    camera.updateProjectionMatrix();
    aimLight();
    if (!started) U.uLightDir.value.copy(lightTarget);
  }

  function easeWorld(dt) {
    const k = damp(0.6, dt); // a few seconds to settle
    eased.intensity += (want.intensity - eased.intensity) * damp(0.5, dt);
    eased.wind += (want.wind - eased.wind) * k;
    eased.windSpeed += (want.windSpeed - eased.windSpeed) * k;
    eased.storm += (want.storm - eased.storm) * k;
    applyIntensity(damp(0.5, dt));

    const kc = damp(0.45, dt);
    for (let i = 0; i < COLOR_KEYS.length; i++) cur[COLOR_KEYS[i]].lerp(tgt[COLOR_KEYS[i]], kc);
    for (let i = 0; i < SCALAR_KEYS.length; i++) cur[SCALAR_KEYS[i]] += (tgt[SCALAR_KEYS[i]] - cur[SCALAR_KEYS[i]]) * kc;
    U.uLightDir.value.lerp(lightTarget, kc).normalize();
    U.uGlowAmt.value = cur.glowAmt;
    U.uExposure.value = cur.exposure * (1 - 0.18 * eased.storm);
    if (eased.storm > 0.01) {
      cur.lit.lerp(grey, eased.storm * 0.02);
      cur.zenith.lerp(grey, eased.storm * 0.01);
    }
    skyU.uSunAmt.value = cur.sun;
    skyU.uMoonAmt.value = 1 - cur.sun;
  }

  function fly(dt, input) {
    const boost = input.boost;
    const speed = (34 + eased.windSpeed * 0.25) * (1 + 2 * boost);
    const s = (flight.swoop += dt * (1 + boost * 0.6));
    // Slow layered sines give an unhurried, never-repeating glide.
    const y = 6 + 17 * Math.sin(s * 0.105) + 7 * Math.sin(s * 0.043 + 1.7);
    const vy = 17 * 0.105 * Math.cos(s * 0.105) + 7 * 0.043 * Math.cos(s * 0.043 + 1.7);
    const x = 30 * Math.sin(s * 0.031);
    const vx = 30 * 0.031 * Math.cos(s * 0.031);
    flight.x = x;
    flight.y = y;
    camera.position.set(x, y, 0);
    const pitch = -0.05 + Math.atan(vy / speed) * 0.7 + input.pitch;
    const roll = -eased.wind * 0.07 - input.yaw * 0.1 - vx * 0.02 + 0.025 * Math.sin(s * 0.07);
    camera.rotation.set(pitch, input.yaw - vx * 0.004, roll);
    const fov = flight.baseFov + boost * 9;
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();

    // Roll-free billboard basis so puffs stay level when the camera banks.
    camera.getWorldDirection(fwd);
    U.uCamRight.value.crossVectors(fwd, upWorld).normalize();
    U.uCamUp.value.crossVectors(U.uCamRight.value, fwd).normalize();
    return speed;
  }

  function updateClouds(dt, speed) {
    const travel = speed * dt;
    const drift = eased.wind * (5 + eased.windSpeed * 0.18) * dt;
    const shift = U.uShift.value;
    shift.x = (shift.x + drift) % DECK_PERIOD;
    shift.y = (shift.y + travel) % DECK_PERIOD;

    const cx = camera.position.x;
    const cy = camera.position.y;
    const L = U.uLightDir.value;
    const kFade = damp(0.7, dt);
    let dens = 0;
    let occ = 0;

    for (let ci = 0; ci < clusters.length; ci++) {
      const c = clusters[ci];
      c.z += travel;
      c.x += drift;
      if (c.z > BEHIND + c.r) spawn(c, c.z - FAR - BEHIND - c.r);
      if (c.x - cx > HALF_W) c.x -= HALF_W * 2;
      else if (c.x - cx < -HALF_W) c.x += HALF_W * 2;
      c.fade += ((c.rank < amount[c.type] ? 1 : 0) - c.fade) * kFade;

      const baseY = c.type === TOWER ? deckY - 8 : c.type === DECK ? deckY - 4 : c.y;
      const hs = c.type === TOWER ? heightScale : 1;
      const end = c.start + c.count;
      if (c.fade < 0.003) {
        for (let i = c.start; i < end; i++) key[i] = -1;
        continue;
      }

      // Is this cloud between us and the sun? (bounding-sphere ray test)
      if (c.type !== DECK) {
        const ox = c.x - cx;
        const oy = baseY + c.h * hs * 0.45 - cy;
        const oz = c.z;
        const t = ox * L.x + oy * L.y + oz * L.z;
        if (t > 0) {
          const rad = Math.max(c.r, c.h * hs * 0.5) * 0.75;
          const perp2 = ox * ox + oy * oy + oz * oz - t * t;
          occ = Math.max(occ, c.fade * (1 - smooth(rad * rad * 0.2, rad * rad, perp2)));
        }
      }

      for (let i = c.start; i < end; i++) {
        const px = c.x + lx[i];
        const py = baseY + ly[i] * hs;
        const pz = c.z + lz[i];
        wx[i] = px;
        wy[i] = py;
        wz[i] = pz;
        const dx = px - cx;
        const dy = py - cy;
        const d2 = dx * dx + dy * dy + pz * pz;
        key[i] = d2;
        const reach = psize[i] * 0.85;
        if (d2 < reach * reach) dens += (1 - Math.sqrt(d2) / reach) * c.fade;
      }
    }

    // Back-to-front order; the list is nearly sorted from the previous frame.
    for (let i = 1; i < puffTotal; i++) {
      const idx = order[i];
      const k = key[idx];
      let j = i - 1;
      while (j >= 0 && key[order[j]] < k) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = idx;
    }

    let count = 0;
    while (count < puffTotal && key[order[count]] >= 0) {
      const i = order[count];
      const o = count * 4;
      puffA[o] = wx[i];
      puffA[o + 1] = wy[i];
      puffA[o + 2] = wz[i];
      puffA[o + 3] = psize[i];
      puffB[o] = phf[i];
      puffB[o + 1] = prot[i];
      puffB[o + 2] = clusters[pcluster[i]].fade;
      puffB[o + 3] = paspect[i];
      count++;
    }
    puffGeo.instanceCount = count;
    puffs.visible = count > 0;
    if (count > 0) {
      attrA.clearUpdateRanges();
      attrB.clearUpdateRanges();
      attrA.addUpdateRange(0, count * 4);
      attrB.addUpdateRange(0, count * 4);
      attrA.needsUpdate = true;
      attrB.needsUpdate = true;
    }

    veilAmt += (Math.min(1, dens * 1.1) - veilAmt) * damp(dens > veilAmt ? 5 : 2.5, dt);
    occlusion += (occ - occlusion) * damp(3, dt);
  }

  function updateLights(input) {
    const sunAmt = cur.sun;
    const clear = 1 - occlusion * 0.85;
    glareU.uGlareAmt.value = (sunAmt + (1 - sunAmt) * 0.25) * clear * (1 - veilAmt * 0.7);
    glareU.uRays.value = sunAmt * (0.18 + 0.3 * occlusion) * (1 - veilAmt) * (1 - 0.5 * input.boost);
    glareU.uGlareSize.value = 2000 + 900 * sunAmt;

    veilU.uVeil.value = veilAmt * 0.8;
    veil.visible = veilAmt > 0.004;
    if (veil.visible) veilU.uVeilColor.value.copy(cur.lit).lerp(cur.horizon, 0.25).multiplyScalar(cur.exposure);

    starU.uNight.value = cur.night;
    starU.uPixelRatio.value = renderer.getPixelRatio();
    stars.visible = cur.night > 0.01;

    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    deck.position.x = camera.position.x;
    deck.position.y = deckY;
  }

  function updateBirds(dt) {
    if (flock.life <= 0) {
      birds.visible = false;
      flock.wait -= dt;
      if (flock.wait > 0 || cur.sun < 0.6) return;
      const side = rng() < 0.5 ? -1 : 1;
      const dist = rand(380, 560);
      const halfView = dist * Math.tan((flight.baseFov * DEG) / 2) * camera.aspect;
      flock.vx = -side * rand(13, 19);
      flock.life = (2 * (halfView + 80)) / Math.abs(flock.vx);
      flock.t = 0;
      birdU.uFlock.value.set(camera.position.x + side * (halfView + 80), camera.position.y + rand(25, 80), -dist);
      birdU.uBirdScale.value = rand(3.2, 4.2);
      flock.wait = rand(25, 50);
    }
    flock.t += dt;
    const f = birdU.uFlock.value;
    f.x += flock.vx * dt;
    f.y += Math.sin(flock.t * 0.4) * 2 * dt;
    f.z += 2 * dt;
    birdU.uFlockAlpha.value = Math.min(1, flock.t / 2, (flock.life - flock.t) / 2) * cur.sun;
    birds.visible = true;
    if (flock.t >= flock.life) flock.life = 0;
  }

  function updateMeteor(dt) {
    const m = meteorState;
    if (m.life <= 0) {
      meteor.visible = false;
      m.wait -= dt;
      if (m.wait > 0 || cur.night < 0.6) return;
      const az = rand(-0.8, 0.8);
      const el = rand(0.3, 0.8);
      m.head.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(4000);
      m.vel.set(rand(-1, 1), -rand(0.4, 0.8), 0).normalize().multiplyScalar(rand(1800, 2600));
      m.life = rand(0.6, 1.0);
      m.t = 0;
      m.wait = rand(7, 18);
    }
    m.t += dt;
    m.head.addScaledVector(m.vel, dt);
    meteorU.uHead.value.copy(camera.position).add(m.head);
    meteorU.uTail.value.copy(meteorU.uHead.value).addScaledVector(m.vel, -0.14);
    meteorU.uMeteor.value = Math.sin(Math.PI * Math.min(1, m.t / m.life)) * cur.night;
    meteor.visible = true;
    if (m.t >= m.life) m.life = 0;
  }

  function update(dt, elapsed, input) {
    started = true;
    U.uTime.value = elapsed;
    easeWorld(dt);
    const speed = fly(dt, input);
    updateClouds(dt, speed);
    updateLights(input);
    updateBirds(dt);
    updateMeteor(dt);
  }

  function dispose() {
    for (const thing of disposables) thing.dispose();
    disposables.length = 0;
    scene.clear();
  }

  return { scene, camera, setParams, update, resize, dispose };
}
