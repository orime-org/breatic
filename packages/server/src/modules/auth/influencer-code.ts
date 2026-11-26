// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { influencerRepo } from "@breatic/core";

/** The code of accounts that signed up on the official site. */
export const OFFICIAL_INFLUENCER = "official";

/**
 * The influencer a new account is recorded under (inner#2157 design 7.2): the
 * enabled influencer registered on the sign-up request's `Origin` host, or
 * `official` for any other origin, a disabled influencer or no origin.
 * @param origin - The sign-up request's `Origin` header value.
 * @returns The influencer code.
 * @throws {Error} When the influencer table cannot be read.
 */
export async function influencerCodeFor(origin?: string): Promise<string> {
  if (!origin) return OFFICIAL_INFLUENCER;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return OFFICIAL_INFLUENCER;
  }
  if (host === "") return OFFICIAL_INFLUENCER;
  const found = await influencerRepo.findByHost(host);
  return found?.enabled ? found.code : OFFICIAL_INFLUENCER;
}
