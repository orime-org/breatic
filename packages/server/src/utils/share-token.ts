// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The token that names one waiting-for-an-answer request in its landing URL.
 *
 * Every request row owns one, minted where the row is created, so the link in
 * an email stays valid for exactly as long as the request exists — what runs
 * out is the request, not the URL. All three channels that can reach a request
 * carry the same token: the email, the bell entry, and (for a project invite)
 * the owner's copyable share link.
 *
 * It is a signpost, not a credential. Opening the landing page still requires
 * being signed in, and deciding still requires being the person the request is
 * addressed to — holding a token gets a stranger as far as reading one
 * sentence about an invitation they cannot act on.
 */

import { randomBytes } from "node:crypto";

/** Bytes of entropy per token; 32 bytes render as 64 hex characters. */
const TOKEN_BYTES = 32;

/**
 * Mints a fresh share token.
 *
 * Every request table stores this in a `varchar(64)` column with a unique
 * index, so the width here and the width there have to agree: 32 bytes is
 * exactly 64 hex characters.
 * @returns A 64-character lowercase hex string.
 */
export function mintShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}
