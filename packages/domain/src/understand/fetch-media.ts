// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning an address into media a model can be asked about.
 */

import type { FetchMediaRequest, Media } from "@domain/understand/types.js";

/**
 * Settle what this address holds, and get it if it has to travel inline.
 * @param request - The address and the caller's limits.
 * @returns The media, ready to hand to a model.
 * @throws {MediaUnavailable} when the address yields no usable media.
 */
export async function fetchMedia(request: FetchMediaRequest): Promise<Media> {
  void request;
  return Promise.reject(new Error("not implemented"));
}
