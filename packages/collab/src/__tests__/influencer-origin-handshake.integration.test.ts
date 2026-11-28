// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The collaboration handshake from influencer sites (inner#2157 design §7.5,
 * §7.9 "全站会话"; §8 rows "开网红接口" (collab handshake while disabled) and
 * "全站登录（V11）" (collab accepts only the new name); acceptance V11, V12).
 *
 * The auth hook lets a browser `Origin` through when it is an exact
 * `ALLOWED_ORIGINS` entry or a registered influencer host (disabled ones
 * included) on the first entry's scheme and port, and with `COOKIE_DOMAIN` set
 * it reads the session only from `breatic_site_session_<REDIS_KEY_PREFIX>`.
 *
 * Real hook, session store and role lookup on Postgres and Redis; only the
 * logger is replaced.
 */

import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type * as CoreModule from "@breatic/core";

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  }),
}));

import { env, initCore, getRedis, sessionCookieName, setSession } from "@breatic/core";
import { adminSql as sql } from "./helpers/admin-sql.js";
import { createAuthHook } from "@collab/hooks/auth.js";
import type { DocumentRegistry } from "@collab/services/project-space-list.js";

const OFFICIAL = "https://breatic.test";
const tag = crypto.randomBytes(4).toString("hex");
const ENABLED_HOST = `con${tag}.partner.breatic.test`;
const DISABLED_HOST = `coff${tag}.partner.breatic.test`;

let projectId: string;
let token: string;

/**
 * Core for one region.
 * @param cookieDomain - `COOKIE_DOMAIN`.
 */
function initRegionCore(cookieDomain: string): void {
  initCore({ ...process.env, ALLOWED_ORIGINS: OFFICIAL, COOKIE_DOMAIN: cookieDomain });
}

beforeAll(async () => {
  initRegionCore("breatic.test");
  // Registered before the first handshake: the trusted-origin host list is cached per process.
  await sql`INSERT INTO influencers (code, host) VALUES (${`col-on-${tag}`}, ${ENABLED_HOST})`;
  await sql`INSERT INTO influencers (code, host, disabled_at) VALUES (${`col-off-${tag}`}, ${DISABLED_HOST}, now())`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`origin-${tag}@example.com`}, true) RETURNING id`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${`o${tag}`}, 'personal', ${tag}) RETURNING id`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${user!.id}, ${tag}, ${tag}) RETURNING id`;
  projectId = project!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${user!.id}, 'editor', null)`;
  token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
});

afterAll(() => {
  initCore(process.env);
});

/**
 * Run the auth hook once for the project's meta document.
 * @param origin - The handshake's `Origin`.
 * @param cookie - The handshake's Cookie header.
 * @returns The settled outcome.
 */
async function handshake(origin: string, cookie: string): Promise<PromiseSettledResult<unknown>> {
  const hook = createAuthHook({
    redis: getRedis(),
    resolveConnectionLimit: async () => 10,
    countConnections: async () => 0,
    hasOwnSeat: async () => "no" as const,
  });
  const [outcome] = await Promise.allSettled([
    hook({
      token: "__cookie_auth__",
      documentName: `project-${projectId}/meta`,
      requestHeaders: new Headers({ origin, cookie }),
      connectionConfig: { readOnly: false },
      instance: {} as DocumentRegistry,
      request: new Request("http://localhost"),
      socketId: `origin-${tag}`,
    }),
  ]);
  return outcome;
}

/**
 * The rejection message of an outcome.
 * @param outcome - The settled outcome.
 * @returns Its message, or null when it was let in.
 */
function rejection(outcome: PromiseSettledResult<unknown>): string | null {
  return outcome.status === "rejected" ? (outcome.reason as Error).message : null;
}

describe("collab handshake from influencer sites", () => {
  it("names the session cookie breatic_site_session_<prefix> when COOKIE_DOMAIN is set", () => {
    expect(sessionCookieName()).toBe(`breatic_site_session_${env.REDIS_KEY_PREFIX}`);
  });

  it("lets a registered influencer host through with the site-wide cookie", async () => {
    const outcome = await handshake(`https://${ENABLED_HOST}`, `breatic_site_session_${env.REDIS_KEY_PREFIX}=${token}`);
    expect(rejection(outcome)).toBeNull();
  });

  it("V12 lets a disabled influencer's host through", async () => {
    const outcome = await handshake(`https://${DISABLED_HOST}`, `breatic_site_session_${env.REDIS_KEY_PREFIX}=${token}`);
    expect(rejection(outcome)).toBeNull();
  });

  it("refuses a host in the influencer domain that nobody registered", async () => {
    const outcome = await handshake(`https://none${tag}.partner.breatic.test`, `breatic_site_session_${env.REDIS_KEY_PREFIX}=${token}`);
    expect(rejection(outcome)).toBe("Origin not allowed");
  });

  it("refuses a registered host on another scheme than the first ALLOWED_ORIGINS entry", async () => {
    const outcome = await handshake(`http://${ENABLED_HOST}`, `breatic_site_session_${env.REDIS_KEY_PREFIX}=${token}`);
    expect(rejection(outcome)).toBe("Origin not allowed");
  });

  it("V11 does not read the session from the old host-only cookie name", async () => {
    const outcome = await handshake(OFFICIAL, `breatic_session_${env.REDIS_KEY_PREFIX}=${token}`);
    expect(rejection(outcome)).toBe("Missing session cookie");
  });

  it("with COOKIE_DOMAIN empty, reads the session from breatic_session_<prefix> as before", async () => {
    initRegionCore("");
    try {
      expect(sessionCookieName()).toBe(`breatic_session_${env.REDIS_KEY_PREFIX}`);
      expect(rejection(await handshake(OFFICIAL, `breatic_session_${env.REDIS_KEY_PREFIX}=${token}`))).toBeNull();
    } finally {
      initRegionCore("breatic.test");
    }
  });
});
