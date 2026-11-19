// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the consent page and the authorization server exchange when an
 * external agent asks to connect (#1488 §5.3): the page at `/connect/:uid`
 * reads who is asking, then allows or refuses, and an authorization the
 * server cannot even start lands on `/connect/error?reason=`.
 */

/** Why an authorization never reached the consent page, as `/connect/error?reason=` carries it. */
export const OAUTH_CONSENT_ERROR_REASONS = ["client_invalid", "redirect_mismatch", "request_expired"] as const;
export type OAuthConsentErrorReason = (typeof OAUTH_CONSENT_ERROR_REASONS)[number];

/** Who is asking to connect, as `GET /oauth/interactions/:uid` answers. */
export interface OAuthInteractionView {
  clientName: string;
  /** Host of the callback the authorization would be sent to. */
  redirectHosts: string[];
  /** Whether that callback is on this machine only. */
  localhostOnly: boolean;
}

/** Where the browser goes after allowing or refusing: back through the authorization server to the agent. */
export interface OAuthInteractionResult {
  redirectTo: string;
}
