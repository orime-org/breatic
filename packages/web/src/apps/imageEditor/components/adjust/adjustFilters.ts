import { classRegistry, filters, type T2DPipelineState, type TWebGLUniformLocationMap } from 'fabric';
import type { AdjustValue } from './AdjustBottomToolbar';

const toUnit = (value: number, divisor = 100) => Math.max(-1, Math.min(1, value / divisor));

type AdjustVignetteProps = { amount: number };

class AdjustVignette extends filters.BaseFilter<'AdjustVignette', AdjustVignetteProps> {
  declare amount: AdjustVignetteProps['amount'];
  static type = 'AdjustVignette';
  static defaults: AdjustVignetteProps = { amount: 0 };
  static uniformLocations = ['uAmount'];

  getFragmentSource() {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uAmount;
      varying vec2 vTexCoord;
      void main() {
        vec2 uv = vTexCoord - vec2(0.5);
        float d = length(uv) * 1.4142135623730951;
        float dn = smoothstep(0.06, 1.0, d);
        float edge = pow(dn, 1.6);
        vec4 color = texture2D(uTexture, vTexCoord);
        color.rgb *= (1.0 - uAmount * edge);
        color.rgb = clamp(color.rgb, 0.0, 1.0);
        gl_FragColor = color;
      }
    `;
  }

  applyTo2d({ imageData: { data, width, height } }: T2DPipelineState) {
    const amount = this.amount;
    if (amount === 0) return;
    const smoothstep = (edge0: number, edge1: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = (x + 0.5) / width - 0.5;
        const ny = (y + 0.5) / height - 0.5;
        const d = Math.min(1, Math.hypot(nx * 2, ny * 2) / Math.SQRT2);
        const dn = smoothstep(0.06, 1.0, d);
        const edge = dn ** 1.6;
        const mul = 1 - amount * edge;
        const i = (y * width + x) * 4;
        data[i] = Math.max(0, Math.min(255, data[i]! * mul));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1]! * mul));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2]! * mul));
      }
    }
  }

  sendUniformData(gl: WebGLRenderingContext, uniformLocations: TWebGLUniformLocationMap) {
    gl.uniform1f(uniformLocations.uAmount, this.amount);
  }

  isNeutralState() {
    return this.amount === 0;
  }
}

classRegistry.setClass(AdjustVignette);

export const isNeutralAdjustValue = (value: AdjustValue) => Object.values(value).every((v) => v === 0);

export const buildAdjustFabricFilters = (value: AdjustValue): unknown[] => {
  const result: unknown[] = [];
  const brightness = toUnit(value.exposure * 0.9 + value.highlights * 0.25 - value.shadows * 0.2 + value.fade * 0.15);
  const contrast = toUnit(value.contrast * 0.9 + value.clarity * 0.35);
  const saturation = toUnit(value.saturation * 0.85 + value.vibrance * 0.45 - value.fade * 0.15);
  const hueRotation = toUnit(-value.hue, 180);
  const blur = Math.max(0, Math.min(1, value.noiseReduction / 100));
  const noise = Math.max(0, value.grain) * 2.1;
  const tempUnit = toUnit(value.temperature);
  const tintUnit = toUnit(value.tint);
  const fadeAlpha = (Math.max(0, value.fade) / 100) * 0.35;

  if (brightness !== 0) result.push(new filters.Brightness({ brightness }));
  if (contrast !== 0) result.push(new filters.Contrast({ contrast }));
  if (saturation !== 0) result.push(new filters.Saturation({ saturation }));
  if (hueRotation !== 0) result.push(new filters.HueRotation({ rotation: hueRotation }));
  if (blur > 0) result.push(new filters.Blur({ blur }));
  if (noise > 0) result.push(new filters.Noise({ noise }));

  if (value.sharpness > 0) {
    const amount = Math.max(0, value.sharpness) / 100;
    result.push(new filters.Convolute({ matrix: [0, -amount, 0, -amount, 1 + amount * 4, -amount, 0, -amount, 0] }));
  }
  if (value.clarity > 0) {
    const amount = (Math.max(0, value.clarity) / 100) * 0.6;
    result.push(
      new filters.Convolute({
        matrix: [-amount, -amount, -amount, -amount, 1 + amount * 8, -amount, -amount, -amount, -amount],
      }),
    );
  }
  if (tempUnit !== 0 || tintUnit !== 0) {
    const rGain = 1 + tempUnit * 0.22 - tintUnit * 0.08;
    const gGain = 1 + tempUnit * 0.06 + tintUnit * 0.2;
    const bGain = 1 - tempUnit * 0.28 - tintUnit * 0.1;
    result.push(
      new filters.ColorMatrix({
        matrix: [rGain, 0, 0, 0, 0, 0, gGain, 0, 0, 0, 0, 0, bGain, 0, 0, 0, 0, 0, 1, 0],
      }),
    );
  }
  if (fadeAlpha > 0) {
    result.push(new filters.BlendColor({ color: '#ffffff', mode: 'screen', alpha: fadeAlpha }));
  }

  const vignetteAmount = toUnit(value.vignette);
  if (vignetteAmount !== 0) {
    result.push(new AdjustVignette({ amount: vignetteAmount }));
  }

  return result;
};

