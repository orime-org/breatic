// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The OAuth authorization server external agents sign in through (#1488
 * §5.2): oidc-provider 9.14.0, configured as the design states, plus the
 * consent steps our `/connect/:uid` page drives (§5.3) and the token
 * exchange the MCP service trades an agent's credential with (RFC 8693).
 *
 * Built on first use, after core is configured, and kept for the process.
 * The settings are read then; restart the server after editing
 * `config/mcp.yaml` or the env keys.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, {
  errors,
  type Configuration,
  type Interaction,
  type KoaContextWithOIDC,
} from "oidc-provider";
import { agentAccessService, env, getMcpConfig, isLoopbackIp, logger, type AgentCredential } from "@breatic/core";
import { reachable } from "@breatic/domain";
import { httpRequest, type AgentTokenExchangeResponse, type OAuthConsentErrorReason, type OAuthInteractionView } from "@breatic/shared";
import { authService } from "@server/modules";
import { OAuthRecordsAdapter } from "@server/modules/agent-access/oauth-adapter.js";
import { frontendOrigin } from "@server/utils/frontend-origin.js";
import { issueDownstreamToken, credentialId } from "@server/modules/agent-access/agent-token-store.js";
import { takeFromUserTotal } from "@server/modules/agent-access/downstream-rate-limit.js";

/** The MCP service's confidential client, the only one allowed the token exchange. */
export const MCP_CLIENT_ID = "breatic-mcp";

/** RFC 8693 grant type. */
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

/**
 * The one scope of the MCP service. oidc-provider refuses an authorization
 * that grants no scope (`lib/actions/authorization/interactions.js`, "no
 * scope was granted"), and MCP clients often request none, so every
 * authorization request carries it.
 */
const MCP_SCOPE = "mcp";

/** RFC 8693 token type of both the subject token and the token issued. */
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/**
 * Which error state of the consent page an oidc-provider error is.
 * @param error - The OAuth error code.
 * @returns The page's `reason`.
 */
function consentErrorReason(error: string): OAuthConsentErrorReason {
  if (error === "invalid_client") return "client_invalid";
  if (error === "invalid_redirect_uri") return "redirect_mismatch";
  return "request_expired";
}

/** Who a subject token stands for. */
interface ResolvedSubject {
  userId: string;
  credential: AgentCredential;
  connectionId: string;
  clientName: string;
  /** When the credential stops working: the earliest expiry among it and what it rests on; null never. */
  expiresAt: Date | null;
}

/**
 * The earlier of two expiries, where null never expires.
 * @param a - One expiry.
 * @param b - The other.
 * @returns The earlier one.
 */
function earlier(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  return b === null || a < b ? a : b;
}

/**
 * An expiry the library keeps in epoch seconds.
 * @param exp - Its `exp`, absent when it never expires.
 * @returns The expiry, or null.
 */
function fromEpochSeconds(exp: number | undefined): Date | null {
  return exp === undefined ? null : new Date(exp * 1000);
}

/**
 * Resolve the subject of a token exchange: a personal access token, or an
 * OAuth access token issued for the MCP service whose grant is usable and
 * whose connection row is live. The grant is read again here because a
 * refresh racing a revocation can write an access token after its grant was
 * deleted (`lib/actions/grants/refresh_token.js` reads the Grant once).
 * @param provider - The authorization server.
 * @param subject - The token presented.
 * @param now - The caller's clock.
 * @returns Who it stands for, or null when it is none of these.
 * @throws {Error} When the database cannot be read.
 */
async function resolveSubject(provider: Provider, subject: string, now: Date): Promise<ResolvedSubject | null> {
  const pat = await agentAccessService.findPersonalAccessToken(subject, now);
  if (pat) {
    const [named] = await agentAccessService.connectionNames([pat.connectionId]);
    return {
      userId: pat.userId,
      credential: { type: "pat", tokenId: pat.tokenId },
      connectionId: pat.connectionId,
      clientName: named?.name ?? "",
      expiresAt: pat.expiresAt,
    };
  }
  const accessToken = await provider.AccessToken.find(subject);
  if (!accessToken || accessToken.isExpired || !accessToken.grantId) return null;
  if (accessToken.aud !== env.MCP_PUBLIC_URL) return null;
  const row = await agentAccessService.findUsableOAuthConnection(accessToken.grantId, now);
  if (!row || row.userId !== accessToken.accountId) return null;
  const grant = await provider.Grant.find(accessToken.grantId);
  return {
    userId: row.userId,
    credential: { type: "oauth", grantId: accessToken.grantId },
    connectionId: row.id,
    clientName: row.displayName,
    expiresAt: earlier(fromEpochSeconds(accessToken.exp), fromEpochSeconds(grant?.exp)),
  };
}

/**
 * The token exchange handler: trade the subject token for a downstream token.
 * Each usable exchange counts in the user's total (§12); past it the answer
 * is 429 with `Retry-After` and `temporarily_unavailable`.
 * @param provider - The authorization server.
 * @param ctx - The token endpoint context; the client is already authenticated.
 * @throws {errors.UnauthorizedClient} For any client but the MCP service.
 * @throws {errors.InvalidRequest} When the subject token is missing or of another type.
 * @throws {errors.InvalidGrant} When the subject token is not usable.
 */
async function exchangeToken(provider: Provider, ctx: KoaContextWithOIDC): Promise<void> {
  if (ctx.oidc.client?.clientId !== MCP_CLIENT_ID) throw new errors.UnauthorizedClient("token exchange is for the MCP service only");
  const params = ctx.oidc.params as { subject_token?: unknown; subject_token_type?: unknown } | undefined;
  if (typeof params?.subject_token !== "string" || params.subject_token_type !== ACCESS_TOKEN_TYPE) {
    throw new errors.InvalidRequest("subject_token must be an access token");
  }
  const now = new Date();
  const subject = await resolveSubject(provider, params.subject_token, now);
  if (!subject) throw new errors.InvalidGrant("subject token is not usable");
  // RFC 8693: the downstream token never outlives the credential it stands
  // for, and one that would end inside a call is not issued (§5.5).
  const { downstream_token_ttl_seconds: ttl, call_timeout_ms: callMs } = getMcpConfig();
  const lifetimeMs = Math.min(ttl * 1000, subject.expiresAt === null ? Infinity : subject.expiresAt.getTime() - now.getTime());
  if (lifetimeMs < callMs) throw new errors.InvalidGrant("subject token ends before one call could finish");
  const verdict = await takeFromUserTotal(subject.userId);
  if (!verdict.allowed) {
    logger.warn({ userId: subject.userId, connectionId: subject.connectionId }, "mcp_rate_limit_hit");
    ctx.status = 429;
    ctx.set("Retry-After", String(verdict.retryAfterSeconds));
    ctx.body = { error: "temporarily_unavailable", error_description: "too many requests; retry later" };
    return;
  }
  const lifetimeSeconds = Math.floor(lifetimeMs / 1000);
  const { expiresAt: _expiresAt, ...payload } = subject;
  const token = await issueDownstreamToken(payload, lifetimeSeconds);
  await agentAccessService.recordUse(subject.connectionId, now);
  logger.info(
    { userId: subject.userId, connectionId: subject.connectionId, credentialId: credentialId(subject.credential), credentialType: subject.credential.type },
    "mcp_token_exchanged",
  );
  const body: AgentTokenExchangeResponse = {
    access_token: token,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: "Bearer",
    expires_in: lifetimeSeconds,
    user_id: subject.userId,
    connection_id: subject.connectionId,
    credential: subject.credential,
  };
  ctx.body = body;
}

/**
 * Whether an `Authorization` header is HTTP Basic with an empty client secret.
 * @param header - The header, possibly empty.
 * @returns True for `Basic` credentials of the form `id:`.
 */
function hasEmptyBasicSecret(header: string): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header);
  if (!match?.[1]) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon !== -1 && colon === decoded.length - 1;
}

/**
 * The oidc-provider configuration (§5.2).
 * @returns The configuration.
 */
function configuration(): Configuration {
  const oauth = getMcpConfig().oauth;
  const resource = env.MCP_PUBLIC_URL;
  // Nothing we issue is a JWT verified elsewhere; a per-process key keeps the
  // library off its published development keys.
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const secret = env.MCP_CLIENT_SECRET;
  return {
    adapter: OAuthRecordsAdapter,
    jwks: { keys: [privateKey.export({ format: "jwk" })] },
    clients: secret === ""
      ? []
      : [{
        client_id: MCP_CLIENT_ID,
        client_secret: secret,
        application_type: "web",
        grant_types: [TOKEN_EXCHANGE],
        response_types: [],
        redirect_uris: [],
        token_endpoint_auth_method: "client_secret_basic",
      }],
    clientDefaults: { application_type: "native", id_token_signed_response_alg: "ES256" },
    responseTypes: ["code"],
    // A validator runs whether or not its parameter is present, and may
    // assign defaults (the `extraParams` documentation).
    extraParams: {
      scope: (ctx, value) => {
        if (!ctx.oidc.params) return;
        const requested = typeof value === "string" ? value.split(" ").filter((s) => s !== "") : [];
        ctx.oidc.params.scope = [...new Set([...requested, MCP_SCOPE])].join(" ");
      },
    },
    pkce: { required: () => true },
    routes: {
      authorization: "/oauth/auth",
      token: "/oauth/token",
      registration: "/oauth/reg",
      revocation: "/oauth/revoke",
      jwks: "/oauth/jwks",
      end_session: "/oauth/session/end",
    },
    // Our consent routes live under /api/v1/oauth/interactions and the page
    // under /connect/:uid; the interaction cookie must reach both.
    cookies: { short: { path: "/" } },
    interactions: { url: (_ctx, interaction) => `${frontendOrigin()}/connect/${interaction.uid}` },
    findAccount: async (_ctx, sub) => {
      const user = await authService.getUserById(sub);
      return user ? { accountId: user.id, claims: () => ({ sub: user.id }) } : undefined;
    },
    renderError: (ctx, out) => {
      ctx.status = 303;
      ctx.redirect(`${frontendOrigin()}/connect/error?reason=${consentErrorReason(out.error)}`);
    },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    expiresWithSession: () => false,
    revokeGrantPolicy: () => true,
    ttl: {
      AccessToken: oauth.access_token_ttl_seconds,
      RefreshToken: oauth.refresh_token_ttl_seconds,
      Grant: oauth.grant_ttl_seconds,
    },
    // CIMD documents: through our transport, keeping the library's socket-level
    // special-use address check (its `dispatcher`) and its 2.5 s signal.
    fetch: (url, options = {}) => httpRequest(String(url), options, { replaySafe: true, signal: options.signal ?? undefined }),
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        allowFetch: (_ctx, clientId) => reachable(clientId),
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_ctx, _client, oneOf) => {
          if (oneOf) return oneOf;
          throw new errors.InvalidTarget("resource indicator is required");
        },
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return { scope: MCP_SCOPE, audience: resource, accessTokenFormat: "opaque", accessTokenTTL: oauth.access_token_ttl_seconds };
        },
      },
    },
  };
}

/**
 * Build the authorization server.
 * @returns The provider.
 */
function build(): Provider {
  const provider = new Provider(env.OAUTH_ISSUER, configuration());
  provider.proxy = true;
  if (env.MCP_CLIENT_SECRET !== "") {
    provider.registerGrantType(TOKEN_EXCHANGE, (ctx) => exchangeToken(provider, ctx), ["subject_token", "subject_token_type"]);
  }
  // RFC 6749 §5.2, where the library answers invalid_request instead
  // (`lib/shared/client_auth.js`, `lib/actions/token.js`): HTTP Basic with an
  // empty secret is a failed client authentication, invalid_client and 401;
  // a client not allowed the token exchange gets unauthorized_client.
  provider.use(async (ctx, next) => {
    if (hasEmptyBasicSecret(ctx.get("authorization"))) {
      ctx.status = 401;
      ctx.set("WWW-Authenticate", `Basic realm="${provider.issuer}"`);
      ctx.body = { error: "invalid_client", error_description: "client authentication failed" };
      return;
    }
    await next();
    const { oidc } = ctx as KoaContextWithOIDC;
    if (
      oidc?.route === "token"
      && ctx.status === 400
      && (oidc.params as { grant_type?: unknown } | undefined)?.grant_type === TOKEN_EXCHANGE
      && oidc.client !== undefined
      && oidc.client.clientId !== MCP_CLIENT_ID
    ) {
      ctx.body = { error: "unauthorized_client", error_description: "token exchange is for the MCP service only" };
    }
  });
  provider.on("server_error", (ctx: KoaContextWithOIDC, err: Error) => {
    logger.error({ err, ctx: { route: ctx.oidc?.route, path: ctx.path } }, "oauth_server_error");
  });
  return provider;
}

let instance: { provider: Provider; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> } | undefined;

/**
 * The authorization server, built on first use.
 * @returns The provider and its Node request handler.
 */
function server(): NonNullable<typeof instance> {
  if (!instance) {
    const provider = build();
    const callback = provider.callback();
    instance = { provider, handle: async (req, res) => { await callback(req, res); } };
  }
  return instance;
}

/**
 * Hand a request to the authorization server, which writes the response.
 * @param req - Node's request.
 * @param res - Node's response.
 * @throws {Error} Never for a request the server answers; only if its handler fails outright.
 */
export async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await server().handle(req, res);
}

/**
 * The interaction this browser holds, if it is the one named.
 * @param req - Node's request, carrying the interaction cookie.
 * @param res - Node's response.
 * @param uid - The uid in the consent page's address.
 * @returns The interaction, or null when the browser holds none, it expired or it is another one.
 * @throws {Error} When the database cannot be read.
 */
async function heldInteraction(req: IncomingMessage, res: ServerResponse, uid: string): Promise<Interaction | null> {
  try {
    const interaction = await server().provider.interactionDetails(req, res);
    return interaction.uid === uid ? interaction : null;
  } catch (err) {
    if (err instanceof errors.SessionNotFound) return null;
    throw err;
  }
}

/**
 * The host of a callback address, without IPv6 brackets.
 * @param uri - The callback.
 * @returns Its host.
 */
function hostOf(uri: string): string {
  return new URL(uri).hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * What the consent page shows for an interaction.
 * @param req - Node's request.
 * @param res - Node's response.
 * @param uid - The interaction.
 * @returns The view, or null when the interaction is not this browser's or expired.
 * @throws {Error} When the database cannot be read.
 */
export async function interactionView(req: IncomingMessage, res: ServerResponse, uid: string): Promise<OAuthInteractionView | null> {
  const interaction = await heldInteraction(req, res, uid);
  if (!interaction) return null;
  const client = await server().provider.Client.find(String(interaction.params.client_id));
  if (!client) return null;
  const hosts = [hostOf(String(interaction.params.redirect_uri))];
  return { clientName: client.clientName ?? client.clientId, redirectHosts: hosts, localhostOnly: hosts.every(isLoopbackIp) };
}

/**
 * Make the authorization server's own browser session follow the user our
 * session cookie says is signed in. When this browser authorized as someone
 * else before, that session still names them, and the library's resume would
 * answer with its logout form (`lib/actions/authorization/resume.js`). The
 * old session is ended and the interaction unbound from it, so the resume
 * starts a fresh session and logs the signed-in user in; tokens never expire
 * with a session (`expiresWithSession` is false), so the other account's
 * connections are untouched.
 * @param provider - The authorization server.
 * @param interaction - The interaction being confirmed.
 * @param userId - The signed-in user.
 * @throws {Error} When the database cannot be written.
 */
async function followSignedInUser(provider: Provider, interaction: Interaction, userId: string): Promise<void> {
  const previous = interaction.session;
  if (!previous?.accountId || previous.accountId === userId) return;
  interaction.session = undefined;
  await interaction.save(interaction.exp - Math.floor(Date.now() / 1000));
  const session = previous.uid ? await provider.Session.findByUid(previous.uid) : undefined;
  await session?.destroy();
}

/** What the user allowing an agent did. */
export interface ConfirmedInteraction {
  /** Where the browser goes next; the authorization server sends it back to the agent. */
  redirectTo: string;
  clientId: string;
  connectionId: string;
}

/**
 * The user allows the agent: log in and grant the requested resource as the
 * signed-in user, and find or make the agent's connection row, so the same
 * user authorizing the same client again returns to the same row (§5.6).
 * Each authorization is a grant of its own.
 * @param req - Node's request.
 * @param res - Node's response.
 * @param uid - The interaction.
 * @param userId - The signed-in user.
 * @returns Where the browser goes next, or null when the interaction is not this browser's or expired.
 * @throws {Error} When the database cannot be written.
 */
export async function confirmInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  uid: string,
  userId: string,
): Promise<ConfirmedInteraction | null> {
  const interaction = await heldInteraction(req, res, uid);
  if (!interaction) return null;
  const { provider } = server();
  await followSignedInUser(provider, interaction, userId);
  const clientId = String(interaction.params.client_id);
  const client = await provider.Client.find(clientId);
  if (!client) return null;
  const grant = new provider.Grant({ accountId: userId, clientId });
  const scope = String(interaction.params.scope);
  grant.addOIDCScope(scope);
  grant.addResourceScope(String(interaction.params.resource), scope);
  const grantId = await grant.save();
  const redirectTo = await provider.interactionResult(
    req,
    res,
    { login: { accountId: userId }, consent: { grantId } },
    { mergeWithLastSubmission: false },
  );
  const isMetadataDocument = (client as { clientIdMetadataDocument?: boolean }).clientIdMetadataDocument === true;
  const row = await agentAccessService.ensureOAuthConnection({
    userId,
    kind: isMetadataDocument ? "cimd" : "dcr",
    clientKey: clientId,
    displayName: client.clientName ?? clientId,
  });
  return { redirectTo, clientId, connectionId: row.id };
}

/**
 * The user refuses: the agent is sent back `access_denied`.
 * @param req - Node's request.
 * @param res - Node's response.
 * @param uid - The interaction.
 * @returns Where the browser goes next, or null when the interaction is not this browser's or expired.
 * @throws {Error} When the database cannot be written.
 */
export async function abortInteraction(req: IncomingMessage, res: ServerResponse, uid: string): Promise<string | null> {
  if (!(await heldInteraction(req, res, uid))) return null;
  return server().provider.interactionResult(
    req,
    res,
    { error: "access_denied", error_description: "End-User aborted interaction" },
    { mergeWithLastSubmission: false },
  );
}
