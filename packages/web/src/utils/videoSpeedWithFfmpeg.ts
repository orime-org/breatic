import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const ffmpegCoreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const ffmpegLoadTimeoutMs = 30000;
const ffmpegFetchTimeoutMs = 30000;
const ffmpegExecTimeoutMs = 120000;

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

const toAtempoFilter = (speed: number): string => {
  if (speed <= 0) return 'atempo=1.0';
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    factors.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(5)}`).join(',');
};

/**
 * Changes a video playback speed and returns a playable object URL.
 */
export const speedVideoWithFfmpeg = async (videoSrc: string, speed: number): Promise<string> => {
  const normalizedSpeed = Math.min(2, Math.max(0.5, speed));
  if (!videoSrc) return '';
  if (Math.abs(normalizedSpeed - 1) <= 1e-6) return videoSrc;

  const ffmpeg = await ensureFfmpegLoaded();
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) throw new Error(`Failed to fetch source video: ${response.status}`);
  const inputBlob = await response.blob();
  const inputName = `speed-input-${Date.now()}.mp4`;
  const outputName = `speed-output-${Date.now()}.mp4`;

  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));
  try {
    const videoPtsFactor = (1 / normalizedSpeed).toFixed(6);
    const atempo = toAtempoFilter(normalizedSpeed);
    try {
      await withTimeout(
        ffmpeg.exec([
          '-i',
          inputName,
          '-filter:v',
          `setpts=${videoPtsFactor}*PTS`,
          '-filter:a',
          atempo,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-movflags',
          '+faststart',
          outputName,
        ]),
        ffmpegExecTimeoutMs,
        'Changing video speed',
      );
    } catch {
      await withTimeout(
        ffmpeg.exec([
          '-i',
          inputName,
          '-filter:v',
          `setpts=${videoPtsFactor}*PTS`,
          '-an',
          '-movflags',
          '+faststart',
          outputName,
        ]),
        ffmpegExecTimeoutMs,
        'Changing video speed without audio',
      );
    }

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid speed output data');
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

