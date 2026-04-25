import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

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

const clampCropPct = (cropPct: number) => Math.max(0, Math.min(14, cropPct));

const buildCropFilter = (cropPct: number): string => {
  const p = clampCropPct(cropPct) / 100;
  // Keep equal-ratio crop with symmetric margins and even dimensions for x264.
  return `crop=trunc(iw*(1-2*${p})/2)*2:trunc(ih*(1-2*${p})/2)*2:trunc(iw*${p}/2)*2:trunc(ih*${p}/2)*2,setsar=1`;
};

export const videoStabilizationWithFfmpeg = async (videoSrc: string, cropPct: number): Promise<string> => {
  const normalizedCrop = clampCropPct(cropPct);
  if (!videoSrc) return '';
  if (normalizedCrop <= 0) return videoSrc;

  const ffmpeg = await ensureFfmpegLoaded();
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) throw new Error(`Failed to fetch source video: ${response.status}`);
  const inputBlob = await response.blob();
  const inputName = `stabilization-input-${Date.now()}.mp4`;
  const outputName = `stabilization-output-${Date.now()}.mp4`;
  const vf = buildCropFilter(normalizedCrop);

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
        'Applying stabilization crop',
      );
    };

    try {
      await run(['-c:a', 'copy']);
    } catch {
      await run(['-c:a', 'aac', '-b:a', '128k']);
    }

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid stabilization output data');
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
