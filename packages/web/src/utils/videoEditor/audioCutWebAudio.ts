import type { VideoCutSegment } from './videoCutWithFfmpeg';

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

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * PCM 16-bit little-endian WAV blob (interleaved channels).
 *
 * @param buffer - Decoded audio (any channel count / sample rate).
 */
export function encodeAudioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const samples = buffer.length;
  const bitDepth = 16;
  const blockAlign = (numChannels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch += 1) {
    channels.push(buffer.getChannelData(ch));
  }
  for (let i = 0; i < samples; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const s = Math.max(-1, Math.min(1, channels[ch][i] ?? 0));
      view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/**
 * Non-destructive trim using {@link AudioContext#decodeAudioData} + PCM WAV export.
 * Works for formats the browser can decode (typically MP3, WAV, OGG, AAC in M4A).
 *
 * @returns One object URL per segment (same order as {@link segments}).
 */
export async function cutAudioWithWebAudio(audioSrc: string, segments: VideoCutSegment[]): Promise<string[]> {
  const normalizedSegments = normalizeSegments(segments);
  if (!audioSrc || normalizedSegments.length === 0) return [];

  const res = await fetch(audioSrc);
  if (!res.ok) {
    throw new Error(`Failed to fetch audio for trim: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error('Empty audio buffer');
  }

  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) {
    throw new Error('AudioContext not available');
  }

  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    await ctx.close().catch(() => undefined);
    throw e;
  }

  const sr = decoded.sampleRate;
  const dur = decoded.duration;
  const urls: string[] = [];

  try {
    for (const segment of normalizedSegments) {
      const start = Math.min(Math.max(0, segment.start), dur);
      const end = Math.min(Math.max(start, segment.end), dur);
      if (end - start <= 1e-3) continue;

      const startSample = Math.floor(start * sr);
      const endSample = Math.floor(end * sr);
      const frameCount = Math.max(1, endSample - startSample);

      const sliced = ctx.createBuffer(decoded.numberOfChannels, frameCount, sr);

      for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
        const src = decoded.getChannelData(ch);
        const dst = sliced.getChannelData(ch);
        dst.set(src.subarray(startSample, endSample));
      }

      const wavBlob = encodeAudioBufferToWav(sliced);
      urls.push(URL.createObjectURL(wavBlob));
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  return urls;
}
