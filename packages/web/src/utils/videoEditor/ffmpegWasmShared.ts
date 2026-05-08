import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export const ffmpegCoreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
export const ffmpegLoadTimeoutMs = 30000;
export const ffmpegFetchTimeoutMs = 30000;
export const ffmpegExecTimeoutMs = 120000;

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
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

/**
 * Singleton ffmpeg.wasm instance shared by local canvas video/audio editors.
 */
export const ensureFfmpegLoaded = async (): Promise<FFmpeg> => {
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
        'Loading ffmpeg core wasm binary',
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

export const fetchMediaBlob = async (mediaSrc: string): Promise<Blob> => {
  const response = await withTimeout(fetch(mediaSrc), ffmpegFetchTimeoutMs, 'Fetching source media');
  if (!response.ok) {
    throw new Error(`Failed to fetch source media: ${response.status}`);
  }
  return response.blob();
};
