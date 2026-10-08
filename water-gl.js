// Pixel-art water renderer (WebGL2). One fragment = one water pixel.
//
// The worker sends a byte per pixel: 0 = air, bits 0-6 = 1 + depth below the
// surface, bit 7 = foam. Two styles share a dark outline where water meets
// air, a broken highlight line under the surface, foam and caustics:
//  - ocean: opaque, a posterized, dithered palette ramp from light to deep blue
//  - clear: translucent tint over a tiled backdrop that the water refracts,
//    with droplet-style rims and caustics cast on the floor
// Patterns use global screen-pixel coordinates and a wall-clock time, so
// touching windows look like one continuous body of water.

const WATER_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const WATER_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D uCells;
uniform ivec2 uSize;     // this window, in render pixels
uniform ivec2 uOrigin;   // this window's top-left in global render pixels
uniform float uTime;     // seconds, shared clock across windows
out vec4 outColor;

// Deep -> light ramp, then the special colours.
const vec3 RAMP[5] = vec3[5](
  vec3(0.137, 0.235, 0.553),   // deep
  vec3(0.184, 0.357, 0.729),
  vec3(0.239, 0.522, 0.851),
  vec3(0.322, 0.690, 0.906),
  vec3(0.478, 0.835, 0.937)    // shallow
);
const vec3 OUTLINE   = vec3(0.106, 0.169, 0.420);
const vec3 HIGHLIGHT = vec3(0.725, 0.953, 0.973);
const vec3 GLINT     = vec3(0.835, 0.976, 0.659);
const vec3 FOAM      = vec3(0.910, 0.984, 1.000);

const float BAYER[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
float bayer(ivec2 p) { return (BAYER[(p.x & 3) + ((p.y & 3) << 2)] + 0.5) / 16.0; }

uint cellAt(ivec2 p) {
  // Outside this window counts as water, so window edges get no outline.
  p = clamp(p, ivec2(0), uSize - 1);
  return texelFetch(uCells, p, 0).r;
}

// Thin animated light web: bright where either warped wave crosses zero.
// Two layers at different scales/speeds keep it from looking like a grid.
float web(vec2 q, float t) {
  float a = sin(q.x + t * 0.8 + 1.6 * sin(q.y * 0.9 + t * 0.5));
  float b = sin(q.y * 1.1 - t * 0.6 + 1.6 * sin(q.x * 0.8 - t * 0.4));
  return pow(1.0 - abs(a * b), 14.0);
}
float caustic(vec2 p, float t) {
  return max(web(p * 0.075, t), 0.7 * web(p * 0.13 + 17.0, t * 1.3));
}

// Slow, broad brightness variation so deep water isn't one flat colour.
float swell(vec2 p, float t) {
  return sin(p.x * 0.031 + t * 0.3 + sin(p.y * 0.023 - t * 0.2) * 2.0) *
         sin(p.y * 0.027 - t * 0.25 + sin(p.x * 0.019 + t * 0.15) * 2.0);
}

bool air(ivec2 p) { return cellAt(p) == 0u; }
float depthAt(ivec2 p) { uint c = cellAt(p); return c == 0u ? 0.0 : float((c & 127u) - 1u); }

// Broken highlight line just under the surface.
bool surfaceShine(ivec2 g, float depth, float t) {
  float shine = sin(float(g.x) * 0.23 + t * 1.5) + sin(float(g.x) * 0.071 - t * 0.9);
  return depth >= 1.0 && depth < 2.0 && shine > 0.2;
}

// ---- style 0: ocean (opaque, deep palette ramp) ----
vec3 ocean(ivec2 g, float depth, float t, float d) {
  // Light falls off with depth; caustics brighten the upper water.
  float light = 0.12 + 0.88 * exp(-depth / 40.0);
  float caus = caustic(vec2(g), t) * exp(-depth / 70.0);
  float s = light + caus * 0.3 + swell(vec2(g), t) * 0.06 + d * 0.07;
  vec3 col = RAMP[int(clamp(floor(s * 5.0), 0.0, 4.0))];
  if (surfaceShine(g, depth, t)) col = HIGHLIGHT;
  // Occasional bright glints where the caustic web is strongest.
  if (depth >= 2.0 && depth < 40.0 && caus > 0.85 && d > 0.3) col = GLINT;
  return col;
}

// ---- style 1: clear (translucent, refracts a tiled backdrop) ----
const int TILE = 12;
const vec3 TILE_A     = vec3(0.071, 0.094, 0.133);
const vec3 TILE_B     = vec3(0.086, 0.114, 0.157);
const vec3 GROUT      = vec3(0.125, 0.161, 0.224);
const vec3 TINT_TOP   = vec3(0.310, 0.800, 0.860);
const vec3 TINT_DEEP  = vec3(0.170, 0.430, 0.780);
const vec3 FLOOR_CAUS = vec3(0.420, 0.860, 0.820);
const vec3 RIM        = vec3(0.560, 0.910, 0.950);
const vec3 RIM_LOW    = vec3(0.400, 0.850, 0.920);
const vec3 SPEC       = vec3(0.960, 1.000, 1.000);

float hash(ivec2 q) { return fract(sin(float(q.x) * 12.9898 + float(q.y) * 78.233) * 43758.5453); }

// 0 = tile, 1 = other tile shade, 2 = grout line.
int backdropId(ivec2 g) {
  ivec2 tile = g / TILE, m = g - tile * TILE;
  if (m.x == 0 || m.y == 0) return 2;
  return hash(tile) > 0.5 ? 0 : 1;
}
vec3 backdrop(ivec2 g) {
  int id = backdropId(g);
  return id == 2 ? GROUT : id == 1 ? TILE_B : TILE_A;
}
// How each part of the floor looks through the water: lit by the light the
// water lets in, so the grout lines stay visible (and visibly bent).
const float SEEN[3] = float[3](0.72, 0.80, 1.02);

vec3 clearWater(ivec2 p, ivec2 g, float depth, float t, float d) {
  // Droplet-style lighting near the water's edge: a specular dot on top-left
  // curves, a bright rim along undersides (light focused through the water),
  // and a light rim inside the other edges.
  bool up = air(p + ivec2(0, -2)), down = air(p + ivec2(0, 2));
  bool left = air(p + ivec2(-2, 0)), right = air(p + ivec2(2, 0));
  if (up && left && air(p + ivec2(-2, -2))) return SPEC;
  if (down) return RIM_LOW;
  if (left || right || (up && depth > 2.0)) return RIM;
  if (surfaceShine(g, depth, t)) return HIGHLIGHT;

  // Refraction: the floor seen through the water is lifted (more with depth),
  // bent by the surface slope, and wobbles, most near the surface.
  float slope = clamp(depthAt(p + ivec2(2, 0)) - depthAt(p - ivec2(2, 0)), -6.0, 6.0);
  float near = exp(-depth / 12.0);
  vec2 wobble = vec2(sin(float(g.y) * 0.35 + t * 2.0 + float(g.x) * 0.05),
                     sin(float(g.x) * 0.28 - t * 1.7)) * (0.8 + 1.5 * near);
  ivec2 q = g + ivec2(round(vec2(slope * 0.5, -depth * 0.25) + wobble));

  // Water colour shifts from teal to blue with depth, in dithered steps.
  float k = 1.0 - exp(-depth / 60.0);
  k = floor(k * 6.0 + d) / 6.0;
  vec3 tint = mix(TINT_TOP, TINT_DEEP, k);

  // The floor seen through it, then caustics cast on that floor.
  vec3 col = tint * SEEN[backdropId(q)];
  float caus = caustic(vec2(q), t) * exp(-depth / 90.0);
  if (caus > 0.62 + d * 0.2) col = mix(col, FLOOR_CAUS, 0.55);
  if (depth >= 2.0 && depth < 30.0 && caus > 0.93 && d > 0.3) col = GLINT;
  return col;
}

uniform int uStyle;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = uSize.y - 1 - p.y;
  ivec2 g = p + uOrigin;
  uint c = cellAt(p);
  if (c == 0u) {
    outColor = uStyle == 1 ? vec4(backdrop(g), 1.0) : vec4(0.0);
    return;
  }

  float t = floor(uTime * 10.0) / 10.0;   // step the animation, pixel-art style
  float depth = float((c & 127u) - 1u);
  float d = bayer(g) - 0.5;

  vec3 col;
  bool edge = air(p + ivec2(1, 0)) || air(p - ivec2(1, 0)) || air(p + ivec2(0, 1)) || air(p - ivec2(0, 1));
  if (edge) {
    col = OUTLINE;
  } else if ((c & 128u) != 0u && depth < 4.0) {
    // Fast water only foams at its surface (spray, breaking crests), not
    // throughout a falling body of water.
    col = d > -0.2 ? FOAM : HIGHLIGHT;
  } else {
    col = uStyle == 1 ? clearWater(p, g, depth, t, d) : ocean(g, depth, t, d);
  }
  outColor = vec4(col, 1.0);
}`;

// style: 'clear' (translucent, refractive) or 'ocean' (opaque, deep).
function createWaterRenderer(canvas, style) {
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true });
  if (!gl) return null;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, WATER_VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, WATER_FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const loc = (n) => gl.getUniformLocation(prog, n);
  const uSize = loc('uSize'), uOrigin = loc('uOrigin'), uTime = loc('uTime');
  gl.uniform1i(loc('uCells'), 0);
  gl.uniform1i(loc('uStyle'), style === 'ocean' ? 0 : 1);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.bindVertexArray(gl.createVertexArray());

  let tw = 0, th = 0;
  return {
    draw(f) {
      if (f.w !== tw || f.h !== th) {
        tw = f.w; th = f.h;
        canvas.width = f.w;
        canvas.height = f.h;
        canvas.style.width = `${f.w * f.cell}px`;
        canvas.style.height = `${f.h * f.cell}px`;
        gl.viewport(0, 0, f.w, f.h);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, f.w, f.h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, f.cells);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.w, f.h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, f.cells);
      }
      gl.uniform2i(uSize, f.w, f.h);
      gl.uniform2i(uOrigin, f.x, f.y);
      gl.uniform1f(uTime, (Date.now() % 1e7) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
