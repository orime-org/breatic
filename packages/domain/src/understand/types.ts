// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What this module takes in and hands back.
 *
 * One shape carries the media in both forms it can travel: an image goes as
 * the address it lives at and the backend fetches it, while video and audio go
 * as bytes. That is not a preference — measured against the live endpoint, a
 * video url comes back 400 `Cannot fetch content` and an audio url is read as
 * base64 and fails to decode.
 */

/** Which of the three kinds an address turned out to hold. */
export type MediaKind = "image" | "video" | "audio";

/**
 * Media ready to be handed to a model, in whichever form it travels.
 *
 * Two shapes rather than one with optional halves: an image is an address and
 * the other two are bytes, and stating that here is what spares every reader
 * a check for a combination that cannot occur.
 */
export type Media =
  | {
      /** An address the backend fetches for itself. */
      kind: "image";
      /** Where it lives. */
      url: string;
    }
  | {
      /** Bytes that travel inside the request, beside a format name. */
      kind: "video";
      /** The bytes. */
      bytes: Uint8Array;
      /** What the endpoint calls this format, which is not always its type. */
      format: VideoFormat;
    }
  | {
      /** Bytes that travel inside the request, beside a format name. */
      kind: "audio";
      /** The bytes. */
      bytes: Uint8Array;
      /** What the endpoint calls this format, which is not always its subtype. */
      format: AudioFormat;
    };

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
 * The formats in one of these tables, as a phrase to put in a sentence.
 *
 * Derived so that anything telling a reader what to convert to is saying what
 * the table says: written out by hand a list goes on naming two formats the
 * day a third is added, and nothing reports it. The subtype alone, because the
 * name a format travels under here is not always one a reader could act on —
 * this endpoint calls a .mov `video/mov`, and no converter knows that type.
 *
 * These sentences are the model's, so the list reads in English whatever the
 * reader's own language is; the line the reader sees is chosen separately and
 * translated.
 * @param names - What the endpoint calls each format it takes.
 * @returns The phrase, e.g. `mp3 and wav`.
 */
function phrase(names: Iterable<string>): string {
  return new Intl.ListFormat("en", { type: "conjunction" }).format(
    [...new Set(names)].map((name) => name.split("/").pop() ?? name),
  );
}

/** The audio formats this endpoint takes, as a phrase to put in a sentence. */
export const AUDIO_FORMAT_NAMES = phrase(Object.values(AUDIO_FORMATS));

/** The image types this endpoint reads, as a phrase to put in a sentence. */
export const IMAGE_FORMAT_NAMES = phrase(IMAGE_TYPES);

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

/** The video formats this endpoint takes, as a phrase to put in a sentence. */
export const VIDEO_FORMAT_NAMES = phrase(Object.values(VIDEO_FORMATS));

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

/** Why an address could not be turned into media. */
export type UnavailableKind =
  /** Nothing came back, or what came back was a refusal. */
  | "unreachable"
  /** It came back, and it is not image, video or audio. */
  | "unsupported-type"
  /** It is larger than the caller allows. */
  | "too-large"
  /** It arrived slower than the caller's budget. */
  | "slow"
  /** It answered every request and holds no bytes. */
  | "empty";

/** What is known about why it could not be had, by kind. */
export interface UnavailableDetail {
  /** The status the far side answered with. */
  status?: number;
  /** Why it could not be had, in words: the layer underneath's, or ours. */
  detail?: string;
  /**
   * The type it was settled as, when that is what disqualified it.
   *
   * From the server when it said, and from the address's extension when it did
   * not — the reader is told what we took it for either way, and which of the
   * two said so is not a distinction they can act on.
   */
  declaredType?: string;
  /** How many bytes it is, or how many had arrived. */
  bytes?: number;
  /** The ceiling it was measured against. */
  limit?: number;
}

/** An address that could not be turned into media, and why. */
export class MediaUnavailable extends Error {
  /** Which of the five ways it failed. */
  readonly kind: UnavailableKind;
  /** The status the far side answered with. */
  readonly status?: number;
  /** Why it could not be had, in words: the layer underneath's, or ours. */
  readonly detail?: string;
  /** The type the server declared. */
  readonly declaredType?: string;
  /** How many bytes it is, or how many had arrived. */
  readonly bytes?: number;
  /** The ceiling it was measured against. */
  readonly limit?: number;

  /**
   * Build one.
   * @param kind - Which of the five ways it failed.
   * @param about - What is known about it.
   */
  constructor(kind: UnavailableKind, about: UnavailableDetail = {}) {
    super(`media unavailable (${kind})`);
    this.name = "MediaUnavailable";
    this.kind = kind;
    this.status = about.status;
    this.detail = about.detail;
    this.declaredType = about.declaredType;
    this.bytes = about.bytes;
    this.limit = about.limit;
  }
}

/**
 * What a refusal is about.
 *
 * Five, because five different things are worth saying to whoever asked, and a
 * single flag can hold at most two of them. Held as a flag, every code nobody
 * enumerated landed on one named side, and the sentence for that side said
 * something specific and false about the file: a spent credit, a credential, a
 * model id no longer served and an edge server's timeout were all reported as
 * "the service would not take this media".
 *
 * Named rather than derived downstream, for the reason `UnavailableKind` next
 * to it is: a consumer switches over these exhaustively, so a kind added
 * without a sentence of its own is a compile error rather than a sentence
 * about something else.
 */
export type RefusalKind =
  /** About the media that was sent, and the same bytes fare the same again. */
  | "media"
  /** About the address we handed over: the backend could not fetch it. */
  | "unfetchable"
  /** About this deployment: the account, the credential, the model asked for. */
  | "deployment"
  /** About the moment: a second attempt could answer differently. */
  | "transient"
  /** About the question: the model declined it, and rewording can clear it. */
  | "content-filter";

/**
 * What is known about a call the service would not answer.
 *
 * Three facts rather than a status alone, because a status alone answers the
 * wrong question in three places: the code that matters may be inside the
 * envelope while the transport says 200; a 400 means the endpoint could not
 * fetch what we named or could not take what we sent, and which one it is
 * depends on how the media travelled; and words we wrote ourselves cannot
 * support a sentence about what the caller sent.
 */
export interface RefusalFacts {
  /** The code to judge by: the envelope's own where it carries one. */
  code: number;
  /** Where the words came from. */
  source:
    /** An `error` object the service put in the body. */
    | "envelope"
    /** The body as it arrived, which is not the shape an answer takes. */
    | "body"
    /** A sentence of ours about a body that said nothing. */
    | "ours";
  /** Whether the media travelled as an address for the backend to fetch. */
  sentAsAddress: boolean;
}

/**
 * The service would not answer this call.
 *
 * Carries a status even when that status is 200: this endpoint answers 200
 * with an `error` object in the body, which is a refusal wearing a success
 * code. Measured — the same audio asked to be transcribed word for word comes
 * back 200 saying `Gemini blocked the request: SAFETY`.
 */
export class UnderstandRefused extends Error {
  /** The status this refusal was judged by. */
  readonly status: number;
  /** The words it is stated in: the service's, or ours when the body said nothing. */
  readonly detail: string;
  /** What the refusal is about. */
  readonly kind: RefusalKind;

  /**
   * Build one.
   * @param status - The status this refusal was judged by.
   * @param detail - The words it is stated in, the service's or ours.
   * @param kind - What the refusal is about.
   */
  constructor(status: number, detail: string, kind: RefusalKind) {
    super(`understand refused (${status}, ${kind}): ${detail}`);
    this.name = "UnderstandRefused";
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

/** What one understanding call needs to know. */
export interface UnderstandRequest {
  /** The media to look at, listen to, or watch. */
  media: Media;
  /** What to ask about it. */
  question: string;
  /** The model to call, named the way the service names models. */
  model: string;
  /** Which backend to pin, or undefined to let the service choose. */
  backend?: string;
  /** The credential for the service. */
  apiKey: string;
  /** Where the service lives, without a trailing slash. */
  baseUrl: string;
  /** How much the model may write. */
  maxOutputTokens: number;
  /** How long one delivery of this call may take. */
  timeoutMs: number;
  /** Whether anyone still wants the answer. */
  signal?: AbortSignal;
}

/** What one understanding call answered with. */
export interface UnderstandAnswer {
  /** What the model wrote. */
  text: string;
  /** Why it stopped writing, in the service's own vocabulary. */
  finishReason: string;
}

/** What getting one address's media needs to know. */
export interface FetchMediaRequest {
  /** The address to get. */
  url: string;
  /** The largest file this caller will take. */
  maxBytes: number;
  /** How long one delivery may take, up to the response headers. */
  fetchTimeoutMs: number;
  /** The rate a body is expected to arrive at, which sets the read budget. */
  minBytesPerSec: number;
  /** The smallest read budget, for a file too small for the rate to matter. */
  readFloorMs: number;
  /** Whether anyone still wants it. */
  signal?: AbortSignal;
}

/**
 * What one whole media understanding call needs to know.
 *
 * Both halves' inputs, less the media itself — that is what the first half
 * produces. Stated as their intersection rather than retyped, so a field added
 * to either one is reachable from here without a third declaration to keep in
 * step, and no figure can be routed to the wrong parameter on the way down.
 *
 * `timeoutMs` is the model call's, beside `fetchTimeoutMs` which is the
 * fetch's.
 */
export type UnderstandAt = FetchMediaRequest & Omit<UnderstandRequest, "media">;
