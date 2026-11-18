// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The OAuth authorization server external agents sign in through (#1488 §5.2,
 * §5.3, §15.2), driven over real HTTP: oidc-provider runs on Node's own
 * request objects, so the app is served on a loopback port and every step is
 * a real request with manual redirects and a cookie jar that honours `Path`
 * the way a browser does.
 *
 * Covered: discovery metadata (RFC 8414 and the MCP extras), dynamic client
 * registration, the authorization code flow with PKCE S256 and a required
 * `resource` (RFC 8707), the consent API our `/connect/:uid` page calls,
 * refresh rotation with the reuse grace window, revocation (RFC 7009), and
 * the token exchange (RFC 8693) that trades an agent's access token or
 * personal access token for a downstream token. The CIMD flow with Claude
 * Code's real metadata document reaches the internet and is tagged.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  getStreamRedis,
  getMcpConfig,
  setSession,
  sessionCookieName,
  sessionsRevokedChannelName,
  loadLocales,
  agentAccessService,
  type Redis,
} from "@breatic/core";
import type { SessionsRevokedEvent } from "@breatic/shared";

const MCP_SECRET = "test-mcp-client-secret-0123456789abcdef";
const MCP_CLIENT_ID = "breatic-mcp";
/** The web origin, on another host than the API as in production. */
const WEB = "http://web.test";

/**
 * A free loopback port, so the issuer can be configured before the app exists.
 * @returns The port.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

let sql: ReturnType<typeof postgres>;
let base: string;
let resource: string;
let close: () => Promise<void>;
let subscriber: Redis;
const heard: SessionsRevokedEvent[] = [];

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  resource = `${base}/mcp`;
  initCore({ ...process.env, OAUTH_ISSUER: base, MCP_PUBLIC_URL: resource, MCP_CLIENT_SECRET: MCP_SECRET, ALLOWED_ORIGINS: WEB });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
  const { createApp } = await import("@server/app.js");
  const app = createApp();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve(s));
  });
  close = () => new Promise((resolve) => server.close(() => resolve()));
  subscriber = getStreamRedis().duplicate();
  subscriber.on("message", (_channel: string, message: string) => {
    heard.push(JSON.parse(message) as SessionsRevokedEvent);
  });
  await subscriber.subscribe(sessionsRevokedChannelName());
});

afterAll(async () => {
  await subscriber?.quit();
  await close?.();
  await sql?.end({ timeout: 1 });
});

/** A cookie as a browser keeps it. */
interface StoredCookie {
  name: string;
  value: string;
  path: string;
}

/** A browser's cookie jar for one origin: it sends a cookie only under its `Path`. */
class Jar {
  private readonly cookies = new Map<string, StoredCookie>();

  /**
   * Take the cookies a response sets.
   * @param res - The response.
   * @param requestPath - The path the request went to, for cookies without `Path`.
   */
  absorb(res: Response, requestPath: string): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const pathAttr = attrs.find((a) => a.toLowerCase().startsWith("path="));
      const path = pathAttr ? pathAttr.slice(5) : requestPath.replace(/\/[^/]*$/, "") || "/";
      const expired = attrs.some((a) => /^max-age=0$/i.test(a)) || attrs.some((a) => /^expires=thu, 01 jan 1970/i.test(a));
      const key = `${name};${path}`;
      if (expired || value === "") this.cookies.delete(key);
      else this.cookies.set(key, { name, value, path });
    }
  }

  /**
   * The Cookie header for a request path.
   * @param path - The request path.
   * @returns The header value, possibly empty.
   */
  headerFor(path: string): string {
    return [...this.cookies.values()]
      .filter((c) => path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`) || c.path === "/")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /**
   * Add a cookie by hand (the product session).
   * @param name - Cookie name.
   * @param value - Cookie value.
   */
  set(name: string, value: string): void {
    this.cookies.set(`${name};/`, { name, value, path: "/" });
  }
}

/**
 * Make a request as the browser holding `jar`, without following redirects.
 * @param jar - The browser's cookies.
 * @param url - Absolute or origin-relative URL.
 * @param init - Method, headers, body.
 * @returns The response.
 */
async function browse(jar: Jar, url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url, base);
  const headers = new Headers(init.headers);
  const cookie = jar.headerFor(target.pathname);
  if (cookie) headers.set("Cookie", cookie);
  const res = await fetch(target, { ...init, headers, redirect: "manual" });
  jar.absorb(res, target.pathname);
  return res;
}

/**
 * POST a form to the token or revocation endpoint.
 * @param path - Endpoint path.
 * @param form - Fields.
 * @param basic - Client credentials for HTTP Basic, when the client is confidential.
 * @returns The response.
 */
async function postForm(path: string, form: Record<string, string>, basic?: { id: string; secret: string }): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString("base64")}`;
  return fetch(new URL(path, base), { method: "POST", headers, body: new URLSearchParams(form) });
}

let seq = 0;

/**
 * A signed-in user.
 * @returns The user id and a browser jar holding the product session.
 */
async function seedUser(): Promise<{ userId: string; jar: Jar }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`oauth-${process.pid}-${seq++}@example.com`}, true) RETURNING id`;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const jar = new Jar();
  jar.set(sessionCookieName(), token);
  return { userId: user!.id, jar };
}

/**
 * Register a public client the way Cursor does (no `application_type`).
 * @param name - Its `client_name`.
 * @param redirectUris - Its redirect URIs.
 * @returns Its client id.
 */
async function registerClient(name = "Cursor", redirectUris = ["http://127.0.0.1/callback"]): Promise<string> {
  const res = await fetch(new URL("/oauth/reg", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** A PKCE pair. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * Open an authorization request.
 * @param jar - The browser.
 * @param params - Query parameters; client_id and redirect_uri are required.
 * @returns The response to `/oauth/auth`.
 */
async function authorize(jar: Jar, params: Record<string, string>): Promise<Response> {
  return browse(jar, `/oauth/auth?${new URLSearchParams({ response_type: "code", ...params })}`);
}

/**
 * The interaction uid the authorization endpoint sent the browser to.
 * @param res - Its 303 response.
 * @returns The uid in `/connect/:uid`.
 */
function interactionUid(res: Response): string {
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location")!, base);
  expect(location.origin).toBe(WEB);
  const match = /^\/connect\/([^/]+)$/.exec(location.pathname);
  expect(match, location.pathname).not.toBeNull();
  return match![1]!;
}

/**
 * Run the whole code flow: authorize, consent, follow the resume, exchange the code.
 * @param jar - The signed-in browser.
 * @param clientId - The public client.
 * @param redirectUri - The callback (port may differ from the registered loopback one).
 * @returns The token response.
 */
async function codeFlow(
  jar: Jar,
  clientId: string,
  redirectUri = "http://127.0.0.1:54321/callback",
): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: string }> {
  const { verifier, challenge } = pkce();
  const state = crypto.randomUUID();
  const uid = interactionUid(
    await authorize(jar, { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource, state }),
  );
  const confirm = await browse(jar, `/api/v1/oauth/interactions/${uid}/confirm`, { method: "POST" });
  expect(confirm.status).toBe(200);
  const { redirectTo } = ((await confirm.json()) as { data: { redirectTo: string } }).data;
  const resumed = await browse(jar, redirectTo);
  expect(resumed.status).toBe(303);
  const callback = new URL(resumed.headers.get("location")!);
  expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri);
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get("iss")).toBe(base);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const res = await postForm("/oauth/token", {
    grant_type: "authorization_code", code: code!, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
}

/**
 * Refresh a token.
 * @param clientId - The client.
 * @param refreshToken - The refresh token.
 * @returns The response.
 */
async function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return postForm("/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource });
}

/**
 * Trade a subject token for a downstream token as the MCP service.
 * @param subjectToken - The agent's access token or personal access token.
 * @param client - Client credentials; the MCP service's by default.
 * @returns The response.
 */
async function exchange(subjectToken: string, client = { id: MCP_CLIENT_ID, secret: MCP_SECRET }): Promise<Response> {
  return postForm(
    "/oauth/token",
    {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    },
    client,
  );
}

/**
 * Whether a downstream token gets a whitelisted route through, as its user.
 * @param token - The downstream token.
 * @param userId - Who it should act as.
 * @returns True when the route answered 200 for that user.
 */
async function downstreamWorks(token: string, userId: string): Promise<boolean> {
  const res = await fetch(new URL(`/api/v1/users?ids=${userId}`, base), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200) return false;
  return ((await res.json()) as { data: Array<{ id: string }> }).data.some((u) => u.id === userId);
}

/**
 * The live Grant ids a user holds for a client.
 * @param userId - Account.
 * @param clientId - Client.
 * @returns Grant record ids.
 */
async function grantsOf(userId: string, clientId: string): Promise<string[]> {
  const rows = await sql<{ record_id: string }[]>`
    SELECT record_id FROM oauth_records
    WHERE model = 'Grant' AND account_id = ${userId} AND client_id = ${clientId} AND deleted_at IS NULL`;
  return rows.map((r) => r.record_id);
}

/**
 * The announcements on `sessions:revoked` naming a user, once the publishes
 * in flight have arrived.
 * @param userId - The user.
 * @returns Those announcements.
 */
async function announcedFor(userId: string): Promise<SessionsRevokedEvent[]> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return heard.filter((event) => event.userId === userId);
}

/**
 * Move the expiry of a grant's records of one model to `seconds` from now,
 * in the stored payload the library reads and in the column we filter on.
 * @param grantId - The grant.
 * @param model - `Grant` or `AccessToken`.
 * @param seconds - The new lifetime from now.
 */
async function expireIn(grantId: string, model: "Grant" | "AccessToken", seconds: number): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const idColumn = model === "Grant" ? sql`record_id` : sql`grant_id`;
  await sql`
    UPDATE oauth_records SET payload = jsonb_set(payload, '{exp}', to_jsonb(${exp}::bigint)), expires_at = to_timestamp(${exp})
    WHERE model = ${model} AND ${idColumn} = ${grantId} AND deleted_at IS NULL`;
}

describe("discovery", () => {
  it("publishes RFC 8414 metadata with PKCE S256, CIMD and the iss response parameter", async () => {
    const res = await fetch(new URL("/.well-known/oauth-authorization-server", base));
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(base);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.revocation_endpoint).toBe(`${base}/oauth/revoke`);
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      expect(String(meta[key]).startsWith(`${base}/oauth/`), key).toBe(true);
    }
  });
});

describe("authorization code flow", () => {
  it("issues tokens for a dynamically registered loopback client on a random port, and records its connection", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient("Cursor");
    const tokens = await codeFlow(jar, clientId);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(getMcpConfig().oauth.access_token_ttl_seconds);
    expect(tokens.refresh_token).toBeTruthy();
    const rows = await agentAccessService.listConnections(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "dcr", displayName: "Cursor", status: "active" });
  });

  it("returns to the same connection when the same user authorizes the same client again", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    await codeFlow(jar, clientId);
    const [first] = await agentAccessService.listConnections(userId);
    await codeFlow(jar, clientId, "http://127.0.0.1:60123/callback");
    const rows = await agentAccessService.listConnections(userId);
    expect(rows.map((r) => r.id)).toEqual([first!.id]);
  });

  it("refuses a request without a PKCE challenge", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient();
    const res = await authorize(jar, { client_id: clientId, redirect_uri: "http://127.0.0.1:5000/callback", resource, state: "s" });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!, base);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses a request without a resource", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await authorize(jar, { client_id: clientId, redirect_uri: "http://127.0.0.1:5000/callback", code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!, base);
    expect(location.searchParams.get("error")).toBeTruthy();
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("sends the browser back with access_denied when the user refuses", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const uid = interactionUid(
      await authorize(jar, { client_id: clientId, redirect_uri: "http://127.0.0.1:5000/callback", code_challenge: challenge, code_challenge_method: "S256", resource, state: "s" }),
    );
    const abort = await browse(jar, `/api/v1/oauth/interactions/${uid}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
    const resumed = await browse(jar, ((await abort.json()) as { data: { redirectTo: string } }).data.redirectTo);
    const callback = new URL(resumed.headers.get("location")!);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });
});

describe("switching accounts in one browser", () => {
  it("authorizes as whoever is signed in now, leaving the previous account's connection alone", async () => {
    const first = await seedUser();
    const clientId = await registerClient("Cursor");
    await codeFlow(first.jar, clientId);
    const second = await seedUser();
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, second.userId);
    first.jar.set(sessionCookieName(), token);
    const tokens = await codeFlow(first.jar, clientId);
    expect(tokens.access_token).toBeTruthy();
    expect(await agentAccessService.listConnections(second.userId)).toHaveLength(1);
    expect(await agentAccessService.listConnections(first.userId)).toHaveLength(1);
    const res = await exchange(tokens.access_token);
    expect(await downstreamWorks(((await res.json()) as { access_token: string }).access_token, second.userId)).toBe(true);
  });
});

describe("consent API", () => {
  /**
   * Open an interaction for a client.
   * @param jar - The browser.
   * @param clientId - The client.
   * @param redirectUri - The callback.
   * @returns The interaction uid.
   */
  async function openInteraction(jar: Jar, clientId: string, redirectUri: string): Promise<string> {
    const { challenge } = pkce();
    return interactionUid(
      await authorize(jar, { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource, state: "s" }),
    );
  }

  it("names the client and the callback host, and flags a localhost-only callback", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient("Cursor");
    const uid = await openInteraction(jar, clientId, "http://127.0.0.1:5000/callback");
    const res = await browse(jar, `/api/v1/oauth/interactions/${uid}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ clientName: "Cursor", redirectHosts: ["127.0.0.1"], localhostOnly: true });
  });

  it("does not flag a client whose callback is on the web", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient("Web Agent", ["https://agent.example.com/oauth/callback"]);
    const uid = await openInteraction(jar, clientId, "https://agent.example.com/oauth/callback");
    const res = await browse(jar, `/api/v1/oauth/interactions/${uid}`);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ redirectHosts: ["agent.example.com"], localhostOnly: false });
  });

  it("answers 401 to a browser that is not signed in", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient();
    const uid = await openInteraction(jar, clientId, "http://127.0.0.1:5000/callback");
    const signedOut = new Jar();
    expect((await browse(signedOut, `/api/v1/oauth/interactions/${uid}`)).status).toBe(401);
  });

  it("answers 404 marked request_expired to an interaction that does not exist", async () => {
    const { jar } = await seedUser();
    const res = await browse(jar, `/api/v1/oauth/interactions/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { reason?: string } }).error.reason).toBe("request_expired");
  });
});

describe("refresh tokens", () => {
  it("rotates: the new refresh token works and the access token keeps its lifetime", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient();
    const first = await codeFlow(jar, clientId);
    const res = await refresh(clientId, first.refresh_token);
    expect(res.status).toBe(200);
    const second = (await res.json()) as { refresh_token: string; expires_in: number };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.expires_in).toBe(getMcpConfig().oauth.access_token_ttl_seconds);
    expect((await refresh(clientId, second.refresh_token)).status).toBe(200);
  });

  it("lets two sessions refresh with the same token inside the reuse grace window", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200);
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200);
  });

  it("voids the whole grant when a consumed refresh token is reused outside the window, and keeps the connection as expired", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    const downstream = (await (await exchange(tokens.access_token)).json()) as { access_token: string };
    const rotated = (await (await refresh(clientId, tokens.refresh_token)).json()) as { refresh_token: string };
    const [grantId] = await grantsOf(userId, clientId);
    await sql`
      UPDATE oauth_records SET consumed_at = now() - make_interval(secs => ${getMcpConfig().oauth.refresh_reuse_grace_seconds + 1})
      WHERE model = 'RefreshToken' AND grant_id = ${grantId!} AND consumed_at IS NOT NULL`;
    const reuse = await refresh(clientId, tokens.refresh_token);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await refresh(clientId, rotated.refresh_token)).status).toBe(400);
    expect(await grantsOf(userId, clientId)).toEqual([]);
    expect(await downstreamWorks(downstream.access_token, userId)).toBe(false);
    const rows = await agentAccessService.listConnections(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("expired");
  });
});

describe("revocation", () => {
  it.each(["access_token", "refresh_token"] as const)(
    "voids the whole grant when the client revokes its %s, and deletes the connection",
    async (which) => {
      const { userId, jar } = await seedUser();
      const clientId = await registerClient();
      const tokens = await codeFlow(jar, clientId);
      const downstream = (await (await exchange(tokens.access_token)).json()) as { access_token: string };
      const res = await postForm("/oauth/revoke", { token: tokens[which], client_id: clientId });
      expect(res.status).toBe(200);
      expect(await grantsOf(userId, clientId)).toEqual([]);
      expect((await refresh(clientId, tokens.refresh_token)).status).toBe(400);
      expect((await exchange(tokens.access_token)).status).toBe(400);
      expect(await downstreamWorks(downstream.access_token, userId)).toBe(false);
      expect(await agentAccessService.listConnections(userId)).toEqual([]);
    },
  );

  it("announces the connection on sessions:revoked once the client revokes its last grant", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    const [row] = await agentAccessService.listConnections(userId);
    const [grantId] = await grantsOf(userId, clientId);
    await postForm("/oauth/revoke", { token: tokens.refresh_token, client_id: clientId });
    const [event, ...more] = await announcedFor(userId);
    expect(more).toEqual([]);
    expect(event?.sessionIds).toEqual(expect.arrayContaining([grantId, row!.id]));
  });

  it("announces nothing while another grant keeps the connection usable, and keeps the agent online", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const laptop = await codeFlow(jar, clientId);
    const desktop = await codeFlow(jar, clientId);
    await postForm("/oauth/revoke", { token: laptop.refresh_token, client_id: clientId });
    expect(await announcedFor(userId)).toEqual([]);
    expect((await exchange(desktop.access_token)).status).toBe(200);
  });

  it("announces the connection when a reused refresh token voids its only grant", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    await refresh(clientId, tokens.refresh_token);
    const [grantId] = await grantsOf(userId, clientId);
    const [row] = await agentAccessService.listConnections(userId);
    await sql`
      UPDATE oauth_records SET consumed_at = now() - make_interval(secs => ${getMcpConfig().oauth.refresh_reuse_grace_seconds + 1})
      WHERE model = 'RefreshToken' AND grant_id = ${grantId!} AND consumed_at IS NOT NULL`;
    await refresh(clientId, tokens.refresh_token);
    const [event] = await announcedFor(userId);
    expect(event?.sessionIds).toEqual(expect.arrayContaining([grantId, row!.id]));
  });

  it("announces the connection when the user disconnects it in settings", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    await codeFlow(jar, clientId);
    const [row] = await agentAccessService.listConnections(userId);
    const res = await browse(jar, `/api/v1/agent-access/connections/${row!.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const [event] = await announcedFor(userId);
    expect(event?.sessionIds).toContain(row!.id);
  });
});

describe("token exchange", () => {
  it("trades an agent's access token for a downstream token that acts as its user", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    const res = await exchange(tokens.access_token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; issued_token_type: string; token_type: string; expires_in: number };
    expect(body.issued_token_type).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(getMcpConfig().downstream_token_ttl_seconds);
    expect(body.access_token).not.toBe(tokens.access_token);
    expect(await downstreamWorks(body.access_token, userId)).toBe(true);
  });

  it("trades a personal access token and records when the connection was last used", async () => {
    const { userId } = await seedUser();
    const created = await agentAccessService.createPersonalAccessToken({ userId, name: "DeepSeek Harness", expiresAt: null });
    if (!created.ok) throw new Error("cap");
    const res = await exchange(created.token);
    expect(res.status).toBe(200);
    expect(await downstreamWorks(((await res.json()) as { access_token: string }).access_token, userId)).toBe(true);
    const [row] = await agentAccessService.listConnections(userId);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("ends a downstream token when the personal access token it stands for expires", async () => {
    const { userId } = await seedUser();
    const created = await agentAccessService.createPersonalAccessToken({ userId, name: "short", expiresAt: new Date(Date.now() + 120_000) });
    if (!created.ok) throw new Error("cap");
    const body = (await (await exchange(created.token)).json()) as { expires_in: number };
    expect(body.expires_in).toBeLessThanOrEqual(120);
    expect(body.expires_in).toBeGreaterThan(110);
  });

  it.each(["AccessToken", "Grant"] as const)("ends a downstream token when the agent's %s expires", async (model) => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    const [grantId] = await grantsOf(userId, clientId);
    await expireIn(grantId!, model, 120);
    const body = (await (await exchange(tokens.access_token)).json()) as { expires_in: number };
    expect(body.expires_in).toBeLessThanOrEqual(120);
    expect(body.expires_in).toBeGreaterThan(110);
  });

  it("answers invalid_grant when the credential has less than one call left", async () => {
    const { userId } = await seedUser();
    const left = getMcpConfig().call_timeout_ms - 5_000;
    const created = await agentAccessService.createPersonalAccessToken({ userId, name: "ending", expiresAt: new Date(Date.now() + left) });
    if (!created.ok) throw new Error("cap");
    const res = await exchange(created.token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses an agent's own token on the API: only a downstream token passes the whitelist", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    expect(await downstreamWorks(tokens.access_token, userId)).toBe(false);
  });

  it.each([
    ["an unknown token", () => crypto.randomBytes(32).toString("base64url")],
    ["an expired personal access token", null],
  ])("answers invalid_grant to %s", async (_label, make) => {
    let subject: string;
    if (make) subject = make();
    else {
      const { userId } = await seedUser();
      const created = await agentAccessService.createPersonalAccessToken({ userId, name: "old", expiresAt: new Date(Date.now() - 1000) });
      if (!created.ok) throw new Error("cap");
      subject = created.token;
    }
    const res = await exchange(subject);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("answers invalid_grant to an access token whose connection was disconnected", async () => {
    const { userId, jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    const [row] = await agentAccessService.listConnections(userId);
    await agentAccessService.disconnect(row!.id, userId);
    const res = await exchange(tokens.access_token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it.each([
    ["a wrong secret", { id: MCP_CLIENT_ID, secret: "not-the-secret" }],
    ["a public client", null],
  ])("refuses the exchange from %s", async (_label, client) => {
    const { jar } = await seedUser();
    const clientId = await registerClient();
    const tokens = await codeFlow(jar, clientId);
    const res = client
      ? await exchange(tokens.access_token, client)
      : await postForm("/oauth/token", {
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: tokens.access_token,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
          client_id: clientId,
        });
    expect([400, 401]).toContain(res.status);
    expect(["invalid_client", "unauthorized_client"]).toContain(((await res.json()) as { error: string }).error);
  });
});

/**
 * Assert the browser was sent to our consent page's error state.
 * @param res - The response to the authorization request.
 * @param reason - The error state expected.
 */
function expectConsentError(res: Response, reason: "client_invalid" | "redirect_mismatch" | "request_expired"): void {
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location")!, base);
  expect(location.origin).toBe(WEB);
  expect(location.pathname).toBe("/connect/error");
  expect(location.searchParams.get("reason")).toBe(reason);
}

describe("token exchange rate limit", () => {
  it("counts every exchange in the user's total and answers 429 with Retry-After once it is spent", async () => {
    const { userId } = await seedUser();
    const created = await agentAccessService.createPersonalAccessToken({ userId, name: "busy", expiresAt: null });
    if (!created.ok) throw new Error("cap");
    const total = getMcpConfig().rate_limit.user_total_per_minute;
    for (let i = 0; i < total; i++) {
      const res = await exchange(created.token);
      expect(res.status, `exchange ${i + 1}`).toBe(200);
    }
    const refused = await exchange(created.token);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { error: string }).error).toBe("temporarily_unavailable");
  });
});

describe("error pages", () => {
  it("sends the browser to the consent page's error state for an unknown client", async () => {
    const { jar } = await seedUser();
    const { challenge } = pkce();
    const res = await authorize(jar, { client_id: "no-such-client", redirect_uri: "http://127.0.0.1:5000/callback", code_challenge: challenge, code_challenge_method: "S256", resource, state: "s" });
    expectConsentError(res, "client_invalid");
  });

  it("sends the browser to the consent page's error state when the callback does not match the registration", async () => {
    const { jar } = await seedUser();
    const clientId = await registerClient("Web Agent", ["https://agent.example.com/oauth/callback"]);
    const { challenge } = pkce();
    const res = await authorize(jar, { client_id: clientId, redirect_uri: "https://evil.example.com/oauth/callback", code_challenge: challenge, code_challenge_method: "S256", resource, state: "s" });
    expectConsentError(res, "redirect_mismatch");
  });
});

describe("client ID metadata documents", () => {
  it.each([
    ["plain http", "http://agent.example.com/client.json"],
    ["a loopback address", "https://127.0.0.1/client.json"],
    ["a private address", "https://10.0.0.8/client.json"],
  ])("refuses a client id served over %s", async (_label, clientId) => {
    const { jar } = await seedUser();
    const { challenge } = pkce();
    const res = await authorize(jar, { client_id: clientId, redirect_uri: "http://127.0.0.1:5000/callback", code_challenge: challenge, code_challenge_method: "S256", resource, state: "s" });
    expectConsentError(res, "client_invalid");
  });

  it("runs the code flow for Claude Code's published metadata document on a random loopback port @needs-internet", async () => {
    const { userId, jar } = await seedUser();
    const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
    const tokens = await codeFlow(jar, clientId, "http://localhost:49321/callback");
    expect(tokens.access_token).toBeTruthy();
    const rows = await agentAccessService.listConnections(userId);
    expect(rows[0]).toMatchObject({ kind: "cimd" });
  });
});
