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
      /** The type it was settled as, e.g. `image/png`. */
      mediaType: string;
    }
  | {
      /** Bytes that travel inside the request. */
      kind: "video" | "audio";
      /** The bytes. */
      bytes: Uint8Array;
      /** The type it was settled as, e.g. `video/mp4`. */
      mediaType: string;
    };

/** Why an address could not be turned into media. */
export type UnavailableKind =
  /** Nothing came back, or what came back was a refusal. */
  | "unreachable"
  /** It came back, and it is not image, video or audio. */
  | "unsupported-type"
  /** It is larger than the caller allows. */
  | "too-large"
  /** It arrived slower than the caller's budget. */
  | "slow";

/** What is known about why it could not be had, by kind. */
export interface UnavailableDetail {
  /** The status the far side answered with. */
  status?: number;
  /** What the layer underneath said, for a failure with no status. */
  detail?: string;
  /** The type the server declared, when that is what disqualified it. */
  declaredType?: string;
  /** How many bytes it is, or how many had arrived. */
  bytes?: number;
  /** The ceiling it was measured against. */
  limit?: number;
}

/** An address that could not be turned into media, and why. */
export class MediaUnavailable extends Error {
  /** Which of the four ways it failed. */
  readonly kind: UnavailableKind;
  /** The status the far side answered with. */
  readonly status?: number;
  /** What the layer underneath said. */
  readonly detail?: string;
  /** The type the server declared. */
  readonly declaredType?: string;
  /** How many bytes it is, or how many had arrived. */
  readonly bytes?: number;
  /** The ceiling it was measured against. */
  readonly limit?: number;

  /**
   * Build one.
   * @param kind - Which of the four ways it failed.
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
 * The service would not answer this call.
 *
 * Carries a status even when that status is 200: this endpoint answers 200
 * with an `error` object in the body, which is a refusal wearing a success
 * code. Measured — the same audio asked to be transcribed word for word comes
 * back 200 saying `Gemini blocked the request: SAFETY`.
 */
export class UnderstandRefused extends Error {
  /** The status the answer carried. */
  readonly status: number;
  /** The service's own words. */
  readonly detail: string;

  /**
   * Build one.
   * @param status - The status the answer carried.
   * @param detail - The service's own words.
   */
  constructor(status: number, detail: string) {
    super(`understand refused (${status}): ${detail}`);
    this.name = "UnderstandRefused";
    this.status = status;
    this.detail = detail;
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
  /** What the call cost in tokens. */
  usage: { totalTokens: number };
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
  readFloorMs?: number;
  /** Whether anyone still wants it. */
  signal?: AbortSignal;
}

/** What one whole media understanding call needs to know. */
export interface UnderstandAt {
  /** The address to look at, watch or listen to. */
  url: string;
  /** What to ask about it. */
  question: string;
  /** The largest file to take. */
  maxBytes: number;
  /** How long one delivery of the fetch may take. */
  fetchTimeoutMs: number;
  /** The rate a body is expected to arrive at. */
  minBytesPerSec: number;
  /** How long one delivery of the model call may take. */
  callTimeoutMs: number;
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
  /** Whether anyone still wants the answer. */
  signal?: AbortSignal;
}
