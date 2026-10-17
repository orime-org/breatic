// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picture adjust's filter chain (inner#1303 §6.1): the same
 * {@link adjustTerms} the video filter reads, built as Fabric filters in the
 * order ffmpeg runs its stages, so a slider means the same on a picture and a
 * video.
 *
 * ffmpeg hands its stages 8-bit limited-range BT.601 YUV codes, each stage
 * clipping its planes to 0..255 before the next reads them, and turns the
 * frame into RGB only for `colorchannelmixer`, after which `vignette` works on
 * RGB too. The chain does the same: the picture's RGB becomes Y, Cb and Cr
 * codes held in the red, green and blue channels, the YUV stages work on those
 * codes, and the codes become RGB again where ffmpeg's frame does.
 * `adjust-ffmpeg.test.ts` holds it to what ffmpeg makes of the video's own
 * filter string.
 *
 * Distances are in source pixels, as ffmpeg's are: the blur and unsharp
 * filters take one source pixel as a share of the picture, and the grain and
 * the vignette take the source's size and find each drawn pixel's place in it,
 * so the preview drawn at the node's size shows the export's effect scaled.
 * Each custom filter carries a WebGL shader and the same work on a pixel
 * array, which Fabric runs where there is no WebGL.
 *
 * Loaded only when an adjust panel opens: Fabric does not belong in the first
 * page load.
 */

import { filters } from 'fabric';

import { adjustTerms, type AdjustValue } from '@breatic/shared';

/** What a 2D filter pass reads and writes. */
interface PixelState {
  imageData: { data: Uint8ClampedArray; width: number; height: number };
}

/** A size in pixels. */
interface Size {
  width: number;
  height: number;
}

/** BT.601 luma weights, red and blue: ffmpeg's RGB to YUV conversion uses them. */
const KR = 0.299;
const KB = 0.114;
const KG = 1 - KR - KB;

/** Limited-range codes: Y spans 16 to 235, chroma 16 to 240 about 128. */
const Y_SPAN = 219;
const C_SPAN = 224;
const Y_FLOOR = 16;
const C_MID = 128;

/** `vignette` scales a chroma plane about this code. */
const VIGNETTE_C_MID = 127;

/** The strongest noise reduction's spread in source pixels: the video's `gblur=sigma=3*blur` (adjust-value.ts). */
const MAX_BLUR_SIGMA_PX = 3;

/** ffmpeg's 5×5 and 7×7 unsharp matrices blur with these binomial rows. */
const SHARPEN_ROW = [1, 4, 6, 4, 1].map((w) => w / 16);
const CLARITY_ROW = [1, 6, 15, 20, 15, 6, 1].map((w) => w / 64);

/** The grain's seed: fixed, so the preview and the export lay the same grain. */
export const ADJUST_GRAIN_SEED = 1;

/** A weight below which a pixel's neighbours are all transparent. */
const NO_WEIGHT = 1e-6;

/**
 * RGB channel values to Y, Cb and Cr codes, as ffmpeg's BT.601 conversion.
 * @param r - Red, 0 to 255.
 * @param g - Green, 0 to 255.
 * @param b - Blue, 0 to 255.
 * @returns The three codes.
 */
function toCodes(r: number, g: number, b: number): [number, number, number] {
  const y = (KR * r + KG * g + KB * b) / 255;
  return [
    Y_FLOOR + Y_SPAN * y,
    C_MID + (C_SPAN * (b / 255 - y)) / (2 * (1 - KB)),
    C_MID + (C_SPAN * (r / 255 - y)) / (2 * (1 - KR)),
  ];
}

/**
 * Y, Cb and Cr codes to RGB channel values.
 * @param yc - Y's code.
 * @param cbc - Cb's code.
 * @param crc - Cr's code.
 * @returns Red, green and blue, 0 to 255 before clamping.
 */
function fromCodes(yc: number, cbc: number, crc: number): [number, number, number] {
  const y = (yc - Y_FLOOR) / Y_SPAN;
  const r = y + (2 * (1 - KR) * (crc - C_MID)) / C_SPAN;
  const b = y + (2 * (1 - KB) * (cbc - C_MID)) / C_SPAN;
  return [255 * r, (255 * (y - KR * r - KB * b)) / KG, 255 * b];
}

/** The same two conversions in GLSL, on codes held as channel shares. */
const CODES_GLSL = `
  vec3 toCodes(vec3 c) {
    float y = dot(c, vec3(${KR}, ${KG}, ${KB}));
    return vec3(${Y_FLOOR}.0 + ${Y_SPAN}.0 * y, ${C_MID}.0 + ${C_SPAN}.0 * (c.b - y) / ${2 * (1 - KB)}, ${C_MID}.0 + ${C_SPAN}.0 * (c.r - y) / ${2 * (1 - KR)}) / 255.0;
  }
  vec3 fromCodes(vec3 k) {
    vec3 c = k * 255.0;
    float y = (c.x - ${Y_FLOOR}.0) / ${Y_SPAN}.0;
    float r = y + ${2 * (1 - KR)} * (c.z - ${C_MID}.0) / ${C_SPAN}.0;
    float b = y + ${2 * (1 - KB)} * (c.y - ${C_MID}.0) / ${C_SPAN}.0;
    return vec3(r, (y - ${KR} * r - ${KB} * b) / ${KG}, b);
  }`;

/**
 * A pixel read at a fractional position, clamped to the edges, with its three
 * channels weighted by alpha before they are mixed, so a transparent
 * neighbour adds no colour to a point between it and the subject.
 * @param pixels - The picture.
 * @param x - Its x.
 * @param y - Its y.
 * @returns The three channels times alpha, then alpha, as shares of 255.
 */
function tap(pixels: PixelState['imageData'], x: number, y: number): [number, number, number, number] {
  const { data, width, height } = pixels;
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (const [px, py, w] of [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy],
  ] as const) {
    const at = (py * width + px) * 4;
    const alpha = (data[at + 3] ?? 0) / 255;
    out[0] += w * alpha * (data[at] ?? 0);
    out[1] += w * alpha * (data[at + 1] ?? 0);
    out[2] += w * alpha * (data[at + 2] ?? 0);
    out[3] += w * alpha;
  }
  return out;
}

/**
 * A repeatable pseudo-random number for a cell, the same formula the shader runs.
 * @param x - The cell's column.
 * @param y - The cell's row.
 * @param seed - The seed.
 * @returns A number in [0, 1).
 */
function hash(x: number, y: number, seed: number): number {
  const v = Math.sin((x + seed) * 12.9898 + (y + seed) * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * The shader's bilinear read, the same as {@link tap}: Fabric's textures
 * sample by nearest neighbour, and the colour is weighted by alpha before it
 * is mixed.
 */
const BETWEEN_GLSL = `
  vec4 premultiplied(vec2 at) {
    vec4 c = texture2D(uTexture, at);
    return vec4(c.rgb * c.a, c.a);
  }
  vec4 between(vec2 at) {
    vec2 step = vec2(uStepW, uStepH);
    vec2 texel = at / step - 0.5;
    vec2 part = fract(texel);
    vec2 base = (floor(texel) + 0.5) * step;
    vec4 top = mix(premultiplied(base), premultiplied(base + vec2(step.x, 0.0)), part.x);
    vec4 bottom = mix(premultiplied(base + vec2(0.0, step.y)), premultiplied(base + step), part.x);
    return mix(top, bottom, part.y);
  }`;

/** Which way a {@link AdjustCodes} pass turns the picture. */
type CodesWay = 'to' | 'from';

/**
 * The frame's conversion between RGB and YUV codes, where ffmpeg's frame
 * changes format: into codes before the YUV stages, back to RGB after them.
 */
class AdjustCodes extends filters.BaseFilter<'AdjustCodes', { way: CodesWay }> {
  declare way: CodesWay;
  static type = 'AdjustCodes';
  static defaults = { way: 'to' as CodesWay };

  /**
   * The shader for this direction.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      varying vec2 vTexCoord;
      ${CODES_GLSL}
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        gl_FragColor = vec4(${this.way === 'to' ? 'toCodes' : 'fromCodes'}(c.rgb), c.a);
      }`;
  }

  /**
   * Fabric keys compiled programs by this; the two directions are two programs.
   * @returns The key.
   */
  getCacheKey(): string {
    return `AdjustCodes-${this.way}`;
  }

  /**
   * The same on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    const { data } = options.imageData;
    const turn = this.way === 'to' ? toCodes : fromCodes;
    for (let i = 0; i < data.length; i += 4) {
      const [a, b, c] = turn(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
      data[i] = a;
      data[i + 1] = b;
      data[i + 2] = c;
    }
  }
}

/** One plane of ffmpeg's `eq` as its integer pass runs it: a gain in 1/4096 steps, then a lift in codes. */
type EqPlane = [gain: number, lift: number];

/** The plane `eq` leaves as it is. */
const EQ_IDENTITY: EqPlane = [4096, 0];

/** `hue`'s turn in 1/65536 steps: cosine, sine. */
type HueTurn = [cos: number, sin: number];

/**
 * ffmpeg's `eq` for one plane, the integer pass it runs for a contrast under
 * 7.9 at gamma 1 (vf_eq.c `process_c` and `check_values`): the brightness
 * kept to hundredths; at no brightness the lift is 127 − gain/32 on every
 * plane, so code 128 lands on 127 on Y and the chroma alike. A plane with
 * contrast 1 and no brightness is left alone.
 * @param contrast - The plane's contrast; the saturation for the chroma.
 * @param brightness - Its brightness; zero for the chroma.
 * @returns The plane's gain and lift.
 */
function eqPlane(contrast: number, brightness: number): EqPlane {
  if (contrast === 1 && brightness === 0) return EQ_IDENTITY;
  // ffmpeg keeps both as floats (`av_clipf`); the hundredths truncate from those.
  const gain = Math.trunc(Math.fround(contrast) * 256 * 16);
  const hundredths = Math.trunc(100 * Math.fround(brightness) + 100);
  return [gain, Math.trunc((hundredths * 511) / 200) - 128 - Math.trunc(gain / 32)];
}

/**
 * A number as the video's filter string writes it.
 * @param value - The number.
 * @param digits - Its decimals in the string.
 * @returns The number ffmpeg reads back.
 */
function asWritten(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * ffmpeg's `eq` then `hue` on the codes, in their integer arithmetic: each
 * plane's gain and lift, held to 0..255; then the chroma turned about 128
 * (vf_hue.c), rounded and held again.
 */
class AdjustColor extends filters.BaseFilter<'AdjustColor', { luma: EqPlane; chroma: EqPlane; turn: HueTurn }> {
  declare luma: EqPlane;
  declare chroma: EqPlane;
  declare turn: HueTurn;
  static type = 'AdjustColor';
  static defaults = { luma: EQ_IDENTITY, chroma: EQ_IDENTITY, turn: [65536, 0] as HueTurn };
  static uniformLocations = ['uLuma', 'uChroma', 'uTurn'];

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform vec2 uLuma;
      uniform vec2 uChroma;
      uniform vec2 uTurn;
      varying vec2 vTexCoord;
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        vec3 k = floor(c.rgb * 255.0 + 0.5);
        float y = clamp(floor(k.x * uLuma.x / 4096.0) + uLuma.y, 0.0, 255.0);
        vec2 ch = clamp(floor(k.yz * uChroma.x / 4096.0) + uChroma.y, 0.0, 255.0) - ${C_MID}.0;
        vec2 turned = floor((vec2(uTurn.x * ch.x - uTurn.y * ch.y, uTurn.y * ch.x + uTurn.x * ch.y) + 32768.0) / 65536.0);
        gl_FragColor = vec4(vec3(y, clamp(turned + ${C_MID}.0, 0.0, 255.0)) / 255.0, c.a);
      }`;
  }

  /**
   * The same on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    const { data } = options.imageData;
    const [yGain, yLift] = this.luma;
    const [cGain, cLift] = this.chroma;
    const [cos, sin] = this.turn;
    /**
     * One code through `eq`.
     * @param code - The code.
     * @param gain - The plane's gain.
     * @param lift - The plane's lift.
     * @returns The new code, held to 0..255.
     */
    const eq = (code: number, gain: number, lift: number): number =>
      Math.min(255, Math.max(0, Math.floor((code * gain) / 4096) + lift));
    for (let i = 0; i < data.length; i += 4) {
      data[i] = eq(data[i] ?? 0, yGain, yLift);
      const u = eq(data[i + 1] ?? 0, cGain, cLift) - C_MID;
      const v = eq(data[i + 2] ?? 0, cGain, cLift) - C_MID;
      data[i + 1] = Math.floor((cos * u - sin * v + 32768) / 65536) + C_MID;
      data[i + 2] = Math.floor((sin * u + cos * v + 32768) / 65536) + C_MID;
    }
  }

  /**
   * Hand the two planes and the turn to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform2fv(locations.uLuma ?? null, this.luma);
    gl.uniform2fv(locations.uChroma ?? null, this.chroma);
    gl.uniform2fv(locations.uTurn ?? null, this.turn);
  }
}

/** Source pixels a side one pass of the noise reduction reads: the chroma's weight is under 0.4% there at the strongest. */
const BLUR_TAPS = 24;

/**
 * How much each pixel further off weighs in ffmpeg's `gblur` at its default
 * of one step: its Alvarez-Mazorra recursion runs once each way, which is a
 * kernel falling by this factor a pixel.
 * @param sigma - The spread, in the plane's pixels.
 * @returns The factor, 0 for no spread.
 */
function blurFalloff(sigma: number): number {
  if (sigma <= 0) return 0;
  const lambda = (sigma * sigma) / 2;
  return (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda);
}

/**
 * The 2x2 blocks a drawn pixel covers along a pass, in source pixels: the
 * first and last block, how much of each end block it covers, and how many
 * whole blocks lie between them.
 */
interface BlockRun {
  first: number;
  last: number;
  head: number;
  tail: number;
  whole: number;
}

/**
 * The blocks one drawn pixel covers along a pass.
 * @param at - The drawn pixel.
 * @param step - Drawn pixels per source pixel, at most 1.
 * @returns Its blocks.
 */
function blockRun(at: number, step: number): BlockRun {
  const start = at / step;
  const end = (at + 1) / step;
  const first = Math.floor(start / 2);
  const last = Math.ceil(end / 2) - 1;
  if (first === last) return { first, last, head: end - start, tail: 0, whole: 0 };
  return { first, last, head: 2 * (first + 1) - start, tail: end - 2 * last, whole: last - first - 1 };
}

/**
 * The sum of `falloff` to the powers 1 to `count`.
 * @param falloff - The factor, in (0, 1).
 * @param count - How many powers.
 * @returns The sum.
 */
function powers(falloff: number, count: number): number {
  return (falloff * (1 - falloff ** count)) / (1 - falloff);
}

/**
 * How much one drawn pixel's chroma weighs in another's, under ffmpeg's 4:2:0
 * blur: the export blurs each source pixel by the blocks between it and its
 * neighbours, and a drawn pixel shows the export's pixels it covers averaged,
 * so the weight is the sum over every pair of source pixels the two cover of
 * that pair's block weight times how much of each they cover. One drawn pixel
 * per source pixel gives the export's own weight.
 * @param from - The drawn pixel being blurred.
 * @param to - The drawn pixel it takes from.
 * @param step - Drawn pixels per source pixel, at most 1.
 * @param falloff - The kernel's factor per block.
 * @returns The weight.
 */
export function chromaWeight(from: number, to: number, step: number, falloff: number): number {
  const a = blockRun(from, step);
  if (from === to) {
    if (a.first === a.last) return a.head * a.head;
    const k = a.whole;
    const inner = 4 * (k + (2 * falloff * (k * (1 - falloff) - 1 + falloff ** k)) / (1 - falloff) ** 2);
    const ends = a.head * a.head + a.tail * a.tail + 2 * a.head * a.tail * falloff ** (k + 1);
    return inner + ends + 4 * (a.head + a.tail) * powers(falloff, k);
  }
  const [near, far] = to > from ? [a, blockRun(to, step)] : [blockRun(to, step), a];
  // Seen from the facing ends: the near pixel's last block, the far one's first.
  const fromNear = near.first === near.last ? near.head : near.tail + 2 * powers(falloff, near.whole) + near.head * falloff ** (near.whole + 1);
  const fromFar = far.first === far.last ? far.head : far.head + 2 * powers(falloff, far.whole) + far.tail * falloff ** (far.whole + 1);
  return fromNear * fromFar * falloff ** (far.first - near.last);
}

/** {@link chromaWeight} for the shader, the same sums. */
const CHROMA_WEIGHT_GLSL = `
  float powers(float f, float count) {
    return f * (1.0 - pow(f, count)) / (1.0 - f);
  }
  // The first and last block a drawn pixel covers, and how much of each end.
  vec4 blockRun(float at, float step) {
    float start = at / step;
    float end = (at + 1.0) / step;
    float first = floor(start / 2.0);
    float last = ceil(end / 2.0) - 1.0;
    if (first == last) return vec4(first, last, end - start, 0.0);
    return vec4(first, last, 2.0 * (first + 1.0) - start, end - 2.0 * last);
  }
  float chromaWeight(float from, float to, float step, float f) {
    vec4 a = blockRun(from, step);
    if (from == to) {
      if (a.x == a.y) return a.z * a.z;
      float k = a.y - a.x - 1.0;
      float inner = 4.0 * (k + 2.0 * f * (k * (1.0 - f) - 1.0 + pow(f, k)) / ((1.0 - f) * (1.0 - f)));
      float ends = a.z * a.z + a.w * a.w + 2.0 * a.z * a.w * pow(f, k + 1.0);
      return inner + ends + 4.0 * (a.z + a.w) * powers(f, k);
    }
    vec4 near = to > from ? a : blockRun(to, step);
    vec4 far = to > from ? blockRun(to, step) : a;
    float nearK = near.y - near.x - 1.0;
    float farK = far.y - far.x - 1.0;
    float fromNear = near.x == near.y ? near.z : near.w + 2.0 * powers(f, nearK) + near.z * pow(f, nearK + 1.0);
    float fromFar = far.x == far.y ? far.z : far.z + 2.0 * powers(f, farK) + far.w * pow(f, farK + 1.0);
    return fromNear * fromFar * pow(f, far.x - near.y);
  }`;

/**
 * ffmpeg's `gblur` on every plane of a 4:2:0 frame: Y's kernel falls by the
 * factor a source pixel, the chroma's by the same factor for each 2x2 block
 * between a pixel's and the neighbour's, the block the chroma plane holds one
 * sample for. The chroma is read at drawn pixels and weighed by
 * {@link chromaWeight}, so a preview drawn smaller than its source shows the
 * export shrunk to its size. Each neighbour weighs as much as it is opaque, so a
 * cut-out's transparent surround adds nothing; a pixel keeps its own alpha.
 * Fabric's two passes, across then down, carry it.
 */
class AdjustBlur extends filters.Blur {
  declare sigma: number;
  declare pixel: [number, number];
  static type = 'AdjustBlur';
  static defaults = { blur: 0, sigma: 0, pixel: [0, 0] as [number, number] };
  static uniformLocations = ['uPixel', 'uFalloff'];

  /**
   * The shader for one pass, the direction in `uPixel`.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform vec2 uPixel;
      uniform float uFalloff;
      uniform float uStepW;
      uniform float uStepH;
      varying vec2 vTexCoord;
      ${BETWEEN_GLSL}
      ${CHROMA_WEIGHT_GLSL}
      void main() {
        vec4 own = texture2D(uTexture, vTexCoord);
        // One drawn pixel along the pass, and drawn pixels per source pixel.
        vec2 drawn = uPixel.x > 0.0 ? vec2(uStepW, 0.0) : vec2(0.0, uStepH);
        float step = min(1.0, dot(uPixel, uPixel) / dot(uPixel, drawn));
        float at = floor(dot(vTexCoord, drawn) / dot(drawn, drawn));
        float reach = ceil(${BLUR_TAPS}.0 * step);
        float y = 0.0;
        vec2 c = vec2(0.0);
        float wy = 0.0;
        float wc = 0.0;
        for (int t = -${BLUR_TAPS}; t <= ${BLUR_TAPS}; t++) {
          vec4 s = between(vTexCoord + uPixel * float(t));
          float ky = pow(uFalloff, abs(float(t)));
          y += ky * s.r;
          wy += ky * s.a;
          // The chroma is read at drawn pixels, each weighed by the source pixels the two cover.
          if (abs(float(t)) <= reach) {
            vec4 d = between(vTexCoord + drawn * float(t));
            float kc = chromaWeight(at, at + float(t), step, uFalloff);
            c += kc * d.gb;
            wc += kc * d.a;
          }
        }
        gl_FragColor = wy < ${NO_WEIGHT} ? own : vec4(y / wy, c / wc, own.a);
      }`;
  }

  /**
   * Both passes on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.sigma === 0) return;
    const pixels = options.imageData;
    this.pass2d(pixels, this.pixel[0] * pixels.width, 0);
    this.pass2d(pixels, 0, this.pixel[1] * pixels.height);
  }

  /**
   * One pass along a direction.
   * @param pixels - The picture, changed in place.
   * @param dx - One source pixel across, in the picture's pixels.
   * @param dy - One source pixel down, in the picture's pixels.
   */
  private pass2d(pixels: PixelState['imageData'], dx: number, dy: number): void {
    const source = { data: new Uint8ClampedArray(pixels.data), width: pixels.width, height: pixels.height };
    const falloff = blurFalloff(this.sigma);
    const step = Math.min(1, dx !== 0 ? dx : dy);
    const reach = Math.ceil(BLUR_TAPS * step);
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        const at = dx !== 0 ? x : y;
        const sum = [0, 0, 0];
        let wy = 0;
        let wc = 0;
        for (let t = -BLUR_TAPS; t <= BLUR_TAPS; t++) {
          const [ty, , , alpha] = tap(source, x + t * dx, y + t * dy);
          const ky = falloff ** Math.abs(t);
          sum[0] = (sum[0] ?? 0) + ky * ty;
          wy += ky * alpha;
        }
        // The chroma is read at drawn pixels, each weighed by the source pixels the two cover.
        for (let t = -reach; t <= reach; t++) {
          const [, tcb, tcr, alpha] = tap(source, dx !== 0 ? x + t : x, dx !== 0 ? y : y + t);
          const kc = chromaWeight(at, at + t, step, falloff);
          sum[1] = (sum[1] ?? 0) + kc * tcb;
          sum[2] = (sum[2] ?? 0) + kc * tcr;
          wc += kc * alpha;
        }
        if (wy < NO_WEIGHT) continue;
        const i = (y * pixels.width + x) * 4;
        pixels.data[i] = (sum[0] ?? 0) / wy;
        pixels.data[i + 1] = (sum[1] ?? 0) / wc;
        pixels.data[i + 2] = (sum[2] ?? 0) / wc;
      }
    }
  }

  /**
   * Hand this pass's direction, one source pixel long, and the falloff to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform2fv(locations.uPixel ?? null, this.horizontal ? [this.pixel[0], 0] : [0, this.pixel[1]]);
    gl.uniform1f(locations.uFalloff ?? null, blurFalloff(this.sigma));
  }
}

/**
 * ffmpeg's `unsharp` on Y alone: Y moves by the amount times its difference
 * from a binomial blur of it, each neighbour weighing as much as it is opaque.
 */
class AdjustUnsharp extends filters.BaseFilter<'AdjustUnsharp', { amount: number; row: number[]; pixel: [number, number] }> {
  declare amount: number;
  declare row: number[];
  declare pixel: [number, number];
  static type = 'AdjustUnsharp';
  static defaults = { amount: 0, row: SHARPEN_ROW, pixel: [0, 0] as [number, number] };
  static uniformLocations = ['uAmount', 'uPixel', 'uRow'];

  /**
   * The shader: up to seven taps a side, weights past the row's end at zero.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uAmount;
      uniform vec2 uPixel;
      uniform float uRow[7];
      uniform float uStepW;
      uniform float uStepH;
      varying vec2 vTexCoord;
      ${BETWEEN_GLSL}
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        float blur = 0.0;
        float weight = 0.0;
        for (int j = 0; j < 7; j++) {
          for (int i = 0; i < 7; i++) {
            float w = uRow[i] * uRow[j];
            if (w > 0.0) {
              vec4 s = between(vTexCoord + vec2(float(i - 3), float(j - 3)) * uPixel);
              blur += w * s.r;
              weight += w * s.a;
            }
          }
        }
        float y = weight < ${NO_WEIGHT} ? c.r : c.r + uAmount * (c.r - blur / weight);
        gl_FragColor = vec4(y, c.gba);
      }`;
  }

  /**
   * The same on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.amount === 0) return;
    const pixels = options.imageData;
    const source = { data: new Uint8ClampedArray(pixels.data), width: pixels.width, height: pixels.height };
    const reach = (this.row.length - 1) / 2;
    const dx = this.pixel[0] * pixels.width;
    const dy = this.pixel[1] * pixels.height;
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        let blur = 0;
        let weight = 0;
        for (let j = 0; j < this.row.length; j++) {
          for (let i = 0; i < this.row.length; i++) {
            const px = x + (i - reach) * dx;
            const py = y + (j - reach) * dy;
            const w = (this.row[i] ?? 0) * (this.row[j] ?? 0);
            const [ty, , , alpha] = tap(source, px, py);
            blur += w * ty;
            weight += w * alpha;
          }
        }
        if (weight < NO_WEIGHT) continue;
        const at = (y * pixels.width + x) * 4;
        const own = source.data[at] ?? 0;
        pixels.data[at] = own + this.amount * (own - blur / weight);
      }
    }
  }

  /**
   * Hand the amount, one source pixel in texture space and the centred row to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    const pad = (7 - this.row.length) / 2;
    gl.uniform1f(locations.uAmount ?? null, this.amount);
    gl.uniform2fv(locations.uPixel ?? null, this.pixel);
    gl.uniform1fv(locations.uRow ?? null, [...Array<number>(pad).fill(0), ...this.row, ...Array<number>(pad).fill(0)]);
  }
}

/**
 * ffmpeg's `noise` on every plane: Y and the two chroma planes each take their
 * own uniform noise of half the strength in codes, Y per source pixel and the
 * chroma per 2×2 block, as a 4:2:0 frame holds them. Drawn smaller than the
 * source, a pixel shows one cell of the many the result shown at that size
 * averages, so each plane's noise is scaled down by that averaging.
 */
class AdjustGrain extends filters.BaseFilter<
  'AdjustGrain',
  { strength: number; seed: number; cells: [number, number]; share: number }
> {
  declare strength: number;
  declare seed: number;
  declare cells: [number, number];
  declare share: number;
  static type = 'AdjustGrain';
  static defaults = { strength: 0, seed: 0, cells: [1, 1] as [number, number], share: 1 };
  static uniformLocations = ['uStrength', 'uSeed', 'uCells'];

  /**
   * The noise's half-span in codes for Y and for the chroma at the size drawn.
   * @returns Y's, then the chroma's.
   */
  private amplitudes(): [number, number] {
    const half = this.strength / 2;
    return [half * Math.min(1, this.share), half * Math.min(1, 2 * this.share)];
  }

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform vec2 uStrength;
      uniform float uSeed;
      uniform vec2 uCells;
      varying vec2 vTexCoord;
      float hash(vec2 cell, float seed) {
        return fract(sin((cell.x + seed) * 12.9898 + (cell.y + seed) * 78.233) * 43758.5453);
      }
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        vec2 cell = floor(vTexCoord * uCells);
        vec2 block = floor(cell / 2.0);
        vec3 add = vec3(
          (hash(cell, uSeed) - 0.5) * 2.0 * uStrength.x,
          (hash(block, uSeed + 17.0) - 0.5) * 2.0 * uStrength.y,
          (hash(block, uSeed + 43.0) - 0.5) * 2.0 * uStrength.y
        );
        gl_FragColor = vec4(c.rgb + add / 255.0, c.a);
      }`;
  }

  /**
   * The same grain on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.strength === 0) return;
    const { data, width, height } = options.imageData;
    const [ampY, ampC] = this.amplitudes();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // The pixel's centre, as the shader samples it.
        const cx = Math.floor(((x + 0.5) / width) * this.cells[0]);
        const cy = Math.floor(((y + 0.5) / height) * this.cells[1]);
        const bx = Math.floor(cx / 2);
        const by = Math.floor(cy / 2);
        const at = (y * width + x) * 4;
        data[at] = (data[at] ?? 0) + (hash(cx, cy, this.seed) - 0.5) * 2 * ampY;
        data[at + 1] = (data[at + 1] ?? 0) + (hash(bx, by, this.seed + 17) - 0.5) * 2 * ampC;
        data[at + 2] = (data[at + 2] ?? 0) + (hash(bx, by, this.seed + 43) - 0.5) * 2 * ampC;
      }
    }
  }

  /**
   * Hand the two amplitudes, the seed and the source's pixel grid to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform2fv(locations.uStrength ?? null, this.amplitudes());
    gl.uniform1f(locations.uSeed ?? null, this.seed);
    gl.uniform2fv(locations.uCells ?? null, this.cells);
  }
}

/**
 * ffmpeg's `vignette`: each value scaled by the fourth power of the cosine of
 * its angle off centre, the distance a circle in source pixels over the half
 * diagonal. ffmpeg measures from a pixel's integer index to half the frame and
 * truncates that offset toward zero (`vf_vignette.c`: `const int xx = (x -
 * s->x0) * s->xscale`), so an odd side has two middle pixels at distance 0.
 * On codes, Y scales toward 0 and the chroma toward 127, a 4:2:0 chroma sample
 * by the factor of its 2x2 block's top-left pixel (`fmap[x << hsub]`); on RGB,
 * which ffmpeg's frame is once `colorchannelmixer` ran, every channel toward 0
 * by its own pixel's factor.
 */
class AdjustVignette extends filters.BaseFilter<
  'AdjustVignette',
  { angle: number; onCodes: boolean; size: [number, number]; frame: [number, number] }
> {
  declare angle: number;
  declare onCodes: boolean;
  /** The source's width and height in pixels. */
  declare size: [number, number];
  /** The source pixels the drawn picture spans, which a preview pads past the source's own. */
  declare frame: [number, number];
  static type = 'AdjustVignette';
  static defaults = { angle: 0, onCodes: true, size: [1, 1] as [number, number], frame: [1, 1] as [number, number] };
  static uniformLocations = ['uAngle', 'uCenter', 'uSize', 'uFrame', 'uBlock'];

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uAngle;
      uniform vec3 uCenter;
      uniform vec2 uSize;
      uniform vec2 uFrame;
      uniform float uBlock;
      varying vec2 vTexCoord;
      float factor(vec2 index) {
        vec2 off = index - 0.5 * uSize;
        return pow(cos(uAngle * length(sign(off) * floor(abs(off))) / length(0.5 * uSize)), 4.0);
      }
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        vec2 index = floor(vTexCoord * uFrame);
        float luma = factor(index);
        float chroma = factor(uBlock * floor(index / uBlock));
        vec3 f = vec3(luma, chroma, chroma);
        gl_FragColor = vec4((c.rgb - uCenter) * f + uCenter, c.a);
      }`;
  }

  /**
   * The values each channel scales toward, as channel shares.
   * @returns Red's, green's and blue's.
   */
  private centers(): [number, number, number] {
    const chroma = this.onCodes ? VIGNETTE_C_MID / 255 : 0;
    return [0, chroma, chroma];
  }

  /**
   * The source pixels a chroma sample covers along each side: a 4:2:0 block on codes, one pixel on RGB.
   * @returns The block's side.
   */
  private block(): number {
    return this.onCodes ? 2 : 1;
  }

  /**
   * The same vignette on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.angle === 0) return;
    const { data, width, height } = options.imageData;
    const [sourceW, sourceH] = this.size;
    const [frameW, frameH] = this.frame;
    const reach = Math.hypot(sourceW / 2, sourceH / 2);
    const block = this.block();
    const centers = this.centers().map((share) => 255 * share);
    /**
     * ffmpeg's factor for one source pixel.
     * @param ix - Its column.
     * @param iy - Its row.
     * @returns The factor.
     */
    const factor = (ix: number, iy: number): number =>
      Math.cos((this.angle * Math.hypot(Math.trunc(ix - sourceW / 2), Math.trunc(iy - sourceH / 2))) / reach) ** 4;
    for (let y = 0; y < height; y++) {
      const iy = Math.floor(((y + 0.5) / height) * frameH);
      for (let x = 0; x < width; x++) {
        const ix = Math.floor(((x + 0.5) / width) * frameW);
        const luma = factor(ix, iy);
        const chroma = factor(block * Math.floor(ix / block), block * Math.floor(iy / block));
        const at = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const center = centers[ch] ?? 0;
          data[at + ch] = ((data[at + ch] ?? 0) - center) * (ch === 0 ? luma : chroma) + center;
        }
      }
    }
  }

  /**
   * Hand the angle, the centres, the source's size, the frame and the chroma block to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1f(locations.uAngle ?? null, this.angle);
    gl.uniform3fv(locations.uCenter ?? null, this.centers());
    gl.uniform2fv(locations.uSize ?? null, this.size);
    gl.uniform2fv(locations.uFrame ?? null, this.frame);
    gl.uniform1f(locations.uBlock ?? null, this.block());
  }
}

/** One filter in the chain: Fabric's own or one of ours. */
type AdjustFilter = InstanceType<typeof filters.BaseFilter>;

/**
 * The filters one adjust value comes to, in the order ffmpeg runs its stages.
 * Stages that change nothing are left out.
 * @param value - The sliders.
 * @param seed - The grain's seed, fixed for one panel so the preview and the export match.
 * @param source - The source's size in pixels.
 * @param drawn - The size the chain draws at, the source's own by default.
 * @param frame - The source pixels the drawn picture spans, the source's own by default.
 * @returns The chain.
 */
export function adjustFilters(value: AdjustValue, seed: number, source: Size, drawn: Size = source, frame: Size = source): AdjustFilter[] {
  const terms = adjustTerms(value);
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const pixel: [number, number] = [1 / width, 1 / height];
  const share = Math.sqrt((Math.max(1, drawn.width) * Math.max(1, drawn.height)) / (width * height));
  const codes: AdjustFilter[] = [];
  if (terms.brightness !== 0 || terms.contrast !== 1 || terms.saturation !== 1 || terms.hueRadians !== 0) {
    const hue = asWritten(terms.hueRadians, 6);
    codes.push(
      new AdjustColor({
        luma: eqPlane(asWritten(terms.contrast, 5), asWritten(terms.brightness, 5)),
        chroma: eqPlane(asWritten(terms.saturation, 5), 0),
        turn: [Math.round(Math.cos(hue) * 65536), Math.round(Math.sin(hue) * 65536)],
      }),
    );
  }
  if (terms.blur > 0) codes.push(new AdjustBlur({ sigma: terms.blur * MAX_BLUR_SIGMA_PX, pixel }));
  if (terms.grain > 0) {
    codes.push(new AdjustGrain({ strength: terms.grain, seed, cells: [width, height], share }));
  }
  if (terms.sharpen > 0) codes.push(new AdjustUnsharp({ amount: terms.sharpen, row: SHARPEN_ROW, pixel }));
  if (terms.clarity > 0) codes.push(new AdjustUnsharp({ amount: terms.clarity, row: CLARITY_ROW, pixel }));
  const vignette =
    terms.vignetteAngle > 0
      ? new AdjustVignette({
        angle: terms.vignetteAngle,
        onCodes: terms.channels === null,
        size: [Math.max(1, source.width), Math.max(1, source.height)],
        frame: [width, height],
      })
      : null;
  if (terms.channels === null) {
    if (vignette !== null) codes.push(vignette);
    return codes.length === 0 ? [] : [new AdjustCodes({ way: 'to' }), ...codes, new AdjustCodes({ way: 'from' })];
  }
  const { r, g, b } = terms.channels;
  return [
    new AdjustCodes({ way: 'to' }),
    ...codes,
    new AdjustCodes({ way: 'from' }),
    new filters.ColorMatrix({ matrix: [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0] }),
    ...(vignette === null ? [] : [vignette]),
  ];
}

/**
 * Run the chain on a pixel array through each filter's 2D path.
 * @param pixels - The picture, changed in place.
 * @param value - The sliders.
 * @param seed - The grain's seed.
 * @param source - The size of the source these pixels draw, when they are a smaller draw of it.
 * @param frame - The source pixels these pixels span, the source's own by default.
 */
export function adjustPixels(
  pixels: PixelState['imageData'],
  value: AdjustValue,
  seed: number,
  source: Size = pixels,
  frame: Size = source,
): void {
  for (const filter of adjustFilters(value, seed, source, pixels, frame)) filter.applyTo({ imageData: pixels } as never);
}
