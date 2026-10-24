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

import { UNDERSTAND_MODEL, type AudioFormat, type VideoFormat } from "@breatic/shared";

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
 * The tables saying which media this endpoint takes, re-exported.
 *
 * They live in `@breatic/shared` because the canvas asks the same question in
 * the browser, which cannot reach this package. One statement, two readers.
 */
export {
  AUDIO_FORMAT_NAMES,
  IMAGE_TYPES,
  IMAGE_FORMAT_NAMES,
  VIDEO_FORMAT_NAMES,
  audioFormatOf,
  videoFormatOf,
} from "@breatic/shared";
export type { AudioFormat, VideoFormat } from "@breatic/shared";

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
  /** One-based position in a batch, when an item could not be read. */
  itemIndex?: number;
  /** The source address of that batch item. */
  url?: string;
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
  /** One-based position in a batch, when known. */
  readonly itemIndex?: number;
  /** The source address of the failed item, when known. */
  readonly url?: string;
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
    super(`${about.itemIndex === undefined ? "" : `Item ${String(about.itemIndex)} (${about.url ?? "unknown address"}): `}media unavailable (${kind})`);
    this.name = "MediaUnavailable";
    this.kind = kind;
    this.status = about.status;
    this.detail = about.detail;
    this.declaredType = about.declaredType;
    this.bytes = about.bytes;
    this.limit = about.limit;
    this.itemIndex = about.itemIndex;
    this.url = about.url;
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
  /** The media request was refused; service facts determine what failed. */
  | "media"
  /** About the address we handed over: the backend could not fetch it. */
  | "unfetchable"
  /** About this deployment: the account, the credential, the model asked for. */
  | "deployment"
  /** About the moment: a second attempt could answer differently. */
  | "transient"
  /** About the question: the model declined it, and rewording can clear it. */
  | "content-filter";

/** How a batch travels, without attributing an inline failure to an image URL. */
export type MediaTransport = "address" | "inline" | "mixed";

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
  /** Whether all media are addresses, all are inline, or the request mixes both. */
  transport: MediaTransport;
}

/**
 * The service would not answer this call.
 *
 * Carries a status even when that status is 200: this endpoint answers 200
 * with an `error` object in the body, which is a refusal wearing a success
 * code. Measured (inner#856, 2026-10-22): a content block came back 200 with
 * `error: {code: 403, message: "SAFETY", metadata: {error_type:
 * "content_policy_violation"}}`, once in three sends of the same audio.
 */
export class UnderstandRefused extends Error {
  /** The status this refusal was judged by. */
  readonly status: number;
  /** The words it is stated in: the service's, or ours when the body said nothing. */
  readonly detail: string;
  /** What the refusal is about. */
  readonly kind: RefusalKind;
  /**
   * The service's own name for the failure (`metadata.error_type`), when its
   * envelope gave one. Reported as it came: the same 403 is a key, a budget
   * or a content block, and only this tells them apart.
   */
  readonly errorType: string | undefined;

  /**
   * Build one.
   * @param status - The status this refusal was judged by.
   * @param detail - The words it is stated in, the service's or ours.
   * @param kind - What the refusal is about.
   * @param errorType - The service's own name for the failure, when it gave one.
   */
  constructor(status: number, detail: string, kind: RefusalKind, errorType?: string) {
    super(`understand refused (${status}, ${kind}): ${detail}`);
    this.name = "UnderstandRefused";
    this.status = status;
    this.detail = detail;
    this.kind = kind;
    this.errorType = errorType;
  }
}

/** What one understanding call needs to know. */
export interface UnderstandRequest {
  /** The media to look at, listen to, or watch. */
  media: readonly Media[];
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
  /**
   * Called once when the service has billed the call: with what its body
   * says the call cost, or with undefined when a success answer carried no
   * figure or could not be read. Not called for a refusal status whose body
   * states no cost, nor for a call that never got an answer.
   */
  onBilled: (costUsd: number | undefined) => void;
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
  /** Remaining total AV download allowance; images retain their own limit. */
  remainingDownloadBytes?: number;
  /** How long one delivery may take, up to the response headers. */
  fetchTimeoutMs: number;
  /** The rate a body is expected to arrive at, which sets the read budget. */
  minBytesPerSec: number;
  /** The smallest read budget, for a file too small for the rate to matter. */
  readFloorMs: number;
  /**
   * What this file already turned out to be, judged off its landed bytes.
   *
   * Our own storage answers with the type a ticket signed, which was guessed
   * from a file name; a caller holding the ledger's judgement is holding the
   * better answer, and the gate that let the run start used that one. Absent
   * for a caller that has no such record — an address off the open web.
   */
  ledgerType?: string;
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
export type UnderstandAt = Omit<FetchMediaRequest, "url" | "ledgerType" | "remainingDownloadBytes"> &
  Omit<UnderstandRequest, "media"> & {
    /** Ordered source addresses, each carrying its own optional ledger type. */
    items: ReadonlyArray<Pick<FetchMediaRequest, "url" | "ledgerType">>;
  };

/**
 * Who answers a reading, pinned.
 *
 * The reader is not choosing a model — they pressed Understand, or an agent
 * called the tool — and one model covers all three media (user 2026-09-19).
 * The agent tool, the canvas route and the worker all read these, so a change
 * reaches every lane at once.
 *
 * Fixed here rather than configured: they are what every measurement behind
 * this capability was taken against. The backend matters on its own — the two
 * that serve this model take different body sizes, and leaving the choice to
 * the deployment means a clip that worked yesterday is refused today.
 */
export const UNDERSTAND_PINS = {
  model: UNDERSTAND_MODEL.id,
  backend: "google-vertex",
  baseUrl: "https://openrouter.ai/api/v1",
} as const;
