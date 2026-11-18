// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trading an agent's token for a downstream token (breatic#1488 §5.2). The
 * MCP service never passes the agent's token on (MCP Authorization, "Access
 * Token Privilege Restriction"); it exchanges it at the server's token
 * endpoint as the confidential client `breatic-mcp` (RFC 8693).
 */

import { agentTokenExchangeResponseSchema, httpRequest, type AgentTokenExchangeResponse } from "@breatic/shared";

/** The confidential client the server lets exchange tokens. */
const MCP_CLIENT_ID = "breatic-mcp";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** The server refused the exchange because the user is over their rate. */
export class TokenExchangeRateLimitedError extends Error {
  /**
   * Record the wait the server asked for.
   * @param retryAfterSeconds - How long the server asks the caller to wait.
   */
  constructor(readonly retryAfterSeconds: number) {
    super(`token exchange rate limited; retry after ${String(retryAfterSeconds)}s`);
    this.name = "TokenExchangeRateLimitedError";
  }
}

/** The exchange did not finish inside the call's budget: the server is slow or keeps the user waiting. */
export class TokenExchangeUnavailableError extends Error {
  /**
   * Keep what stopped the exchange.
   * @param cause - What stopped it.
   */
  constructor(cause: unknown) {
    super("token exchange did not finish in time", { cause });
    this.name = "TokenExchangeUnavailableError";
  }
}

/** Where and how to exchange. */
export interface TokenExchangerOptions {
  /** The server's token endpoint, from its authorization server metadata. */
  tokenEndpoint: string;
  /** `MCP_CLIENT_SECRET`. */
  clientSecret: string;
  /** How long the whole exchange may take, waits for the server's `Retry-After` included: one call's budget. */
  timeoutMs: number;
}

/**
 * Build the exchange this service runs on every request it serves.
 * @param options - Where and how to exchange.
 * @returns A function that trades an agent's token, answering null when the server will not.
 */
export function createTokenExchanger(options: TokenExchangerOptions): (subjectToken: string) => Promise<AgentTokenExchangeResponse | null> {
  const basic = `Basic ${Buffer.from(`${MCP_CLIENT_ID}:${options.clientSecret}`).toString("base64")}`;
  return async (subjectToken) => {
    const budget = AbortSignal.timeout(options.timeoutMs);
    const res = await httpRequest(
      options.tokenEndpoint,
      {
        method: "POST",
        headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token: subjectToken, subject_token_type: ACCESS_TOKEN_TYPE }).toString(),
      },
      // Every exchange counts against the user's rate and issues a token. A
      // 429 is still replayed after its Retry-After (the server did nothing),
      // inside the call's budget.
      { replaySafe: false, timeoutMs: options.timeoutMs, signal: budget },
    ).catch((err: unknown) => {
      throw budget.aborted ? new TokenExchangeUnavailableError(err) : err;
    });
    if (res.status === 429) {
      await res.body?.cancel();
      const wait = Number(res.headers.get("retry-after"));
      throw new TokenExchangeRateLimitedError(Number.isFinite(wait) && wait > 0 ? wait : 1);
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 400 && (body as { error?: unknown } | null)?.error === "invalid_grant") return null;
    if (!res.ok) throw new Error(`token exchange failed with ${String(res.status)}`);
    return agentTokenExchangeResponseSchema.parse(body);
  };
}
