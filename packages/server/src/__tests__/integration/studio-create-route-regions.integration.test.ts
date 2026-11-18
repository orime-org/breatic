// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The creation routes and the region a Studio is placed in (inner#1955) —
 * real PG + Redis.
 *
 * The browser generates the Studio's id and names a region. The server
 * accepts only a region it has an address for, and a deployment with one
 * region ignores whatever region the client sent.
 *
 * The pins:
 *
 *   1. `POST /studios` with a region no deployment setting names is 422 and
 *      writes nothing.
 *   2. `POST /studios` creates the Studio under the id the browser generated.
 *   3. A single-region deployment ignores the region the client sent.
 *   4. `POST /auth/setup-studio` takes the same id and region.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import { GLOBAL_REGION_SETTINGS } from "./global-region-env.js";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";

const TWO_REGIONS = {
  REGION: "us-west",
  GLOBAL_REGION: "us-west",
  REGION_API_URLS: JSON.stringify({ sg: "http://sg.invalid:3002" }),
  ...GLOBAL_REGION_SETTINGS,
};

loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  initCore({ ...process.env, ...TWO_REGIONS });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "studio-create-route-regions-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A signed-in account on the team tier, without a personal Studio.
 * @returns Its id and Cookie header.
 * @throws {Error} if an insert fails or Redis is unreachable.
 */
async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`route-region-${Date.now()}-${seq++}@example.test`}, true, 'team')
    RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { userId: user!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * A slug nobody has used.
 * @returns The slug.
 */
function freshSlug(): string {
  return `rr-${crypto.randomBytes(5).toString("hex")}`;
}

/**
 * Send a JSON POST as a signed-in user.
 * @param path - The route under `/api/v1`.
 * @param cookie - The session Cookie header.
 * @param body - The JSON body.
 * @returns The response.
 */
async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /studios and the region", () => {
  it("refuses a region no setting names, and writes nothing", async () => {
    const { cookie } = await signedIn();
    const studioId = crypto.randomUUID();

    const res = await post("/studios", cookie, { studioId, name: "Mars", slug: freshSlug(), region: "mars" });

    expect(res.status).toBe(422);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM studio_directory WHERE studio_id = ${studioId}`;
    expect(row!.n).toBe(0);
  });

  it("creates the Studio under the id the browser generated", async () => {
    const { cookie } = await signedIn();
    const studioId = crypto.randomUUID();

    const res = await post("/studios", cookie, { studioId, name: "Here", slug: freshSlug(), region: "us-west" });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(studioId);
  });

  it("ignores the client's region in a single-region deployment", async () => {
    initCore(process.env);
    try {
      const { cookie } = await signedIn();
      const studioId = crypto.randomUUID();

      const res = await post("/studios", cookie, { studioId, name: "Solo", slug: freshSlug(), region: "sg" });

      expect(res.status).toBe(201);
      const [row] = await sql<{ region: string | null }[]>`SELECT region FROM studio_directory WHERE studio_id = ${studioId}`;
      expect(row?.region ?? null).toBeNull();
    } finally {
      initCore({ ...process.env, ...TWO_REGIONS });
    }
  });
});

describe("POST /auth/setup-studio and the region", () => {
  it("creates the personal Studio under the browser's id in the region it names", async () => {
    const { userId, cookie } = await signedIn();
    const studioId = crypto.randomUUID();

    const res = await post("/auth/setup-studio", cookie, { studioId, slug: freshSlug(), region: "us-west" });

    expect(res.status).toBeLessThan(300);
    const [row] = await sql<{ type: string; admin_user_id: string; state: string }[]>`
      SELECT type, admin_user_id, state FROM studio_directory WHERE studio_id = ${studioId}
    `;
    expect(row).toEqual({ type: "personal", admin_user_id: userId, state: "live" });
  });
});
