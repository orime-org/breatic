import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export type HdrOutputPreset = 'hdr10' | 'hlg' | 'dolby-vision';

export type VideoHdrConversionOptions = {
  preset: HdrOutputPreset;
  intensity: number;
  aiEnhance: boolean;
  onProgress?: (progressPct: number) => void;
};

const ffmpegCoreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const ffmpegLoadTimeoutMs = 30000;
const ffmpegFetchTimeoutMs = 30000;
const ffmpegExecTimeoutMs = 600000;

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

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

const clampIntensity = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));

const buildPresetTuningArgs = (preset: HdrOutputPreset): string[] => {
  // Web playback compatibility first: keep encoded stream in Rec.709 signaling.
  // Preset stays in payload for future backend/AI pipeline routing.
  void preset;
  return ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
};

const buildTraditionalFilter = (intensity: number): string => {
  const i = clampIntensity(intensity) / 100;
  // Keep non-AI path conservative for browser decode stability.
  const saturation = (1 + i * 0.22).toFixed(4);
  const contrast = (1 + i * 0.15).toFixed(4);
  return `eq=contrast=${contrast}:saturation=${saturation},setsar=1`;
};

const buildTraditionalFallbackFilter = (intensity: number): string => {
  const i = clampIntensity(intensity) / 100;
  const saturation = (1 + i * 0.22).toFixed(4);
  const contrast = (1 + i * 0.15).toFixed(4);
  return `eq=contrast=${contrast}:saturation=${saturation},setsar=1`;
};

const buildAiEnhanceFilter = (intensity: number): string => {
  const i = clampIntensity(intensity) / 100;
  const saturation = (1 + i * 0.28).toFixed(4);
  const contrast = (1 + i * 0.2).toFixed(4);
  const sharpness = (0.18 + i * 0.9).toFixed(4);
  // Approximate inverse tone mapping with stronger contrast/color + local sharpening.
  return `eq=contrast=${contrast}:saturation=${saturation},unsharp=7:7:${sharpness}:7:7:0.0,setsar=1`;
};

export const videoHdrConversionWithFfmpeg = async (
  videoSrc: string,
  options: VideoHdrConversionOptions,
): Promise<string> => {
  if (!videoSrc) return '';

  const onProgress = options.onProgress;
  const emitProgress = (value: number) => onProgress?.(Math.max(0, Math.min(100, Math.round(value))));
  emitProgress(5);

  const ffmpeg = await ensureFfmpegLoaded();
  emitProgress(12);
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) throw new Error(`Failed to fetch source video: ${response.status}`);
  const inputBlob = await response.blob();

  const inputName = `hdr-input-${Date.now()}.mp4`;
  const outputName = `hdr-output-${Date.now()}.mp4`;
  const vf = options.aiEnhance
    ? buildAiEnhanceFilter(options.intensity)
    : buildTraditionalFilter(options.intensity);
  const fallbackVf = buildTraditionalFallbackFilter(options.intensity);
  const presetArgs = buildPresetTuningArgs(options.preset);

  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));
  emitProgress(options.aiEnhance ? 20 : 35);

  try {
    const run = async (videoFilter: string, audioArgs: string[]) => {
      await withTimeout(
        ffmpeg.exec([
          '-y',
          '-i',
          inputName,
          '-vf',
          videoFilter,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-profile:v',
          'high',
          '-level',
          '4.1',
          '-preset',
          options.aiEnhance ? 'medium' : 'veryfast',
          '-crf',
          options.aiEnhance ? '21' : '23',
          ...presetArgs,
          ...audioArgs,
          '-movflags',
          '+faststart',
          outputName,
        ]),
        ffmpegExecTimeoutMs,
        'Applying HDR conversion',
      );
    };

    try {
      await run(vf, ['-c:a', 'copy']);
    } catch (firstError) {
      if (options.aiEnhance) emitProgress(74);
      try {
        await run(vf, ['-c:a', 'aac', '-b:a', '128k']);
      } catch {
        if (!options.aiEnhance) {
          await run(fallbackVf, ['-c:a', 'aac', '-b:a', '128k']);
        } else {
          throw firstError;
        }
      }
    }

    emitProgress(options.aiEnhance ? 92 : 96);
    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid HDR output data');
    }
    if (outputData.byteLength < 1024) {
      throw new Error('ffmpeg returned an unexpectedly small HDR output');
    }
    const safeBuffer = new ArrayBuffer(outputData.byteLength);
    new Uint8Array(safeBuffer).set(outputData);
    const outputBlob = new Blob([safeBuffer], { type: 'video/mp4' });
    emitProgress(100);
    return URL.createObjectURL(outputBlob);
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
};

