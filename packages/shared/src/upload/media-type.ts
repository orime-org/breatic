// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a stored object may be, and how a declared type is read.
 *
 * Everything on a canvas node is eventually handed to an AIGC model, so the
 * standard is whether a model can be given it (user 2026-09-14). A format a
 * model cannot read is a node that is going to fail later, further from the
 * thing that caused it.
 *
 * `reduceMediaType` is read by every lane an outside type arrives on — the
 * ticket endpoint for what a browser declares, the ingest Worker for what a
 * source URL's response declares. The list below is read by the lane that
 * takes an address; the browser's picker and ticket move onto it in #190,
 * which is where the frontend half of refusing a format lives.
 */

/**
 * The formats a model can be given.
 *
 * Named one by one rather than by family, because the family is not the
 * question: `image/svg+xml` is an image by family and markup by content, so no
 * model reads it and every browser runs the scripts in it.
 *
 * The video entries are the containers the canvas already offers in its file
 * picker. The image and audio entries are the formats the providers publish in
 * common; they are an inference rather than a per-model matrix, and the matrix
 * is what a later round replaces them with.
 */
const UPLOADABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/webm",
]);

/**
 * Reduce a declared media type to the one essence a gate can judge.
 *
 * Cut at a comma as well as a semicolon: a browser honours the LAST parsable
 * value when a header carries commas, so `video/mp4,text/html` is served as
 * HTML — measured in Chromium, scripts in it run. What survives here is what
 * gets signed, what R2 stores, and what a reader is eventually handed, so the
 * value the gate reads has to be the value that decides all three.
 * @param raw - The header or field as it arrived.
 * @returns The essence, lowercased and trimmed; empty when there is none.
 */
export function reduceMediaType(raw: string | null | undefined): string {
  return (raw ?? "").split(/[;,]/)[0]!.trim().toLowerCase();
}

/**
 * Whether a reduced media type is one a model can be given.
 * @param value - A value that has been through {@link reduceMediaType}.
 * @returns True when it is uploadable.
 */
export function isUploadableMediaType(value: string): boolean {
  return UPLOADABLE.has(value);
}
