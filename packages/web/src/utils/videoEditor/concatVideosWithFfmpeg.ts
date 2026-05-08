import { fetchFile } from '@ffmpeg/util';
import { ensureFfmpegLoaded, ffmpegExecTimeoutMs, fetchMediaBlob, withTimeout } from './ffmpegWasmShared';

function extFromBlob(blob: Blob): string {
  const ty = blob.type;
  if (ty.includes('webm')) return 'webm';
  if (ty.includes('matroska') || ty.includes('mkv')) return 'mkv';
  if (ty.includes('quicktime') || ty.includes('mov')) return 'mov';
  return 'mp4';
}

/**
 * Concatenates multiple video files in order using ffmpeg.wasm (concat demuxer), same as
 * `ffmpeg -f concat -i list.txt ...`. Tries stream copy first, then re-encodes to H.264/AAC if copy fails
 * (e.g. mixed codecs or resolution).
 *
 * @param videoSrcs - Fetchable URLs (including `blob:`) in play order, left-to-right on the canvas.
 * @returns A new `blob:` object URL for the merged `.mp4` (caller may `URL.revokeObjectURL` when done).
 * @throws If fetch, ffmpeg, or demux fails.
 */
export async function concatVideosWithFfmpeg(videoSrcs: string[]): Promise<string> {
  if (videoSrcs.length === 0) {
    throw new Error('No video sources');
  }
  if (videoSrcs.length === 1) {
    const blob = await fetchMediaBlob(videoSrcs[0]!);
    return URL.createObjectURL(blob);
  }

  const ffmpeg = await ensureFfmpegLoaded();
  const ts = Date.now();
  const inputNames: string[] = [];
  let listName = '';
  let outName = '';

  try {
    for (let i = 0; i < videoSrcs.length; i += 1) {
      const blob = await fetchMediaBlob(videoSrcs[i]!);
      const name = `syn-in-${ts}-${i}.${extFromBlob(blob)}`;
      await ffmpeg.writeFile(name, await fetchFile(blob));
      inputNames.push(name);
    }

    listName = `syn-list-${ts}.txt`;
    const listBody = inputNames.map((n) => `file '${n}'`).join('\n');
    await ffmpeg.writeFile(listName, new TextEncoder().encode(listBody));

    outName = `syn-out-${ts}.mp4`;

    try {
      await withTimeout(
        ffmpeg.exec([
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listName,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outName,
        ]),
        ffmpegExecTimeoutMs,
        'Concat videos (stream copy)',
      );
    } catch {
      await withTimeout(
        ffmpeg.exec([
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listName,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          outName,
        ]),
        ffmpegExecTimeoutMs,
        'Concat videos (re-encode)',
      );
    }

    const outputData = await ffmpeg.readFile(outName);
    if (!(outputData instanceof Uint8Array) || outputData.length === 0) {
      throw new Error('ffmpeg returned empty output');
    }
    const safeBuffer = new ArrayBuffer(outputData.byteLength);
    new Uint8Array(safeBuffer).set(outputData);
    const outputBlob = new Blob([safeBuffer], { type: 'video/mp4' });
    return URL.createObjectURL(outputBlob);
  } finally {
    for (const n of inputNames) {
      await ffmpeg.deleteFile(n).catch(() => undefined);
    }
    if (listName) {
      await ffmpeg.deleteFile(listName).catch(() => undefined);
    }
    if (outName) {
      await ffmpeg.deleteFile(outName).catch(() => undefined);
    }
  }
}
