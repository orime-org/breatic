import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { AdjustValue } from '@/apps/project/components/mixedEditor/node/imageNode/adjust/AdjustBottomToolbar';
import { defaultAdjustValue } from '@/apps/project/components/mixedEditor/node/imageNode/adjust/AdjustBottomToolbar';

const ffmpegCoreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const ffmpegLoadTimeoutMs = 30000;
const ffmpegFetchTimeoutMs = 30000;
/** Full-length re-encode can exceed cut/speed defaults; allow more headroom for adjust. */
const ffmpegExecTimeoutMs = 600000;

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

const toUnit = (value: number, divisor = 100) => Math.max(-1, Math.min(1, value / divisor));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

const ensureFfmpegLoaded = async (): Promise<FFmpeg> => {
  if (ffmpegInstance) return ffmpegInstance;
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const coreURL = await withTimeout(
        toBlobURL(`${ffmpegCoreBaseUrl}/ffmpeg-core.js`, 'text/javascript'),
        ffmpegLoadTimeoutMs,
        'Loading ffmpeg core script',
      );
      const wasmURL = await withTimeout(
        toBlobURL(`${ffmpegCoreBaseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
        ffmpegLoadTimeoutMs,
        'Loading ffmpeg wasm binary',
      );
      const workerURL = await withTimeout(
        toBlobURL(`${ffmpegCoreBaseUrl}/ffmpeg-core.worker.js`, 'text/javascript'),
        ffmpegLoadTimeoutMs,
        'Loading ffmpeg worker',
      );
      await withTimeout(ffmpeg.load({ coreURL, wasmURL, workerURL }), ffmpegLoadTimeoutMs, 'Initializing ffmpeg');
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }
  try {
    return await ffmpegLoadPromise;
  } catch (error) {
    ffmpegLoadPromise = null;
    ffmpegInstance = null;
    throw error;
  }
};

export function isAdjustValueNeutral(value: AdjustValue): boolean {
  return (Object.keys(defaultAdjustValue) as (keyof AdjustValue)[]).every((k) => value[k] === defaultAdjustValue[k]);
}

/**
 * Builds an `-vf` chain aligned with {@link buildAdjustFabricFilters} order in `ImageNode.tsx`.
 */
export function buildAdjustVideoFilter(value: AdjustValue): string {
  const parts: string[] = [];

  const brightness = toUnit(value.exposure * 0.9 + value.highlights * 0.25 - value.shadows * 0.2 + value.fade * 0.15);
  const contrastF = toUnit(value.contrast * 0.9 + value.clarity * 0.35);
  const satF = toUnit(value.saturation * 0.85 + value.vibrance * 0.45 - value.fade * 0.15);
  const fadeBump = (Math.max(0, value.fade) / 100) * 0.12;
  const br = Math.max(-1, Math.min(1, brightness + fadeBump));
  const contrast = Math.min(3, Math.max(0.01, 1 + contrastF * 0.85));
  const saturation = Math.min(4, Math.max(0, 1 + satF));

  parts.push(`eq=brightness=${br.toFixed(5)}:contrast=${contrast.toFixed(5)}:saturation=${saturation.toFixed(5)}`);

  const hueRotation = toUnit(-value.hue, 180);
  if (Math.abs(hueRotation) > 1e-5) {
    const h = hueRotation * Math.PI;
    parts.push(`hue=h=${h.toFixed(6)}`);
  }

  const blur = Math.max(0, Math.min(1, value.noiseReduction / 100));
  if (blur > 1e-4) {
    parts.push(`gblur=sigma=${(blur * 3).toFixed(4)}`);
  }

  if (value.grain > 0.5) {
    const n = Math.min(100, Math.round(4 + value.grain * 0.5));
    parts.push(`noise=alls=${n}:allf=t+u`);
  }

  if (value.sharpness > 0.5) {
    const amt = (value.sharpness / 100) * 1.15;
    parts.push(`unsharp=5:5:${amt.toFixed(4)}:5:5:0.0`);
  }

  if (value.clarity > 0.5) {
    const amt = (value.clarity / 100) * 0.75;
    parts.push(`unsharp=7:7:${amt.toFixed(4)}:7:7:0.0`);
  }

  const tempU = toUnit(value.temperature);
  const tintU = toUnit(value.tint);
  if (Math.abs(tempU) > 1e-5 || Math.abs(tintU) > 1e-5) {
    const rr = 1 + tempU * 0.22 - tintU * 0.08;
    const gg = 1 + tempU * 0.06 + tintU * 0.2;
    const bb = 1 - tempU * 0.28 - tintU * 0.1;
    parts.push(`colorchannelmixer=rr=${rr.toFixed(5)}:gg=${gg.toFixed(5)}:bb=${bb.toFixed(5)}`);
  }

  const vig = toUnit(value.vignette);
  if (vig > 1e-5) {
    const angle = (Math.PI / 4) * (0.35 + vig * 0.9);
    parts.push(`vignette=angle=${angle.toFixed(6)}`);
  }

  return parts.join(',');
}

/**
 * Applies adjust sliders to a video via ffmpeg.wasm and returns a new object URL.
 * When {@link isAdjustValueNeutral} is true, returns `videoSrc` unchanged (no re-encode).
 */
export const videoAdjustWithFfmpeg = async (videoSrc: string, value: AdjustValue): Promise<string> => {
  if (!videoSrc) return '';
  if (isAdjustValueNeutral(value)) return videoSrc;

  const ffmpeg = await ensureFfmpegLoaded();
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) throw new Error(`Failed to fetch source video: ${response.status}`);
  const inputBlob = await response.blob();
  const inputName = `adjust-input-${Date.now()}.mp4`;
  const outputName = `adjust-output-${Date.now()}.mp4`;
  const vf = buildAdjustVideoFilter(value);

  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));
  try {
    const run = async (audioArgs: string[]) => {
      await withTimeout(
        ffmpeg.exec([
          '-i',
          inputName,
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          ...audioArgs,
          '-movflags',
          '+faststart',
          outputName,
        ]),
        ffmpegExecTimeoutMs,
        'Applying video adjust',
      );
    };

    try {
      await run(['-c:a', 'copy']);
    } catch {
      await run(['-c:a', 'aac', '-b:a', '128k']);
    }

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid adjust output data');
    }
    const safeBuffer = new ArrayBuffer(outputData.byteLength);
    new Uint8Array(safeBuffer).set(outputData);
    const outputBlob = new Blob([safeBuffer], { type: 'video/mp4' });
    return URL.createObjectURL(outputBlob);
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
};
