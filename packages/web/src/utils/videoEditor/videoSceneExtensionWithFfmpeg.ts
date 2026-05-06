import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export type VideoSceneExtensionFrame = { w: number; h: number; ox: number; oy: number };

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

const clampMinOne = (v: number) => Math.max(1, Math.round(v));

export const videoSceneExtensionWithFfmpeg = async (
  videoSrc: string,
  options: { frame: VideoSceneExtensionFrame; container: { width: number; height: number } },
): Promise<string> => {
  if (!videoSrc) return '';

  const cw = clampMinOne(options.container.width);
  const ch = clampMinOne(options.container.height);
  const fw = Math.max(cw, Math.round(options.frame.w));
  const fh = Math.max(ch, Math.round(options.frame.h));
  const ox = Math.min(0, Math.round(options.frame.ox));
  const oy = Math.min(0, Math.round(options.frame.oy));

  if (fw === cw && fh === ch && ox === 0 && oy === 0) return videoSrc;

  const scaleW = fw / cw;
  const scaleH = fh / ch;
  const offsetXPct = -ox / cw;
  const offsetYPct = -oy / ch;

  const outWExpr = `trunc(max(iw\\,iw*${scaleW.toFixed(8)})/2)*2`;
  const outHExpr = `trunc(max(ih\\,ih*${scaleH.toFixed(8)})/2)*2`;
  const xExpr = `trunc(max(0\\,iw*${offsetXPct.toFixed(8)})/2)*2`;
  const yExpr = `trunc(max(0\\,ih*${offsetYPct.toFixed(8)})/2)*2`;
  const vf = `pad=${outWExpr}:${outHExpr}:${xExpr}:${yExpr}:black,setsar=1`;

  const ffmpeg = await ensureFfmpegLoaded();
  const response = await withTimeout(fetch(videoSrc), ffmpegFetchTimeoutMs, 'Fetching source video');
  if (!response.ok) throw new Error(`Failed to fetch source video: ${response.status}`);
  const inputBlob = await response.blob();
  const inputName = `scene-extension-input-${Date.now()}.mp4`;
  const outputName = `scene-extension-output-${Date.now()}.mp4`;

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
          '-pix_fmt',
          'yuv420p',
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
        'Applying scene extension',
      );
    };

    try {
      await run(['-c:a', 'copy']);
    } catch {
      await run(['-c:a', 'aac', '-b:a', '128k']);
    }

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid scene extension output data');
    }
    if (outputData.byteLength < 1024) {
      throw new Error('ffmpeg returned an unexpectedly small scene extension output');
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
