// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The storage ceiling of an admin whose Studios live in several regions
 * (inner#1955, acceptance 6) — real PG.
 *
 * What is left = the admin's membership ceiling − what their Studios in other
 * regions use (from `studio_storage_usage_global`, which each region's worker
 * reports) − what their Studios in this region use, read live on every write.
 * This suite runs as the global region; the other region's usage is a
 * reported row.
 *
 * The pins:
 *
 *   1. Usage reported by another region counts against the same ceiling.
 *   2. Within this region, the first write past the ceiling is refused,
 *      because this region's usage is read live.
 *   3. A newer report replaces an older one and an older one is ignored.
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

vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async (): Promise<void> => {},
}));

import crypto from "node:crypto";
import postgres from "postgres";
import { getMembershipLimits, initCore, loadLocales } from "@breatic/core";
import { assetRepo, storageUsageService } from "@breatic/domain";
import { assertStudioStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";

loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;
const BASE_STORAGE = getMembershipLimits("base").storage_bytes!;

beforeAll(() => {
  initCore({ ...process.env, REGION: "us-west", GLOBAL_REGION: "us-west" });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "storage-regions-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A base-tier admin with a team Studio here and one in `sg`, both in the
 * directory.
 * @returns The admin and the two Studio ids.
 */
async function adminInTwoRegions(): Promise<{ userId: string; hereId: string; farId: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`storage-region-${Date.now()}-${seq++}@example.test`}, true, 'base')
    RETURNING id
  `;
  const userId = user!.id;
  const slug = `sr-${crypto.randomBytes(5).toString("hex")}`;
  const [here] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${userId}, ${slug}, 'team', 'Here') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${here!.id}, ${userId}, 'admin')`;
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${here!.id}, ${slug}, NULL, 'team', 'Here', ${userId}, ${userId}, 'live')
  `;
  const farId = crypto.randomUUID();
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${farId}, ${`${slug}-sg`}, 'sg', 'team', 'Far', ${userId}, ${userId}, 'live')
  `;
  return { userId, hereId: here!.id, farId };
}

/**
 * Put bytes of registered asset into a Studio here.
 * @param studioId - The Studio.
 * @param userId - Who produced them.
 * @param sizeBytes - How many.
 */
async function seedAsset(studioId: string, userId: string, sizeBytes: number): Promise<void> {
  await assetRepo.registerWithDedup({
    studioId,
    producedByUserId: userId,
    contentHash: crypto.randomBytes(32).toString("hex"),
    storageKey: `image/2026-11-12/${crypto.randomUUID()}.png`,
    fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
    sizeBytes,
    mimeType: "image/png",
    kind: "image",
    source: "upload",
  });
}

describe("storage across regions", () => {
  it("shows the membership panel every region's team Studios and storage", async () => {
    const { userId, hereId, farId } = await adminInTwoRegions();
    await seedAsset(hereId, userId, 1024);
    await storageUsageService.recordRegionUsage({ region: "sg", asOf: new Date(), usage: [{ studioId: farId, bytes: 4096 }] });

    const panel = await readAccountMembership(userId);

    expect(panel.usage).toEqual({ teamStudios: 2, storageBytes: 1024 + 4096 });
  });

  it("counts usage another region reported against the same ceiling", async () => {
    const { userId, hereId, farId } = await adminInTwoRegions();
    await seedAsset(hereId, userId, 1024);
    await assertStudioStorageAllowance(hereId, "upload");

    await storageUsageService.recordRegionUsage({ region: "sg", asOf: new Date(), usage: [{ studioId: farId, bytes: BASE_STORAGE }] });

    await expect(assertStudioStorageAllowance(hereId, "upload")).rejects.toMatchObject({ statusCode: 507 });
  });

  it("refuses the first write past the ceiling within this region", async () => {
    const { userId, hereId, farId } = await adminInTwoRegions();
    await storageUsageService.recordRegionUsage({
      region: "sg",
      asOf: new Date(),
      usage: [{ studioId: farId, bytes: BASE_STORAGE - 2048 }],
    });
    await seedAsset(hereId, userId, 1024);
    await assertStudioStorageAllowance(hereId, "upload");

    await seedAsset(hereId, userId, 1024);

    await expect(assertStudioStorageAllowance(hereId, "upload")).rejects.toMatchObject({ statusCode: 507 });
  });

  it("keeps the newest report and ignores an older one", async () => {
    const { hereId, farId } = await adminInTwoRegions();
    const now = Date.now();
    await storageUsageService.recordRegionUsage({ region: "sg", asOf: new Date(now), usage: [{ studioId: farId, bytes: 10 }] });
    await storageUsageService.recordRegionUsage({
      region: "sg",
      asOf: new Date(now - 60_000),
      usage: [{ studioId: farId, bytes: BASE_STORAGE }],
    });

    await expect(assertStudioStorageAllowance(hereId, "upload")).resolves.toBeUndefined();
    const [row] = await sql<{ bytes: string }[]>`
      SELECT bytes::text FROM studio_storage_usage_global WHERE studio_id = ${farId} AND region = 'sg'
    `;
    expect(Number(row!.bytes)).toBe(10);
  });
});
