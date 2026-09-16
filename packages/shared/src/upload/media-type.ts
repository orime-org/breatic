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
 * source URL's response declares. The list below is what every gate asks: the
 * file picker offers it, the ticket endpoint judges against it, and the edge
 * judges the type it read off the stored bytes against it.
 */

/**
 * The formats a model can be given.
 *
 * Named one by one rather than by family, because the family is not the
 * question: `image/svg+xml` is an image by family and markup by content, so no
 * model reads it and every browser runs the scripts in it.
 *
 * The video entries are three of the four containers the canvas offers in its
 * file picker; `video/ogg` is left out. The image and audio entries are the
 * formats the providers publish in common; they are an inference rather than a per-model matrix, and the matrix
 * is what a later round replaces them with.
 */
const UPLOADABLE_MEDIA_TYPES = [
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
] as const;

/**
 * The same ten as a set, for the gate below to ask.
 *
 * The array is what a caller enumerates — a file picker has to name each one it
 * offers, and a wildcard there would advertise formats this gate then refuses.
 */
const UPLOADABLE: ReadonlySet<string> = new Set(UPLOADABLE_MEDIA_TYPES);

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
 * The other names one format goes by.
 *
 * An .m4a is `audio/mp4` in the registry and `audio/x-m4a` to a browser, an
 * operating system, and a reader of the stored bytes alike. Which name a
 * caller holds says nothing about the format, so every gate reads through here
 * first and they all answer the same.
 *
 * `image/apng` and `video/x-m4v` are here for the same reason from the other
 * direction: an animated PNG is a PNG carrying one extra chunk, and an `M4V `
 * brand is the ISO-BMFF container `video/mp4` names under the four bytes
 * Apple's exporters write. Both are names only a reader of the bytes produces,
 * so they exist on the side the gates are asked from and nowhere else.
 *
 * Every entry is a spelling something on the way here answers with: a reader of
 * the bytes (`image/apng`, `video/x-m4v`, `audio/x-m4a`), or a browser and an
 * operating system (`audio/mp3`, `audio/wave`, `image/x-png`). Which one says
 * it does not change what the format is.
 */
const CANONICAL: ReadonlyMap<string, string> = new Map([
  ["image/apng", "image/png"],
  ["audio/x-m4a", "audio/mp4"],
  ["audio/m4a", "audio/mp4"],
  ["audio/x-wav", "audio/wav"],
  ["audio/wave", "audio/wav"],
  ["audio/mp3", "audio/mpeg"],
  ["audio/x-mpeg", "audio/mpeg"],
  ["image/x-png", "image/png"],
  ["video/x-m4v", "video/mp4"],
  ["video/x-quicktime", "video/quicktime"],
]);

/**
 * The one name this format goes by here.
 *
 * Applied wherever a type arrives from outside and wherever one is recorded,
 * so a format is asked about and written down under a single spelling. The
 * lists below are written in these spellings and read what comes out of it.
 * @param value - A type as some caller spelled it, or as bytes read.
 * @returns The listed spelling, or the value unchanged when it is one already.
 */
export function canonicalMediaType(value: string): string {
  return CANONICAL.get(value) ?? value;
}

/**
 * What each listed type is called where a person reads it.
 *
 * A media type is not a name anybody uses for a file: `video/quicktime` is a
 * `.mov` and `audio/mpeg` is an `.mp3`. A refusal that names what we take
 * instead has to name it the way the person choosing the file would.
 *
 * Keyed on the list itself, so a type added there fails to compile until it is
 * given a name here — the sentence cannot fall behind the gate.
 */
const FORMAT_NAME: Readonly<
  Record<(typeof UPLOADABLE_MEDIA_TYPES)[number], string>
> = {
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/webp": "WebP",
  "video/mp4": "MP4",
  "video/webm": "WebM",
  "video/quicktime": "MOV",
  "audio/mpeg": "MP3",
  "audio/wav": "WAV",
  "audio/mp4": "M4A",
  "audio/webm": "WebM",
};

/**
 * The formats one medium takes, written out for a reader.
 *
 * Read by the sentences that refuse a file: knowing a format is not taken
 * leaves the person holding it with nowhere to go, and what we do take is on
 * this side of the screen already.
 * @param medium - Which of the three media the refused file was offered as.
 * @returns The names, in list order, joined for a sentence.
 */
export function uploadableFormatList(
  medium: "image" | "video" | "audio",
): string {
  return UPLOADABLE_MEDIA_TYPES.filter((type) =>
    type.startsWith(`${medium}/`),
  )
    .map((type) => FORMAT_NAME[type])
    .join(" / ");
}

/**
 * Every spelling a gate here accepts, listed names and their other names alike.
 *
 * A file picker filters by the name the operating system gives a file, which is
 * not always the name the format is listed under — an `.m4v` is announced
 * `video/x-m4v` and an `.m4a` `audio/x-m4a`. Offering only the listed spellings
 * greys out files this gate takes.
 * @returns The listed types followed by every alias that canonicalises onto one.
 */
export function uploadableSpellings(): readonly string[] {
  return [
    ...UPLOADABLE_MEDIA_TYPES,
    ...[...CANONICAL].filter(([, listed]) => UPLOADABLE.has(listed)).map(([alias]) => alias),
  ];
}

/**
 * Whether a reduced media type is one a model can be given.
 *
 * This is the gate a person meets — the file picker and the ticket endpoint
 * both ask it, so it answers what may be put on a canvas.
 * @param value - A value that has been through {@link reduceMediaType}.
 * @returns True when it is uploadable.
 */
export function isUploadableMediaType(value: string): boolean {
  return UPLOADABLE.has(canonicalMediaType(value));
}

/**
 * Whether this medium has a frame worth cutting a cover out of.
 *
 * Read by both ends of an upload and so kept in one place: the server derives
 * a cover key from it, and the ingest Worker decides from it whether the key
 * it was handed gets a frame. The lane that takes an address cannot ask on the
 * server's side at all — nobody there has seen a byte until the transfer has
 * already happened — so it names a key on every call and the Worker judges.
 *
 * Reduced here rather than by the caller, because one of those two reads a
 * type the source declared in a header, parameters and all.
 * @param contentType - A media type, reduced or as it was declared.
 * @returns True for video, which is the only medium with one today.
 */
export function hasCoverFrame(contentType: string): boolean {
  return reduceMediaType(contentType).startsWith("video/");
}
