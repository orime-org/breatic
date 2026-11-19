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

/** The longest name a connection or personal access token may carry. */
export const AGENT_CONNECTION_NAME_MAX_LENGTH = 64;

/** How long a new personal access token may last, in days; a token may also never expire. */
export const PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
/** A new token's lifetime in days; null never expires. */
export type PersonalAccessTokenExpiryDays = (typeof PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS)[number] | null;

/** One connected external agent, as `GET /agent-access/connections` lists it for the settings page. */
export interface AgentConnectionItem {
  id: string;
  /** `cimd` and `dcr` connect over OAuth; `pat` through a personal access token. */
  kind: "cimd" | "dcr" | "pat";
  displayName: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601; null when never used. */
  lastUsedAt: string | null;
  /** Expired: no usable authorization (OAuth) or the token passed its expiry. */
  status: "active" | "expired";
  /** Personal access tokens only: the first characters, for telling tokens apart. */
  tokenPrefix?: string;
  /** Personal access tokens only, ISO-8601; null never expires. */
  expiresAt?: string | null;
}

/** A new personal access token: its plaintext is in this answer and nowhere else. */
export interface CreatedPersonalAccessToken {
  token: string;
  connectionId: string;
}
