// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The token that names one waiting-for-an-answer request in its landing URL.
 *
 * Every request row owns one, minted where the row is created, so the link in
 * an email stays valid for exactly as long as the request exists — what runs
 * out is the request, not the URL. Both channels that can reach a request carry
 * the same token: the email and the bell entry.
 *
 * It is a signpost, not a credential. Opening the landing page still requires
 * being signed in, and deciding still requires being the person the request is
 * addressed to — holding a token gets a stranger as far as reading one
 * sentence about an invitation they cannot act on.
 */

import { randomBytes } from "node:crypto";
import { env } from "@core/config/env.js";
import { isGlobalRegion } from "@core/region/placement.js";

/** The column width every request table stores tokens in. */
const TOKEN_WIDTH = 64;

/**
 * Mints a fresh share token.
 *
 * Every request table stores this in a `varchar(64)` column with a unique
 * index, so the token never exceeds 64 characters. A region that does not
 * hold the global data names itself first (`sg.` and the random part,
 * inner#1955), so a link opened anywhere is answered by the region the request
 * lives in; the global region's tokens carry no prefix, as before.
 * @returns At most 64 characters: the optional region prefix, then lowercase hex.
 */
export function mintShareToken(): string {
  const prefix = isGlobalRegion(env) ? "" : `${env.REGION}.`;
  return prefix + randomBytes(Math.floor((TOKEN_WIDTH - prefix.length) / 2)).toString("hex");
}

/**
 * The region a share token names, read from its prefix.
 * @param token - The token.
 * @returns The region code, or null for a token the global region issued.
 */
export function regionOfShareToken(token: string): string | null {
  const dot = token.indexOf(".");
  return dot > 0 ? token.slice(0, dot) : null;
}
