import { fetchFile } from '@ffmpeg/util';
import type { VideoCutSegment } from './videoCutWithFfmpeg';
import { ensureFfmpegLoaded, ffmpegExecTimeoutMs, fetchMediaBlob, withTimeout } from './ffmpegWasmShared';

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

function inputSuffixFromBlob(blob: Blob): string {
  const t = blob.type ?? '';
  if (t.includes('wav')) return '.wav';
  if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
  if (t.includes('ogg')) return '.ogg';
  if (t.includes('webm')) return '.webm';
  if (t.includes('mp4') || t.includes('m4a')) return '.m4a';
  return '.bin';
}

/**
 * Splits a source audio file into segments using ffmpeg.wasm (AAC in `.m4a` containers).
 *
 * @returns Object URLs for each segment in order.
 */
export const cutAudioWithFfmpeg = async (
  audioSrc: string,
  segments: VideoCutSegment[],
): Promise<string[]> => {
  const normalizedSegments = normalizeSegments(segments);
  if (!audioSrc || normalizedSegments.length === 0) return [];

  const ffmpeg = await ensureFfmpegLoaded();
  const inputBlob = await fetchMediaBlob(audioSrc);
  const inputName = `audio-cut-in-${Date.now()}${inputSuffixFromBlob(inputBlob)}`;
  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));

  const outputUrls: string[] = [];
  try {
    for (let index = 0; index < normalizedSegments.length; index += 1) {
      const segment = normalizedSegments[index];
      const outputName = `audio-cut-out-${Date.now()}-${index + 1}.m4a`;
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
            '-vn',
            '-c:a',
            'copy',
            outputName,
          ]),
          ffmpegExecTimeoutMs,
          `Cutting audio clip ${index + 1} (copy)`,
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
            '-vn',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            outputName,
          ]),
          ffmpegExecTimeoutMs,
          `Cutting audio clip ${index + 1} (encode)`,
        );
      }

      const outputData = await ffmpeg.readFile(outputName);
      if (!(outputData instanceof Uint8Array)) {
        throw new Error('ffmpeg returned invalid audio clip data');
      }
      const safeBuffer = new ArrayBuffer(outputData.byteLength);
      new Uint8Array(safeBuffer).set(outputData);
      const outputBlob = new Blob([safeBuffer], { type: 'audio/mp4' });
      outputUrls.push(URL.createObjectURL(outputBlob));
      await ffmpeg.deleteFile(outputName);
    }
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
  }

  return outputUrls;
};
