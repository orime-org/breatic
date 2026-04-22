import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export type VideoCropRect = { x: number; y: number; w: number; h: number };

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

const toSourceCrop = (rect: VideoCropRect, containerWidth: number, containerHeight: number) => {
  const cw = Math.max(1, containerWidth);
  const ch = Math.max(1, containerHeight);

  const xPct = rect.x / cw;
  const yPct = rect.y / ch;
  const wPct = rect.w / cw;
  const hPct = rect.h / ch;

  return { xPct, yPct, wPct, hPct };
};

export const videoCropWithFfmpeg = async (
  videoSrc: string,
  rect: VideoCropRect,
  container: { width: number; height: number },
): Promise<string> => {
  if (!videoSrc) return '';

  const ffmpeg = await ensureFfmpegLoaded();
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) throw new Error(`Failed to fetch source video: ${response.status}`);
  const inputBlob = await response.blob();
  const inputName = `crop-input-${Date.now()}.mp4`;
  const outputName = `crop-output-${Date.now()}.mp4`;

  const pct = toSourceCrop(rect, container.width, container.height);
  // Convert from node-space percentage to source-space pixels in ffmpeg expression.
  const cropExpr = [
    `x='trunc(iw*${pct.xPct.toFixed(8)}/2)*2'`,
    `y='trunc(ih*${pct.yPct.toFixed(8)}/2)*2'`,
    `w='trunc(iw*${pct.wPct.toFixed(8)}/2)*2'`,
    `h='trunc(ih*${pct.hPct.toFixed(8)}/2)*2'`,
  ].join(':');

  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));
  try {
    const run = async (audioArgs: string[]) => {
      await withTimeout(
        ffmpeg.exec([
          '-i',
          inputName,
          '-vf',
          `crop=${cropExpr}`,
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
        'Cropping video',
      );
    };

    try {
      await run(['-c:a', 'copy']);
    } catch {
      await run(['-c:a', 'aac', '-b:a', '128k']);
    }

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid crop output data');
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

