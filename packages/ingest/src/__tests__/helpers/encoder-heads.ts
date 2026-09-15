// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The opening bytes of real files, for cases that have to store something a
 * reader can name (#240).
 *
 * Every finish answers with what the stored bytes are, so an upload of zeroes
 * is refused — which is correct, and which makes bytes a precondition of every
 * case here rather than the subject of a few. These are the first 64 bytes of
 * files ffmpeg 7.1.1 produced; what each reads as is pinned one layer down, in
 * `shared/src/upload/__tests__/sniff-samples.test.ts`.
 *
 * Keyed by which file it is rather than by what it reads as, because two of
 * them read as something they are not: an audio-only MP4 and an audio-only
 * WebM carry the same magic as a film in the same container, and the edge
 * tells them apart by asking the probe report, not the bytes.
 *
 * Two of them no encoder wrote, and they are here for the same reason: what a
 * ticket was signed for says nothing about what arrives under it.
 */

/** First 64 bytes of a file ffmpeg wrote, base64. */
const HEADS = {
  /** A film. Reads as `video/mp4`. */
  mp4: "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAABCNtZGF0AAACrgYF//+q3EXpvebZSA==",
  /** AAC in an MP4 with nothing to look at. Reads as `video/mp4` all the same. */
  mp4AudioOnly:
    "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAjNW1kYXTeAgBMYXZjNjEuMTkuMTAxAAJgrA==",
  /** Opus in a WebM with nothing to look at. Reads as `video/webm`. */
  webmAudioOnly:
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAACcLEU2bdLpNu4tTq4QVSalmUw==",
  /** A still. Reads as `image/png`. */
  png: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKUlEQVR4nA==",
  /** AAC in an M4A container. Reads as `audio/x-m4a`, one of `audio/mp4`'s other names. */
  m4a: "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAjNW1kYXTeAgBMYXZjNjEuMTkuMTAxAAJgrA==",
  /** A song with an ID3 tag. Reads as `audio/mpeg`. */
  mp3: "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/+0DAAAAAAAAAAAAAAAAAAAAAAA==",
  /** Markup, not media. Reads as `image/svg+xml`. */
  svg: "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=",
  /** No encoder wrote this. Reads as `application/octet-stream`. */
  nothing: "AAECAw==",
} as const;

/** Which file to open with. */
export type Sample = keyof typeof HEADS;

/**
 * The leading bytes of a real file.
 * @param sample - Which file.
 * @returns Its leading bytes.
 */
export function head(sample: Sample): Uint8Array {
  return Uint8Array.from(atob(HEADS[sample]), (c) => c.charCodeAt(0));
}
