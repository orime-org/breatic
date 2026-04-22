import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export type VideoCutSegment = { start: number; end: number };

const ffmpegCoreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const ffmpegLoadTimeoutMs = 30000;
const ffmpegFetchTimeoutMs = 30000;
const ffmpegExecTimeoutMs = 120000;

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

const normalizeSegments = (segments: VideoCutSegment[]): VideoCutSegment[] => {
  const normalized: VideoCutSegment[] = [];
  for (const segment of segments) {
    const start = Number.isFinite(segment.start) ? Math.max(0, segment.start) : 0;
    const end = Number.isFinite(segment.end) ? Math.max(0, segment.end) : 0;
    if (end - start <= 1e-3) continue;
    normalized.push({ start, end });
  }
  return normalized;
};

const toFfmpegTime = (seconds: number): string => seconds.toFixed(3);

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

const readInputBlob = async (videoSrc: string): Promise<Blob> => {
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) {
    throw new Error(`Failed to fetch source video: ${response.status}`);
  }
  return response.blob();
};

/**
 * Splits a source video into independent clip files using ffmpeg.wasm.
 *
 * Returns object URLs for each clip in segment order.
 */
export const cutVideoWithFfmpeg = async (
  videoSrc: string,
  segments: VideoCutSegment[],
): Promise<string[]> => {
  const normalizedSegments = normalizeSegments(segments);
  if (!videoSrc || normalizedSegments.length === 0) return [];

  const ffmpeg = await ensureFfmpegLoaded();
  const inputBlob = await readInputBlob(videoSrc);
  const inputName = `cut-input-${Date.now()}.mp4`;
  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));

  const outputUrls: string[] = [];
  try {
    for (let index = 0; index < normalizedSegments.length; index += 1) {
      const segment = normalizedSegments[index];
      const outputName = `cut-output-${Date.now()}-${index + 1}.mp4`;
      const duration = Math.max(0.001, segment.end - segment.start);

      try {
        await withTimeout(
          ffmpeg.exec([
            '-ss',
            toFfmpegTime(segment.start),
            '-i',
            inputName,
            '-t',
            toFfmpegTime(duration),
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            outputName,
          ]),
          ffmpegExecTimeoutMs,
          `Cutting clip ${index + 1}`,
        );
      } catch {
        await withTimeout(
          ffmpeg.exec([
            '-ss',
            toFfmpegTime(segment.start),
            '-i',
            inputName,
            '-t',
            toFfmpegTime(duration),
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            outputName,
          ]),
          ffmpegExecTimeoutMs,
          `Re-encoding clip ${index + 1}`,
        );
      }

      const outputData = await ffmpeg.readFile(outputName);
      if (!(outputData instanceof Uint8Array)) {
        throw new Error('ffmpeg returned invalid clip data');
      }
      const bytes = outputData;
      const safeBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(safeBuffer).set(bytes);
      const outputBlob = new Blob([safeBuffer], { type: 'video/mp4' });
      outputUrls.push(URL.createObjectURL(outputBlob));
      await ffmpeg.deleteFile(outputName);
    }
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
  }

  return outputUrls;
};

