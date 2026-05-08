import { fetchFile } from '@ffmpeg/util';
import { ensureFfmpegLoaded, ffmpegExecTimeoutMs, fetchMediaBlob, withTimeout } from './ffmpegWasmShared';

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
 * Changes audio playback speed and returns a playable object URL (AAC `.m4a`).
 */
export const speedAudioWithFfmpeg = async (audioSrc: string, speed: number): Promise<string> => {
  const normalizedSpeed = Math.min(2, Math.max(0.5, speed));
  if (!audioSrc) return '';
  if (Math.abs(normalizedSpeed - 1) <= 1e-6) return audioSrc;

  const ffmpeg = await ensureFfmpegLoaded();
  const inputBlob = await fetchMediaBlob(audioSrc);
  const inputName = `audio-speed-in-${Date.now()}${inputSuffixFromBlob(inputBlob)}`;
  const outputName = `audio-speed-out-${Date.now()}.m4a`;
  const atempo = toAtempoFilter(normalizedSpeed);

  await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));
  try {
    await withTimeout(
      ffmpeg.exec([
        '-i',
        inputName,
        '-vn',
        '-filter:a',
        atempo,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        outputName,
      ]),
      ffmpegExecTimeoutMs,
      'Changing audio speed',
    );

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('ffmpeg returned invalid audio speed output');
    }
    const safeBuffer = new ArrayBuffer(outputData.byteLength);
    new Uint8Array(safeBuffer).set(outputData);
    const outputBlob = new Blob([safeBuffer], { type: 'audio/mp4' });
    return URL.createObjectURL(outputBlob);
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
};
