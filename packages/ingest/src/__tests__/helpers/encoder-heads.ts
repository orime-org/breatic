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
 */

/** First 64 bytes of a file ffmpeg wrote, base64, keyed by what it reads as. */
const HEADS: Record<string, string> = {
  "video/mp4":
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAABCNtZGF0AAACrgYF//+q3EXpvebZSA==",
  "image/png":
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKUlEQVR4nA==",
  "audio/mpeg":
    "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/+0DAAAAAAAAAAAAAAAAAAAAAAA==",
};

/**
 * The leading bytes of a real file of this kind.
 * @param sample - Which sample, named by the type it reads as.
 * @returns Its leading bytes.
 */
export function head(sample: string): Uint8Array {
  return Uint8Array.from(atob(HEADS[sample]!), (c) => c.charCodeAt(0));
}
