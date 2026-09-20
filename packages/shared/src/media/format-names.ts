// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a reader calls a media format, and how several of them read as one
 * phrase.
 *
 * Two gates refuse a file and name a format while doing it: the upload gate,
 * which says what it would have taken, and the reading gate, which says what
 * it was handed. Their sentences can sit one node apart in the same list, so
 * a format both of them know is named by the same word — which holds only
 * while one table says what that word is.
 */

/**
 * The word each media type goes by on screen.
 *
 * A media type is not a name anybody uses for a file: `video/quicktime` is a
 * `.mov` and `audio/mpeg` is an `.mp3`. Keyed on the whole type rather than
 * its subtype, because one subtype is two formats depending on the medium —
 * `audio/mp4` is an M4A and `video/mp4` an MP4.
 *
 * Ten of these are what an upload takes; `image/gif` and `video/mpeg` are
 * read but not uploaded, and are here because a reading can be handed one by
 * address.
 */
export const FORMAT_SPELLING = {
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "video/mp4": "MP4",
  "video/mpeg": "MPEG",
  "video/webm": "WebM",
  "video/quicktime": "MOV",
  "audio/mpeg": "MP3",
  "audio/wav": "WAV",
  "audio/mp4": "M4A",
  "audio/webm": "WebM",
} as const satisfies Readonly<Record<string, string>>;

/** A media type this product has a word for. */
export type NamedMediaType = keyof typeof FORMAT_SPELLING;

/**
 * What to call the format a file is in, for a sentence naming it.
 *
 * Falls back to the subtype in capitals for everything the table does not
 * name, which is most of what a refusal is handed: the types here are the
 * ones we take, and a refused file is by definition not one of them. A
 * registry prefix comes off first — an .avi arrives as `video/x-msvideo` and
 * a .wmv as `video/x-ms-wmv`, and neither prefix is part of what anybody
 * calls the file.
 * @param mediaType - The type the file was settled as, canonical or not.
 * @returns The word, or null when there is no type to name.
 */
export function formatNameOf(
  mediaType: string | undefined | null,
): string | null {
  if (mediaType === undefined || mediaType === null) return null;
  const listed = (FORMAT_SPELLING as Readonly<Record<string, string>>)[
    mediaType
  ];
  if (listed !== undefined) return listed;
  const subtype = mediaType.split("/")[1]?.trim();
  if (subtype === undefined || subtype === "") return null;
  return subtype.replace(/^(?:x-|vnd\.)/, "").toUpperCase();
}

/**
 * Several format names as one phrase, for a sentence that names them.
 *
 * Joined with a separator rather than a word: a phrase strung together with
 * an English "and" reads as a mistake inside the four other languages this
 * product ships.
 * @param names - The format names.
 * @returns The phrase, e.g. `MP3 / WAV`.
 */
export function formatPhrase(names: readonly string[]): string {
  return names.join(" / ");
}
