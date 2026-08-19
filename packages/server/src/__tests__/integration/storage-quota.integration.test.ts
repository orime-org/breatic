// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 存储配额闸门（#89，会员块五）—— real-PG 集成。
 *
 * 判据只有一条：该 studio 的 admin 的档位存储上限，减去那个 admin 的账号总
 * 用量，剩下的大于 0 就放行。不看这一次要写多大，不冻结、不预留 —— 所以存储
 * 会超限，那是拍过板的接受结果。
 *
 * 这里钉的四件事，每一条都对应一种「写起来很自然、但判错了对象」的实现：
 *
 *   1. 判的是 admin，不是操作者。团队里 editor 上传时字节进团队池，判的是
 *      admin 的账号总量 —— editor 自己的个人 studio 装得多满都不算数。
 *   2. 用量是账号跨 studio 求和，不是这一个 studio 的字节。只数当前这个
 *      studio 的实现，在「admin 的个人 studio 快满、要写的团队 studio 是空
 *      的」这个场景下会放行，而账号早就满了。
 *   3. 上限经 honouredTier。欠费超过宽限窗口的 pro 账号按 base 判，不然
 *      别的上限按 base、存储按 pro，同一个账号两套标准。
 *   4. 企业档放行，且 limitBytes 是 null —— 不是编一个数，也不是 500。
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
import { initCore, loadLocales, getMembershipLimits } from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "storage-quota-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user on a given tier, plus their personal studio.
 * @param tier - The membership tier to stamp on the account.
 * @returns The user id and their personal studio id.
 */
async function insertUser(
  tier: string,
): Promise<{ userId: string; personalStudioId: string }> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`sq-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`sq-p-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${st!.id}, ${userId}, 'admin')
  `;
  return { userId, personalStudioId: st!.id };
}

/**
 * A team studio whose current admin is `adminUserId`.
 * @param adminUserId - Who administers it.
 * @returns The studio id.
 */
async function insertTeamStudio(adminUserId: string): Promise<string> {
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${`sq-t-${seq++}`}, 'team', 'Team')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${st!.id}, ${adminUserId}, 'admin')
  `;
  return st!.id;
}

/**
 * A project inside a studio.
 * @param studioId - The studio that owns it.
 * @param createdBy - Whoever created it; not what decides the ceilings.
 * @returns The project id.
 */
async function insertProject(
  studioId: string,
  createdBy: string,
): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${createdBy}, 'Project', ${`sq-pr-${seq++}`})
    RETURNING id
  `;
  return p!.id;
}

/**
 * Put `sizeBytes` of registered asset into a studio.
 * @param studioId - Which studio's pool the bytes land in.
 * @param producedBy - The account on the asset row's FK.
 * @param sizeBytes - How many bytes to register.
 */
async function seedAsset(
  studioId: string,
  producedBy: string,
  sizeBytes: number,
): Promise<void> {
  await assetRepo.registerWithDedup({
    studioId,
    producedByUserId: producedBy,
    contentHash: crypto.randomBytes(32).toString("hex"),
    storageKey: `image/2026-08-19/${crypto.randomUUID()}.png`,
    fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
    sizeBytes,
    mimeType: "image/png",
    kind: "image",
    source: "upload",
  });
}

const BASE_STORAGE = getMembershipLimits("base").storage_bytes;
const PRO_STORAGE = getMembershipLimits("pro").storage_bytes;

describe("assertStorageAllowance", () => {
  it("lets a write through while there is room, and answers the remaining bytes", async () => {
    const { userId, personalStudioId } = await insertUser("base");
    const projectId = await insertProject(personalStudioId, userId);
    await seedAsset(personalStudioId, userId, 1024);

    const allowance = await assertStorageAllowance(projectId, "upload");
    expect(allowance.limitBytes).toBe(BASE_STORAGE);
    expect(allowance.usedBytes).toBe(1024);
    expect(allowance.remainingBytes).toBe(BASE_STORAGE - 1024);
  });

  it("refuses with 507 once the account is at its ceiling", async () => {
    const { userId, personalStudioId } = await insertUser("base");
    const projectId = await insertProject(personalStudioId, userId);
    await seedAsset(personalStudioId, userId, BASE_STORAGE);

    // Exactly at the ceiling is already refused: the rule is "more than zero
    // left", so zero left is full (user 2026-08-19).
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject({
      statusCode: 507,
    });
  });

  it("judges the studio's admin, not whoever is uploading", async () => {
    // An editor whose OWN personal studio is over their own ceiling uploads
    // into a team studio with room. The bytes land in the team pool, so the
    // team admin's account is what decides — the editor's full personal
    // studio has nothing to do with it.
    const admin = await insertUser("pro");
    const editor = await insertUser("base");
    const teamStudioId = await insertTeamStudio(admin.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${teamStudioId}, ${editor.userId}, 'maintainer')
    `;
    const projectId = await insertProject(teamStudioId, admin.userId);
    await seedAsset(editor.personalStudioId, editor.userId, BASE_STORAGE);

    const allowance = await assertStorageAllowance(projectId, "upload");
    expect(allowance.limitBytes).toBe(PRO_STORAGE);
    expect(allowance.usedBytes).toBe(0);
  });

  it("sums the admin's whole account, not just the studio being written to", async () => {
    // The case that tells "account roll-up" apart from "this studio's bytes":
    // the admin's PERSONAL studio is full, the team studio being written to is
    // empty. An implementation that counted only the target studio would let
    // this through while the account is long past its ceiling.
    const admin = await insertUser("base");
    const teamStudioId = await insertTeamStudio(admin.userId);
    const projectId = await insertProject(teamStudioId, admin.userId);
    await seedAsset(admin.personalStudioId, admin.userId, BASE_STORAGE);

    await expect(assertStorageAllowance(projectId, "generate")).rejects.toMatchObject({
      statusCode: 507,
    });
  });

  it("holds a lapsed pro subscription to the base ceiling", async () => {
    // Every other ceiling already honours a subscription that stopped paying
    // long enough ago. Storage must not be the one that keeps the pro number.
    const { userId, personalStudioId } = await insertUser("pro");
    const projectId = await insertProject(personalStudioId, userId);
    await sql`
      INSERT INTO subscriptions (
        user_id, stripe_subscription_id, stripe_customer_id, tier,
        status, current_period_end
      )
      VALUES (
        ${userId}, ${`sub_${seq++}`}, ${`cus_${seq++}`}, 'pro',
        'active', now() - interval '400 days'
      )
    `;
    // Between the two ceilings, so it passes on pro's and fails on base's —
    // the assertion cannot be satisfied by either number alone.
    await seedAsset(personalStudioId, userId, BASE_STORAGE + 1);

    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject({
      statusCode: 507,
    });
  });

  it("lets the enterprise tier through with a null ceiling", async () => {
    const { userId, personalStudioId } = await insertUser("enterprise");
    const projectId = await insertProject(personalStudioId, userId);
    await seedAsset(personalStudioId, userId, PRO_STORAGE * 10);

    const allowance = await assertStorageAllowance(projectId, "generate");
    expect(allowance.limitBytes).toBeNull();
    expect(allowance.remainingBytes).toBeNull();
    expect(allowance.usedBytes).toBe(PRO_STORAGE * 10);
  });
});
