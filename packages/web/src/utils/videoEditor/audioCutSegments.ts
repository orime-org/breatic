import { cutAudioWithFfmpeg } from './audioCutWithFfmpeg';
import { cutAudioWithWebAudio } from './audioCutWebAudio';
import type { VideoCutSegment } from './videoCutWithFfmpeg';

/**
 * Browser-side audio trim: prefers {@link cutAudioWithWebAudio} (decode → slice → WAV),
 * which matches what Chrome/Safari/Firefox can decode and avoids ffmpeg.wasm codec edge cases.
 * Falls back to ffmpeg.wasm if Web Audio decoding fails.
 *
 * @returns Object URLs for each segment in order.
 */
export async function cutAudioSegments(audioSrc: string, segments: VideoCutSegment[]): Promise<string[]> {
  const empty = !audioSrc || !segments?.length;
  if (empty) return [];

  try {
    const web = await cutAudioWithWebAudio(audioSrc, segments);
    if (web.length > 0) return web;
  } catch {
    // Fall through to ffmpeg
  }

  try {
    return await cutAudioWithFfmpeg(audioSrc, segments);
  } catch {
    throw new Error('cutAudioSegments: web audio and ffmpeg both failed');
  }
}
