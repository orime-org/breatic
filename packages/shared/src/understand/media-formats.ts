// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which media the understanding endpoint takes, and what it calls each one.
 *
 * Here rather than beside the module that sends them, because the canvas asks
 * the same question before it builds anything: a node whose file this endpoint
 * would refuse is answered in the browser, before a request travels and before
 * a task row exists to carry the refusal. Two copies of these tables would
 * drift, and the day they drift is the day one side accepts a file the other
 * refuses.
 */

import { formatPhrase } from "@shared/media/format-names.js";

/**
 * What the endpoint calls each audio type it takes.
 *
 * The two names on the right are the whole of what it accepts, and neither is
 * derivable from the type on the left: the same wav file is announced as
 * `audio/wav`, `audio/x-wav`, `audio/wave` or `audio/vnd.wave` depending on
 * the server. A subtype passed through reaches the service as `x-wav` and the
 * clip is refused after it has been uploaded.
 *
 * This is the only statement of which audio can be sent. Everything upstream
 * asks it rather than keeping a list of its own, so an address is refused
 * before a byte of it travels.
 */
export const AUDIO_FORMATS = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
} as const satisfies Readonly<Record<string, string>>;

/** What the endpoint calls a format it takes. */
export type AudioFormat = (typeof AUDIO_FORMATS)[keyof typeof AUDIO_FORMATS];

/**
 * The image types this endpoint reads from an address.
 *
 * Its own words, measured: an address holding anything else comes back 400
 * with "Supported formats: PNG, JPEG, WebP, GIF. For other formats, use a data
 * URL with the MIME type specified." An image travels as its address, so this
 * is a set rather than a table — there is no second name to send it under.
 */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * What a reader calls each format, keyed on the subtype these tables use.
 *
 * The same words `FORMAT_SPELLING` decides for the sentences a reader sees,
 * kept separately because the two are asked different questions. That one
 * takes a whole media type, which is what a refusal holds; `names` below
 * walks `AUDIO_FORMATS`' VALUES, which are bare subtypes (`mp3`, `wav`), and
 * a bare subtype cannot be asked of a table keyed on `audio/mpeg`. Merging
 * them would mean teaching that table to guess a medium for a subtype, and
 * `mp4` is two formats depending on which one it guessed.
 */
const READER_SPELLING: Readonly<Record<string, string>> = {
  png: "PNG",
  jpeg: "JPG",
  webp: "WebP",
  gif: "GIF",
  mp4: "MP4",
  mpeg: "MPEG",
  webm: "WebM",
  mov: "MOV",
  mp3: "MP3",
  wav: "WAV",
};

/**
 * The formats in one of these tables, as names a reader could act on.
 *
 * Derived so that anything telling a reader what to convert to is saying what
 * the table says: written out by hand a list goes on naming two formats the
 * day a third is added, and nothing reports it. The subtype alone, because the
 * name a format travels under here is not always one a reader could act on —
 * this endpoint calls a .mov `video/mov`, and no converter knows that type.
 * @param types - What the endpoint calls each format it takes.
 * @returns The names, e.g. `["MP3", "WAV"]`.
 */
function names(types: Iterable<string>): readonly string[] {
  return [...new Set(types)].map((type) => {
    const subtype = type.split("/").pop() ?? type;
    return READER_SPELLING[subtype] ?? subtype;
  });
}

/** The audio formats this endpoint takes. */
const AUDIO_FORMAT_LIST = names(Object.values(AUDIO_FORMATS));

/** The image formats this endpoint reads. */
const IMAGE_FORMAT_LIST = names(IMAGE_TYPES);

/** The audio formats this endpoint takes, as one phrase. */
export const AUDIO_FORMAT_NAMES = formatPhrase(AUDIO_FORMAT_LIST);

/** The image formats this endpoint reads, as one phrase. */
export const IMAGE_FORMAT_NAMES = formatPhrase(IMAGE_FORMAT_LIST);

/**
 * What the endpoint calls each video type it takes.
 *
 * Its own list names four, and `video/quicktime` is not among them — which is
 * exactly what a `.mov` is served as (measured against two hosts), and .mov is
 * what an iPhone records. Everything outside this table is a video the
 * endpoint refuses, and refusing it here costs nothing while a refusal after
 * the upload costs the whole clip: an .avi is served as `video/x-msvideo`
 * (measured against filesamples.com), and nginx and Apache declare
 * `video/x-ms-wmv`, `video/3gpp` and `video/ogg` out of the box.
 *
 * This is the only statement of which video can be sent, for the same reason
 * the audio table above is the only statement of its half.
 */
export const VIDEO_FORMATS = {
  "video/mp4": "video/mp4",
  "video/mpeg": "video/mpeg",
  "video/webm": "video/webm",
  "video/mov": "video/mov",
  "video/quicktime": "video/mov",
} as const satisfies Readonly<Record<string, string>>;

/** What the endpoint calls a video format it takes. */
export type VideoFormat = (typeof VIDEO_FORMATS)[keyof typeof VIDEO_FORMATS];

/** The video formats this endpoint takes. */
const VIDEO_FORMAT_LIST = names(Object.values(VIDEO_FORMATS));

/** The video formats this endpoint takes, as one phrase. */
export const VIDEO_FORMAT_NAMES = formatPhrase(VIDEO_FORMAT_LIST);

/**
 * What this endpoint calls a video type, when it takes it at all.
 * @param mediaType - The type the address was settled as.
 * @returns The format name, or undefined when this video cannot be sent.
 */
export function videoFormatOf(mediaType: string): VideoFormat | undefined {
  return (VIDEO_FORMATS as Readonly<Record<string, VideoFormat>>)[mediaType];
}

/**
 * What this endpoint calls an audio type, when it takes it at all.
 * @param mediaType - The type the address was settled as.
 * @returns The format name, or undefined when this audio cannot be sent.
 */
export function audioFormatOf(mediaType: string): AudioFormat | undefined {
  return (AUDIO_FORMATS as Readonly<Record<string, AudioFormat>>)[mediaType];
}
