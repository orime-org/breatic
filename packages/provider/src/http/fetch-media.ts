// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Why a media address was not read. */
export type MediaRefusal = "unreachable" | "too_large" | "unavailable";

/** A media address that was refused or could not be read. */
export class MediaRefused extends Error {
  readonly kind: MediaRefusal;
  readonly status: number | undefined;

  /**
   * @param kind - Why.
   * @param status - The status code, for an address that answered with one we do not read.
   */
  constructor(kind: MediaRefusal, status?: number) {
    super(`Media refused: ${kind}`);
    this.name = "MediaRefused";
    this.kind = kind;
    this.status = status;
  }
}

/** One media read. */
export interface FetchMediaRequest {
  url: string;
  /** The largest body read, in bytes. */
  maxBytes: number;
  /** Fetching and reading end here, in epoch milliseconds. */
  deadlineAt: number;
  signal?: AbortSignal;
}

/** The bytes at an address. */
export interface FetchedMedia {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Read the bytes at a public address, judging every redirect hop before following it.
 * @param request - What to read and its limits.
 * @returns The bytes and their declared type.
 * @throws {MediaRefused} When an address is not public, the body is over the limit, or the address answers non-2xx.
 * @throws {Aborted} When the deadline or the signal ends the read.
 */
export async function fetchMedia(request: FetchMediaRequest): Promise<FetchedMedia> {
  void request;
  throw new Error("fetchMedia is not implemented");
}
