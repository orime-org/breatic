// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 存储配额闸门接在哪两个路口上（#89）—— real-PG 集成，走真实的 Hono app。
 *
 * 任务目标那句话是「两条写入路径都要拦」，这里钉的就是那两条：请求上传地址
 * 和发起生成。判定逻辑本身由 `storage-quota.integration.test.ts` 钉，这一份
 * 只回答三个接线问题：
 *
 *   1. 满了的时候，请求上传地址拿不到 `uploadUrl` —— 拿不到就传不上去，
 *      这是「拦住」在上传那条路上的确切含义。
 *   2. 去重命中那条路照样放行。它零写入（不发 key、不发凭据、`studio_assets`
 *      一行不增），拦它等于拦一个不消耗配额的操作。
 *   3. 满了的时候，发起生成不但返回 507，`tasks` 表也不许多出一行 —— 任务
 *      一旦落库就会被 worker 捡走，那时候再没有任何一道检查。
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

// 邮件那条腿不在本文件的主题内，顶掉它免得真去连 SMTP。
vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async () => {},
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  getMembershipLimits,
} from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "storage-quota-routes-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const BASE_STORAGE = getMembershipLimits("base").storage_bytes;
/** Small enough to be under the per-file upload cap, which is a different gate. */
const SMALL_ASSET_BYTES = 4096;

/**
 * A base-tier account with a personal studio and a project, already holding
 * `filledBytes` of registered asset.
 * @param filledBytes - How full to make the account before the test runs.
 * @returns The ids and a login cookie.
 */
async function fullAccount(filledBytes: number): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
  seededHash: string;
  seededSize: number;
}> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`sqr-${seq++}@example.test`}, true, 'base')
    RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`sqr-p-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  const studioId = st!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `sqr-proj-${seq++}`;
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug}, 'private')
    RETURNING id
  `;
  const projectId = p!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'owner', null)
  `;

  /**
   * Register one asset into this studio.
   * @param sizeBytes - How many bytes it claims.
   * @returns Its content hash, for a later dedup lookup.
   */
  const seed = async (sizeBytes: number): Promise<string> => {
    const contentHash = crypto.randomBytes(32).toString("hex");
    await assetRepo.registerWithDedup({
      studioId,
      producedByUserId: userId,
      contentHash,
      storageKey: `image/2026-08-19/${crypto.randomUUID()}.png`,
      fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
      sizeBytes,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    return contentHash;
  };

  // Two assets, because they answer different questions. The big one is what
  // fills the account; the small one is what a later dedup lookup can match
  // without tripping the per-file cap, which is a separate gate (413) sitting
  // ahead of this one.
  await seed(filledBytes);
  const seededHash = await seed(SMALL_ASSET_BYTES);

  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId,
    projectId,
    cookie: `${sessionCookieName()}=${token}`,
    seededHash,
    seededSize: SMALL_ASSET_BYTES,
  };
}

/**
 * Ask for an upload URL.
 * @param cookie - The caller's session cookie.
 * @param projectId - Where the bytes would land.
 * @param size - Declared size.
 * @param hash - Declared content hash.
 * @returns The raw response.
 */
async function presign(
  cookie: string,
  projectId: string,
  size: number,
  hash: string,
): Promise<Response> {
  const params = new URLSearchParams({
    filename: "photo.png",
    content_type: "image/png",
    project_id: projectId,
    size: String(size),
    hash,
  });
  return app.request(`/api/v1/assets/presign?${params.toString()}`, {
    headers: { Cookie: cookie },
  });
}

describe("the two write paths behind the storage gate", () => {
  it("hands out no upload URL once the account is full", async () => {
    const { cookie, projectId } = await fullAccount(BASE_STORAGE);

    const res = await presign(cookie, projectId, 4096, "b".repeat(64));

    expect(res.status).toBe(507);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("uploadUrl");
  });

  it("still answers a dedup hit when the account is full", async () => {
    // This path writes nothing: no key is minted, no upload grant is issued,
    // `studio_assets` gains no row — the node just points at bytes the studio
    // already has. Refusing it would refuse an operation that cannot consume
    // any storage at all.
    const { cookie, projectId, seededHash, seededSize } =
      await fullAccount(BASE_STORAGE);

    const res = await presign(cookie, projectId, seededSize, seededHash);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { alreadyExists: boolean } };
    expect(body.data.alreadyExists).toBe(true);
  });

  it("starts no generation once the account is full, and writes no task row", async () => {
    const { cookie, projectId } = await fullAccount(BASE_STORAGE);

    const res = await app.request("/api/v1/canvas/tasks", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        task_type: "image",
        params: { prompt: "a cat" },
        model: "test-model",
        source: "canvas",
        project_id: projectId,
        space_id: crypto.randomUUID(),
        mode: "append",
      }),
    });

    expect(res.status).toBe(507);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tasks WHERE project_id = ${projectId}
    `;
    expect(rows[0]!.n).toBe(0);
  });

  it("lets a generation start while there is still room", async () => {
    // The other half of the pin: without it, a gate that refused everything
    // would satisfy every assertion above.
    const { cookie, projectId } = await fullAccount(1024);

    const res = await app.request("/api/v1/canvas/tasks", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        task_type: "image",
        params: { prompt: "a cat" },
        model: "test-model",
        source: "canvas",
        project_id: projectId,
        space_id: crypto.randomUUID(),
        mode: "append",
      }),
    });

    expect(res.status).toBe(201);
  });
});
