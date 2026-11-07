// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';

// 48 kHz stereo: the most bytes per second, so the fewest seconds of audio a model is paid to hear
// past the size limit (docs/TEST-MANDATE.md 2.2).
const SAMPLE_RATE = 48_000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2 * 2;

/**
 * Generate an oversized PCM WAV fixture for long-media smoke tests.
 * @param directory - The directory that receives the fixture.
 * @param normalLimitBytes - The maximum size of a non-segmented request.
 * @returns The generated audio file path.
 * @throws {Error} When ffmpeg fails or the fixture does not exceed the limit.
 */
export function createOversizedLongAudioFixture(directory: string, normalLimitBytes: number): string {
  const audioPath = join(directory, 'long-audio.wav');
  const durationSeconds = Math.floor(normalLimitBytes / PCM_BYTES_PER_SECOND) + 1;
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${String(SAMPLE_RATE)}`,
    '-t', String(durationSeconds), '-ac', '2', '-c:a', 'pcm_s16le',
    '-metadata', `comment=${randomUUID()}`,
    audioPath,
  ]);
  if (statSync(audioPath).size <= normalLimitBytes) throw new Error('The long audio fixture is not oversized.');
  return audioPath;
}

/**
 * Generate an oversized MP4 fixture for long-media smoke tests.
 * @param directory - The directory that receives the fixture.
 * @param normalLimitBytes - The maximum size of a non-segmented request.
 * @returns The generated video file path.
 * @throws {Error} When ffmpeg fails or the fixture does not exceed the limit.
 */
export function createOversizedLongVideoFixture(directory: string, normalLimitBytes: number): string {
  const videoPath = join(directory, 'long-video.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-b:v', '28M', '-minrate', '28M', '-maxrate', '28M', '-bufsize', '56M',
    '-x264-params', 'nal-hrd=cbr', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-metadata', `comment=${randomUUID()}`,
    videoPath,
  ]);
  if (statSync(videoPath).size <= normalLimitBytes) throw new Error('The long video fixture is not oversized.');
  return videoPath;
}
