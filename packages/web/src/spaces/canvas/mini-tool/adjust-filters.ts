// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picture adjust's filter chain (inner#1303 §6.1): the same
 * {@link adjustTerms} the video filter reads, built as Fabric filters in the
 * order ffmpeg runs its stages, so a slider means the same on a picture and a
 * video.
 *
 * Every distance is a share of the picture's width — the grain's cells, the
 * sharpening and clarity radii — so the preview drawn at the node's size and
 * the export drawn at the source's size come out alike once scaled to one
 * size. Each custom filter carries a WebGL shader and the same work on a pixel
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

/** What a WebGL filter pass reads, as far as these filters need it. */
interface GLState {
  sourceWidth: number;
  sourceHeight: number;
}

/** Luma weights (Rec. 709) the saturation turns about. */
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** The strongest noise reduction, as Fabric's blur share of the picture. */
const MAX_BLUR = 0.01;

/** The sharpening radius, as a share of the picture's width. */
const SHARPEN_RADIUS = 1 / 1024;

/** The clarity radius, as a share of the picture's width. */
const CLARITY_RADIUS = 1 / 512;

/** The grain's seed: fixed, so the preview and the export lay the same grain. */
export const ADJUST_GRAIN_SEED = 1;

/** How many grain cells fit across the picture. */
const GRAIN_CELLS = 512;

/**
 * Brightness, contrast and saturation as one colour matrix: contrast about the
 * middle, then the brightness lift, then saturation about the luma.
 * @param brightness - Added to every channel, in [-1, 1].
 * @param contrast - Contrast multiplier.
 * @param saturation - Saturation multiplier.
 * @returns Fabric's 4×5 matrix.
 */
function eqMatrix(brightness: number, contrast: number, saturation: number): number[] {
  const offset = 0.5 * (1 - contrast) + brightness;
  /**
   * One output channel's row.
   * @param channel - Which channel.
   * @returns Its three weights.
   */
  const row = (channel: number): number[] =>
    LUMA.map((weight, index) => contrast * ((1 - saturation) * weight + (index === channel ? saturation : 0)));
  return [...row(0), 0, offset, ...row(1), 0, offset, ...row(2), 0, offset, 0, 0, 0, 1, 0];
}

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

/** An unsharp mask whose radius is a share of the picture's width. */
class AdjustUnsharp extends filters.BaseFilter<'AdjustUnsharp', { amount: number; radius: number }> {
  declare amount: number;
  declare radius: number;
  declare aspectRatio: number;
  static type = 'AdjustUnsharp';
  static defaults = { amount: 0, radius: SHARPEN_RADIUS };
  static uniformLocations = ['uAmount', 'uDelta'];

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uAmount;
      uniform vec2 uDelta;
      uniform float uStepW;
      uniform float uStepH;
      varying vec2 vTexCoord;
      // Fabric's textures sample by nearest neighbour, which snaps an offset
      // under a texel to none or a whole one; this blends the four texels
      // around it, as the 2D path's sample() does.
      vec4 between(vec2 at) {
        vec2 step = vec2(uStepW, uStepH);
        vec2 texel = at / step - 0.5;
        vec2 part = fract(texel);
        vec2 base = (floor(texel) + 0.5) * step;
        vec4 top = mix(texture2D(uTexture, base), texture2D(uTexture, base + vec2(step.x, 0.0)), part.x);
        vec4 bottom = mix(texture2D(uTexture, base + vec2(0.0, step.y)), texture2D(uTexture, base + step), part.x);
        return mix(top, bottom, part.y);
      }
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        vec4 around = (between(vTexCoord + vec2(uDelta.x, 0.0))
          + between(vTexCoord - vec2(uDelta.x, 0.0))
          + between(vTexCoord + vec2(0.0, uDelta.y))
          + between(vTexCoord - vec2(0.0, uDelta.y))) * 0.25;
        gl_FragColor = vec4(c.rgb + uAmount * (c.rgb - around.rgb), c.a);
      }`;
  }

  /**
   * Remember the picture's shape, then run the pass.
   * @param options - The pipeline state.
   */
  applyTo(options: Parameters<filters.BaseFilter<string, object>['applyTo']>[0]): void {
    const gl = options as unknown as Partial<GLState>;
    if (gl.sourceWidth !== undefined && gl.sourceHeight !== undefined) this.aspectRatio = gl.sourceWidth / gl.sourceHeight;
    super.applyTo(options);
  }

  /**
   * The same mask on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.amount === 0) return;
    const pixels = options.imageData;
    const source = { ...pixels, data: new Uint8ClampedArray(pixels.data) };
    const d = this.radius * pixels.width;
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        const i = (y * pixels.width + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const around =
            (sample(source, x + d, y, ch) + sample(source, x - d, y, ch) + sample(source, x, y + d, ch) + sample(source, x, y - d, ch)) / 4;
          const c = source.data[i + ch] ?? 0;
          pixels.data[i + ch] = c + this.amount * (c - around);
        }
      }
    }
  }

  /**
   * Hand the amount and the texture-space radius to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1f(locations.uAmount ?? null, this.amount);
    gl.uniform2fv(locations.uDelta ?? null, [this.radius, this.radius * (this.aspectRatio || 1)]);
  }

  /**
   * Whether the pass changes nothing.
   * @returns True at zero amount.
   */
  isNeutralState(): boolean {
    return this.amount === 0;
  }
}

/** Grain: a repeatable noise laid in cells sized as a share of the picture. */
class AdjustGrain extends filters.BaseFilter<'AdjustGrain', { strength: number; seed: number }> {
  declare strength: number;
  declare seed: number;
  declare aspectRatio: number;
  static type = 'AdjustGrain';
  static defaults = { strength: 0, seed: 0 };
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
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        vec2 cell = floor(vTexCoord * uCells);
        float n = fract(sin((cell.x + uSeed) * 12.9898 + (cell.y + uSeed) * 78.233) * 43758.5453);
        gl_FragColor = vec4(c.rgb + (n - 0.5) * 2.0 * uStrength / 255.0, c.a);
      }`;
  }

  /**
   * Remember the picture's shape, then run the pass.
   * @param options - The pipeline state.
   */
  applyTo(options: Parameters<filters.BaseFilter<string, object>['applyTo']>[0]): void {
    const gl = options as unknown as Partial<GLState>;
    if (gl.sourceWidth !== undefined && gl.sourceHeight !== undefined) this.aspectRatio = gl.sourceWidth / gl.sourceHeight;
    super.applyTo(options);
  }

  /**
   * The same grain on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.strength === 0) return;
    const { data, width, height } = options.imageData;
    const cellsY = GRAIN_CELLS * (height / width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const n = hash(Math.floor((x / width) * GRAIN_CELLS), Math.floor((y / height) * cellsY), this.seed);
        const add = (n - 0.5) * 2 * this.strength;
        const i = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) data[i + ch] = (data[i + ch] ?? 0) + add;
      }
    }
  }

  /**
   * Hand the strength, the seed and the cell grid to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1f(locations.uStrength ?? null, this.strength);
    gl.uniform1f(locations.uSeed ?? null, this.seed);
    gl.uniform2fv(locations.uCells ?? null, [GRAIN_CELLS, GRAIN_CELLS / (this.aspectRatio || 1)]);
  }

  /**
   * Whether the pass changes nothing.
   * @returns True at zero strength.
   */
  isNeutralState(): boolean {
    return this.strength === 0;
  }
}

/** A lens vignette: each pixel darkened by the fourth power of the cosine of its angle off centre. */
class AdjustVignette extends filters.BaseFilter<'AdjustVignette', { angle: number }> {
  declare angle: number;
  static type = 'AdjustVignette';
  static defaults = { angle: 0 };
  static uniformLocations = ['uAngle'];

  /**
   * The shader.
   * @returns Its source.
   */
  getFragmentSource(): string {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uAngle;
      varying vec2 vTexCoord;
      void main() {
        vec4 c = texture2D(uTexture, vTexCoord);
        float d = length(vTexCoord - 0.5) / length(vec2(0.5));
        float f = pow(cos(min(1.5707963, uAngle * d)), 4.0);
        gl_FragColor = vec4(c.rgb * f, c.a);
      }`;
  }

  /**
   * The same vignette on a pixel array.
   * @param options - The pipeline state.
   */
  applyTo2d(options: PixelState): void {
    if (this.angle === 0) return;
    const { data, width, height } = options.imageData;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const d = Math.hypot((x + 0.5) / width - 0.5, (y + 0.5) / height - 0.5) / Math.SQRT1_2;
        const f = Math.cos(Math.min(Math.PI / 2, this.angle * d)) ** 4;
        const i = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) data[i + ch] = (data[i + ch] ?? 0) * f;
      }
    }
  }

  /**
   * Hand the angle to the shader.
   * @param gl - The context.
   * @param locations - The uniforms.
   */
  sendUniformData(gl: WebGLRenderingContext, locations: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1f(locations.uAngle ?? null, this.angle);
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
 * Stages that change nothing are left out. A stage that reads neighbouring
 * pixels reaches at least one of the source's own pixels, as ffmpeg's smallest
 * unsharp matrix does; the reach stays a share of the picture (of the width for
 * the unsharp, of the short side for the blur), so a smaller draw of the same
 * source (the node's preview) shows the export's effect scaled.
 * @param value - The sliders.
 * @param seed - The grain's seed, fixed for one panel so the preview and the export match.
 * @param source - The source's size in pixels.
 * @param source.width - Its width.
 * @param source.height - Its height.
 * @returns The chain.
 */
export function adjustFilters(value: AdjustValue, seed: number, source: { width: number; height: number }): AdjustFilter[] {
  const terms = adjustTerms(value);
  // The unsharp reaches a share of the width both ways; Fabric's blur a share
  // of the short side both ways (Blur.getBlurValue).
  const onePixel = 1 / Math.max(1, source.width);
  const oneShortPixel = 1 / Math.max(1, Math.min(source.width, source.height));
  const chain: AdjustFilter[] = [];
  if (terms.brightness !== 0 || terms.contrast !== 1 || terms.saturation !== 1) {
    chain.push(new filters.ColorMatrix({ matrix: eqMatrix(terms.brightness, terms.contrast, terms.saturation) }));
  }
  if (terms.hueRadians !== 0) chain.push(new filters.HueRotation({ rotation: terms.hueRadians / Math.PI }));
  if (terms.blur > 0) chain.push(new filters.Blur({ blur: Math.max(terms.blur * MAX_BLUR, oneShortPixel / 0.12) }));
  if (terms.grain > 0) chain.push(new AdjustGrain({ strength: terms.grain, seed }));
  if (terms.sharpen > 0) {
    chain.push(new AdjustUnsharp({ amount: terms.sharpen, radius: Math.max(SHARPEN_RADIUS, onePixel) }));
  }
  if (terms.clarity > 0) {
    chain.push(new AdjustUnsharp({ amount: terms.clarity, radius: Math.max(CLARITY_RADIUS, onePixel) }));
  }
  if (terms.channels !== null) {
    const { r, g, b } = terms.channels;
    chain.push(new filters.ColorMatrix({ matrix: [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0] }));
  }
  if (terms.vignetteAngle > 0) chain.push(new AdjustVignette({ angle: terms.vignetteAngle }));
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
  // `applyTo` rather than `applyTo2d`: a matrix filter such as the hue works its matrix out there.
  for (const filter of adjustFilters(value, seed, source)) filter.applyTo({ imageData: pixels } as never);
}
