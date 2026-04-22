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

const clampIntensity = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? Math.round(value) : 50));

const buildDenoiseFilter = (intensity: number): string => {
  // Map 0..100 to afftdn noise floor range (-20..-45), stronger denoise for higher intensity.
  const normalized = clampIntensity(intensity) / 100;
  const noiseFloor = (-20 - normalized * 25).toFixed(1);
  return `afftdn=nf=${noiseFloor}:nt=w`;
};

export const videoAudioDenoiseWithFfmpeg = async (videoSrc: string, intensity: number): Promise<string> => {
  if (!videoSrc) return '';
  if (clampIntensity(intensity) <= 0) return videoSrc;

  const ffmpeg = await ensureFfmpegLoaded();
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) throw new Error(`Failed to fetch source video: ${response.status}`);
  const inputBlob = await response.blob();
  const inputName = `audio-denoise-input-${Date.now()}.mp4`;
  const outputName = `audio-denoise-output-${Date.now()}.mp4`;
  const af = buildDenoiseFilter(intensity);

  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));
  try {
    await withTimeout(
      ffmpeg.exec([
        '-i',
        inputName,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-af',
        af,
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputName,
      ]),
      ffmpegExecTimeoutMs,
      'Applying audio denoise',
    );

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid audio denoise output data');
    }
    if (outputData.byteLength < 1024) {
      throw new Error('ffmpeg returned an unexpectedly small audio denoise output');
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
