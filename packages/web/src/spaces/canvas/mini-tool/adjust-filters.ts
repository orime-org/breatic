// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picture adjust's filter chain (inner#1303 §6.1): the same
 * {@link adjustTerms} the video filter reads, built as Fabric filters in the
 * order ffmpeg runs its stages, so a slider means the same on a picture and a
 * video.
 *
 * ffmpeg runs the video's stages on limited-range BT.601 YUV, the format it
 * turns an RGB frame into: `eq` moves Y's codes, saturation and `hue` the
 * chroma, `noise` and `vignette` every plane, `unsharp` Y alone. Each stage
 * here does the same to an RGB picture, and `adjust-ffmpeg.test.ts` holds it
 * to what ffmpeg makes of the video's own filter string.
 *
 * Distances are in source pixels, as ffmpeg's are, and are handed to the
 * filters as shares of the source, so the preview drawn at the node's size
 * shows the export's effect scaled. Each custom filter carries a WebGL shader
 * and the same work on a pixel array, which Fabric runs where there is no
 * WebGL.
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

/** BT.601 luma weights, red and blue: ffmpeg's RGB to YUV conversion uses them. */
const KR = 0.299;
const KB = 0.114;
const KG = 1 - KR - KB;

/** Limited-range codes: Y spans 16 to 235, chroma 16 to 240. */
const Y_SPAN = 219;
const C_SPAN = 224;
const Y_FLOOR = 16;

/** Y's middle code, 127.5, and its lowest and highest codes, 0 and 255, as full-range shares. */
const PIVOT = (127.5 - Y_FLOOR) / Y_SPAN;
const Y_LOW = -Y_FLOOR / Y_SPAN;
const Y_HIGH = (255 - Y_FLOOR) / Y_SPAN;

/** The chroma's lowest and highest codes, 0 and 255, about its middle code of 128, as full-range shares. */
const C_LOW = -128 / C_SPAN;
const C_HIGH = 127 / C_SPAN;

/**
 * A number held between two others.
 * @param value - The number.
 * @param low - The least.
 * @param high - The most.
 * @returns It, held.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The strongest noise reduction's spread in source pixels: the video's `gblur=sigma=3*blur` (adjust-value.ts). */
const MAX_BLUR_SIGMA_PX = 3;

/** ffmpeg's 5×5 and 7×7 unsharp matrices blur with these binomial rows. */
const SHARPEN_ROW = [1, 4, 6, 4, 1].map((w) => w / 16);
const CLARITY_ROW = [1, 6, 15, 20, 15, 6, 1].map((w) => w / 64);

/** The grain's seed: fixed, so the preview and the export lay the same grain. */
export const ADJUST_GRAIN_SEED = 1;

/**
 * A pixel's channel read at a fractional position, clamped to the edges.
 * @param pixels - The picture.
 * @param x - Its x.
 * @param y - Its y.
 * @param channel - Which channel.
 * @returns The value.
 */
function sample(pixels: PixelState['imageData'], x: number, y: number, channel: number): number {
  const { data, width, height } = pixels;
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  /**
   * One whole pixel's channel.
   * @param px - Its x.
   * @param py - Its y.
   * @returns The value.
   */
  const at = (px: number, py: number): number => data[(py * width + px) * 4 + channel] ?? 0;
  return (
    (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
  );
}

/**
 * A pixel's BT.601 luma at a fractional position.
 * @param pixels - The picture.
 * @param x - Its x.
 * @param y - Its y.
 * @returns The luma, in channel levels.
 */
function lumaAt(pixels: PixelState['imageData'], x: number, y: number): number {
  return KR * sample(pixels, x, y, 0) + KG * sample(pixels, x, y, 1) + KB * sample(pixels, x, y, 2);
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

/** The shader's bilinear read: Fabric's textures sample by nearest neighbour. */
const BETWEEN_GLSL = `
  vec4 between(vec2 at) {
    vec2 step = vec2(uStepW, uStepH);
    vec2 texel = at / step - 0.5;
    vec2 part = fract(texel);
    vec2 base = (floor(texel) + 0.5) * step;
    vec4 top = mix(texture2D(uTexture, base), texture2D(uTexture, base + vec2(step.x, 0.0)), part.x);
    vec4 bottom = mix(texture2D(uTexture, base + vec2(0.0, step.y)), texture2D(uTexture, base + step), part.x);
    return mix(top, bottom, part.y);
  }`;

/**
 * ffmpeg's `eq` then `hue` on a limited-range BT.601 frame: contrast about the
 * middle code and the brightness lift on Y, saturation and the turn on the
 * chroma, each plane held to its codes before the frame turns back to RGB.
 */
class AdjustColor extends filters.BaseFilter<'AdjustColor', { contrast: number; lift: number; turn: [number, number] }> {
  declare contrast: number;
  declare lift: number;
  declare turn: [number, number];
  static type = 'AdjustColor';
  static defaults = { contrast: 1, lift: 0, turn: [1, 0] as [number, number] };
  static uniformLocations = ['uContrast', 'uLift', 'uTurn'];

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uContrast;
      uniform float uLift;
      uniform vec2 uTurn;
      varying vec2 vTexCoord;
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        float y = dot(c.rgb, vec3(${KR}, ${KG}, ${KB}));
        vec2 ch = vec2((c.b - y) / ${2 * (1 - KB)}, (c.r - y) / ${2 * (1 - KR)});
        y = clamp(uContrast * (y - ${PIVOT}) + ${PIVOT} + uLift, ${Y_LOW}, ${Y_HIGH});
        ch = clamp(vec2(ch.x * uTurn.x - ch.y * uTurn.y, ch.x * uTurn.y + ch.y * uTurn.x), ${C_LOW}, ${C_HIGH});
        float r = y + ${2 * (1 - KR)} * ch.y;
        float b = y + ${2 * (1 - KB)} * ch.x;
        gl_FragColor = vec4(r, (y - ${KR} * r - ${KB} * b) / ${KG}, b, c.a);
      }`;
  }

  /**
   * The same on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    const { data } = options.imageData;
    const [cos, sin] = this.turn;
    for (let i = 0; i < data.length; i += 4) {
      const r = (data[i] ?? 0) / 255;
      const g = (data[i + 1] ?? 0) / 255;
      const b = (data[i + 2] ?? 0) / 255;
      const y0 = KR * r + KG * g + KB * b;
      const cb0 = (b - y0) / (2 * (1 - KB));
      const cr0 = (r - y0) / (2 * (1 - KR));
      const y = clamp(this.contrast * (y0 - PIVOT) + PIVOT + this.lift, Y_LOW, Y_HIGH);
      const cb = clamp(cb0 * cos - cr0 * sin, C_LOW, C_HIGH);
      const cr = clamp(cb0 * sin + cr0 * cos, C_LOW, C_HIGH);
      const r2 = y + 2 * (1 - KR) * cr;
      const b2 = y + 2 * (1 - KB) * cb;
      data[i] = 255 * r2;
      data[i + 1] = (255 * (y - KR * r2 - KB * b2)) / KG;
      data[i + 2] = 255 * b2;
    }
  }

  /**
   * Hand the contrast, the lift and the chroma turn to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1f(locations.uContrast ?? null, this.contrast);
    gl.uniform1f(locations.uLift ?? null, this.lift);
    gl.uniform2fv(locations.uTurn ?? null, this.turn);
  }

  /**
   * Whether the pass changes nothing.
   * @returns True with no contrast, lift or turn.
   */
  isNeutralState(): boolean {
    return this.contrast === 1 && this.lift === 0 && this.turn[0] === 1 && this.turn[1] === 0;
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
 * ffmpeg's `gblur` on every plane of a 4:2:0 frame: Y's kernel falls by the
 * factor a source pixel, the chroma's by the same factor a chroma pixel, which
 * is two source pixels. Fabric's two passes, across then down, carry it.
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
      void main() {
        float y = 0.0;
        vec2 c = vec2(0.0);
        float wy = 0.0;
        float wc = 0.0;
        for (int t = -${BLUR_TAPS}; t <= ${BLUR_TAPS}; t++) {
          float at = abs(float(t));
          vec3 s = between(vTexCoord + uPixel * float(t)).rgb;
          float sy = dot(s, vec3(${KR}, ${KG}, ${KB}));
          float ky = pow(uFalloff, at);
          float kc = pow(uFalloff, at / 2.0);
          y += ky * sy;
          c += kc * vec2(s.b - sy, s.r - sy);
          wy += ky;
          wc += kc;
        }
        y /= wy;
        c /= wc;
        vec3 rgb = vec3(y + c.y, y - (${KR} * c.y + ${KB} * c.x) / ${KG}, y + c.x);
        gl_FragColor = vec4(rgb, texture2D(uTexture, vTexCoord).a);
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
    const source = { ...pixels, data: new Uint8ClampedArray(pixels.data) };
    const falloff = blurFalloff(this.sigma);
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        let sy = 0;
        let cb = 0;
        let cr = 0;
        let wy = 0;
        let wc = 0;
        for (let t = -BLUR_TAPS; t <= BLUR_TAPS; t++) {
          const px = x + t * dx;
          const py = y + t * dy;
          const r = sample(source, px, py, 0);
          const b = sample(source, px, py, 2);
          const l = KR * r + KG * sample(source, px, py, 1) + KB * b;
          const ky = falloff ** Math.abs(t);
          const kc = falloff ** (Math.abs(t) / 2);
          sy += ky * l;
          cb += kc * (b - l);
          cr += kc * (r - l);
          wy += ky;
          wc += kc;
        }
        sy /= wy;
        cb /= wc;
        cr /= wc;
        const i = (y * pixels.width + x) * 4;
        pixels.data[i] = sy + cr;
        pixels.data[i + 1] = sy - (KR * cr + KB * cb) / KG;
        pixels.data[i + 2] = sy + cb;
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

  /**
   * Whether the pass changes nothing.
   * @returns True at no spread.
   */
  isNeutralState(): boolean {
    return this.sigma === 0;
  }
}

/**
 * ffmpeg's `unsharp` on luma alone: Y moves by the amount times its difference
 * from a binomial blur of it, and every channel moves with Y.
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
      float luma(vec4 c) { return dot(c.rgb, vec3(${KR}, ${KG}, ${KB})); }
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        float blur = 0.0;
        for (int j = 0; j < 7; j++) {
          for (int i = 0; i < 7; i++) {
            float w = uRow[i] * uRow[j];
            if (w > 0.0) blur += w * luma(between(vTexCoord + vec2(float(i - 3), float(j - 3)) * uPixel));
          }
        }
        gl_FragColor = vec4(c.rgb + uAmount * (luma(c) - blur), c.a);
      }`;
  }

  /**
   * The same on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.amount === 0) return;
    const pixels = options.imageData;
    const source = { ...pixels, data: new Uint8ClampedArray(pixels.data) };
    const half = (this.row.length - 1) / 2;
    const dx = this.pixel[0] * pixels.width;
    const dy = this.pixel[1] * pixels.height;
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        let blur = 0;
        for (let j = 0; j < this.row.length; j++) {
          for (let i = 0; i < this.row.length; i++) {
            blur += (this.row[i] ?? 0) * (this.row[j] ?? 0) * lumaAt(source, x + (i - half) * dx, y + (j - half) * dy);
          }
        }
        const move = this.amount * (lumaAt(source, x, y) - blur);
        const at = (y * pixels.width + x) * 4;
        for (let ch = 0; ch < 3; ch++) pixels.data[at + ch] = (source.data[at + ch] ?? 0) + move;
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

  /**
   * Whether the pass changes nothing.
   * @returns True at zero amount.
   */
  isNeutralState(): boolean {
    return this.amount === 0;
  }
}

/**
 * ffmpeg's `noise` on every plane: Y and the two chroma planes each take their
 * own uniform noise of half the strength in codes, Y per source pixel and the
 * chroma per 2×2 block, as a 4:2:0 frame holds them.
 */
class AdjustGrain extends filters.BaseFilter<'AdjustGrain', { strength: number; seed: number; cells: [number, number] }> {
  declare strength: number;
  declare seed: number;
  declare cells: [number, number];
  static type = 'AdjustGrain';
  static defaults = { strength: 0, seed: 0, cells: [1, 1] as [number, number] };
  static uniformLocations = ['uStrength', 'uSeed', 'uCells'];

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uStrength;
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
        float amp = uStrength / 2.0;
        float y = (hash(cell, uSeed) - 0.5) * 2.0 * amp / ${Y_SPAN}.0;
        float cb = (hash(block, uSeed + 17.0) - 0.5) * 2.0 * amp / ${C_SPAN}.0;
        float cr = (hash(block, uSeed + 43.0) - 0.5) * 2.0 * amp / ${C_SPAN}.0;
        vec3 add = vec3(y + ${2 * (1 - KR)} * cr, y - ${(2 * (1 - KB) * KB) / KG} * cb - ${(2 * (1 - KR) * KR) / KG} * cr, y + ${2 * (1 - KB)} * cb);
        gl_FragColor = vec4(c.rgb + add, c.a);
      }`;
  }

  /**
   * The same grain on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.strength === 0) return;
    const { data, width, height } = options.imageData;
    const half = this.strength / 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cx = Math.floor((x / width) * this.cells[0]);
        const cy = Math.floor((y / height) * this.cells[1]);
        const bx = Math.floor(cx / 2);
        const by = Math.floor(cy / 2);
        const dy = ((hash(cx, cy, this.seed) - 0.5) * 2 * half * 255) / Y_SPAN;
        const dcb = ((hash(bx, by, this.seed + 17) - 0.5) * 2 * half * 255) / C_SPAN;
        const dcr = ((hash(bx, by, this.seed + 43) - 0.5) * 2 * half * 255) / C_SPAN;
        const add = [
          dy + 2 * (1 - KR) * dcr,
          dy - ((2 * (1 - KB) * KB) / KG) * dcb - ((2 * (1 - KR) * KR) / KG) * dcr,
          dy + 2 * (1 - KB) * dcb,
        ];
        const at = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) data[at + ch] = (data[at + ch] ?? 0) + (add[ch] ?? 0);
      }
    }
  }

  /**
   * Hand the strength, the seed and the source's pixel grid to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1f(locations.uStrength ?? null, this.strength);
    gl.uniform1f(locations.uSeed ?? null, this.seed);
    gl.uniform2fv(locations.uCells ?? null, this.cells);
  }

  /**
   * Whether the pass changes nothing.
   * @returns True at zero strength.
   */
  isNeutralState(): boolean {
    return this.strength === 0;
  }
}

/**
 * ffmpeg's `vignette`: each pixel's codes, Y's floor of 16 with them, scaled by
 * the fourth power of the cosine of its angle off centre, the distance a
 * circle in pixels over the half diagonal.
 */
class AdjustVignette extends filters.BaseFilter<'AdjustVignette', { angle: number; aspect: number }> {
  declare angle: number;
  declare aspect: number;
  static type = 'AdjustVignette';
  static defaults = { angle: 0, aspect: 1 };
  static uniformLocations = ['uAngle', 'uAspect'];

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uAngle;
      uniform float uAspect;
      varying vec2 vTexCoord;
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        vec2 off = (vTexCoord - 0.5) * vec2(uAspect, 1.0);
        float d = length(off) / length(vec2(uAspect, 1.0) * 0.5);
        float f = pow(cos(uAngle * d), 4.0);
        gl_FragColor = vec4(max(c.rgb * f - ${Y_FLOOR / Y_SPAN} * (1.0 - f), 0.0), c.a);
      }`;
  }

  /**
   * The same vignette on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.angle === 0) return;
    const { data, width, height } = options.imageData;
    const reach = Math.hypot(this.aspect, 1) / 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const d = Math.hypot(((x + 0.5) / width - 0.5) * this.aspect, (y + 0.5) / height - 0.5) / reach;
        const f = Math.cos(this.angle * d) ** 4;
        const at = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) data[at + ch] = (data[at + ch] ?? 0) * f - ((255 * Y_FLOOR) / Y_SPAN) * (1 - f);
      }
    }
  }

  /**
   * Hand the angle and the source's shape to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1f(locations.uAngle ?? null, this.angle);
    gl.uniform1f(locations.uAspect ?? null, this.aspect);
  }

  /**
   * Whether the pass changes nothing.
   * @returns True at zero angle.
   */
  isNeutralState(): boolean {
    return this.angle === 0;
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
 * @param source.width - Its width.
 * @param source.height - Its height.
 * @returns The chain.
 */
export function adjustFilters(value: AdjustValue, seed: number, source: { width: number; height: number }): AdjustFilter[] {
  const terms = adjustTerms(value);
  const width = Math.max(1, source.width);
  const height = Math.max(1, source.height);
  const pixel: [number, number] = [1 / width, 1 / height];
  const chain: AdjustFilter[] = [];
  if (terms.brightness !== 0 || terms.contrast !== 1 || terms.saturation !== 1 || terms.hueRadians !== 0) {
    const turn: [number, number] = [Math.cos(terms.hueRadians) * terms.saturation, Math.sin(terms.hueRadians) * terms.saturation];
    chain.push(new AdjustColor({ contrast: terms.contrast, lift: (255 / Y_SPAN) * terms.brightness, turn }));
  }
  if (terms.blur > 0) chain.push(new AdjustBlur({ sigma: terms.blur * MAX_BLUR_SIGMA_PX, pixel }));
  if (terms.grain > 0) chain.push(new AdjustGrain({ strength: terms.grain, seed, cells: [width, height] }));
  if (terms.sharpen > 0) chain.push(new AdjustUnsharp({ amount: terms.sharpen, row: SHARPEN_ROW, pixel }));
  if (terms.clarity > 0) chain.push(new AdjustUnsharp({ amount: terms.clarity, row: CLARITY_ROW, pixel }));
  if (terms.channels !== null) {
    const { r, g, b } = terms.channels;
    chain.push(new filters.ColorMatrix({ matrix: [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0] }));
  }
  if (terms.vignetteAngle > 0) chain.push(new AdjustVignette({ angle: terms.vignetteAngle, aspect: width / height }));
  return chain;
}

/**
 * Run the chain on a pixel array through each filter's 2D path.
 * @param pixels - The picture, changed in place.
 * @param value - The sliders.
 * @param seed - The grain's seed.
 * @param source - The size of the source these pixels draw, when they are a smaller draw of it.
 * @param source.width - Its width.
 * @param source.height - Its height.
 */
export function adjustPixels(
  pixels: PixelState['imageData'],
  value: AdjustValue,
  seed: number,
  source: { width: number; height: number } = pixels,
): void {
  for (const filter of adjustFilters(value, seed, source)) filter.applyTo({ imageData: pixels } as never);
}
