// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The MCP service's HTTP surface (breatic#1488 §5, §13): the Protected
 * Resource Metadata document (RFC 9728) at both the path-inserted and the
 * root well-known address, and the MCP address itself, stateless Streamable
 * HTTP. Every request to the MCP address presents a bearer token; the token
 * is exchanged for a downstream token before anything else runs, so a token
 * the server refuses is answered 401 with the metadata address and the client
 * starts authorization discovery from there.
 */

import type { AgentTokenExchangeResponse } from "@breatic/shared";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
  type AuthInfo,
  type McpServer,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { TokenExchangeRateLimitedError, TokenExchangeUnavailableError } from "@mcp/token-exchange.js";

/** Who one call acts as, and the token it calls the server with. */
export interface AgentCall {
  downstreamToken: string;
  userId: string;
  connectionId: string;
  credential: AgentTokenExchangeResponse["credential"];
  /** When the request arrived, epoch ms; a command's deadline counts from here. */
  startedAt: number;
}

/** What the app runs on. */
export interface McpAppOptions {
  /** `MCP_PUBLIC_URL`: the address agents connect to and the tokens' audience. */
  resourceUrl: URL;
  /** `OAUTH_ISSUER`. */
  issuer: string;
  /** Trade an agent's token; null when the server will not. */
  exchange: (token: string) => Promise<AgentTokenExchangeResponse | null>;
  /** Build the MCP server one request is served by. */
  buildServer: (call: AgentCall) => McpServer;
  /** Out-of-band errors of the MCP handler. */
  onError?: (err: Error) => void;
}

/** The key the verified call rides under in `AuthInfo.extra`. */
const CALL = "breaticCall";

/**
 * The call a verified request carries.
 * @param authInfo - What the bearer check returned.
 * @returns The call.
 * @throws {Error} When the request reached the handler without one.
 */
function callOf(authInfo: AuthInfo | undefined): AgentCall {
  const call = authInfo?.extra?.[CALL] as AgentCall | undefined;
  if (!call) throw new Error("MCP request reached the handler unauthenticated");
  return call;
}

/**
 * Build the app.
 * @param options - What it runs on.
 * @returns The Hono app serving the metadata and the MCP address.
 */
export function createMcpApp(options: McpAppOptions): Hono {
  const { resourceUrl, issuer, exchange, buildServer } = options;
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const metadata: OAuthProtectedResourceMetadata = {
    resource: resourceUrl.href,
    authorization_servers: [issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  };
  const verifier = {
    /**
     * Exchange the token; the exchange is what decides whether it is usable.
     * @param token - The agent's token.
     * @returns The verified token, carrying the call.
     * @throws {OAuthError} When the server will not trade it.
     */
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const startedAt = Date.now();
      const answer = await exchange(token);
      if (answer === null) throw new OAuthError(OAuthErrorCode.InvalidToken, "The token is not usable; authorize again");
      const call: AgentCall = {
        downstreamToken: answer.access_token,
        userId: answer.user_id,
        connectionId: answer.connection_id,
        credential: answer.credential,
        startedAt,
      };
      return {
        token,
        clientId: answer.connection_id,
        scopes: ["mcp"],
        expiresAt: Math.floor(startedAt / 1000) + answer.expires_in,
        // The server checked the audience during the exchange.
        resource: resourceUrl,
        extra: { [CALL]: call },
      };
    },
  };

  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts: [resourceUrl.hostname], allowedOrigins: [resourceUrl.hostname] });
  /**
   * Serve the Protected Resource Metadata document.
   * @returns It, as JSON.
   */
  const serveMetadata = (): Response => Response.json(metadata);
  app.get(new URL(metadataUrl).pathname, serveMetadata);
  app.get("/.well-known/oauth-protected-resource", serveMetadata);

  const handler = createMcpHandler((ctx) => buildServer(callOf(ctx.authInfo)), options.onError ? { onerror: options.onError } : {});
  app.all(resourceUrl.pathname, async (c) => {
    let authInfo: AuthInfo;
    try {
      authInfo = await verifyBearerToken(c.req.header("authorization"), { verifier, resourceMetadataUrl: metadataUrl, expectedResource: resourceUrl });
    } catch (err) {
      if (err instanceof TokenExchangeRateLimitedError) {
        return c.json({ error: "temporarily_unavailable", error_description: "too many requests; retry later" }, 429, { "Retry-After": String(err.retryAfterSeconds) });
      }
      if (err instanceof TokenExchangeUnavailableError) {
        return c.json({ error: "temporarily_unavailable", error_description: "the service is busy; retry later" }, 503);
      }
      return bearerAuthChallengeResponse(err, { resourceMetadataUrl: metadataUrl });
    }
    return handler.fetch(c.req.raw, { authInfo, parsedBody: c.get("parsedBody" as never) });
  });
  return app;
}
