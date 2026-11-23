// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The 1968 tier numbers as the gates apply them, against real Postgres
 * (inner#1968, test spec area A: A-13 to A-19, and I-04).
 *
 * The numbers are written out rather than read from the config, so a config
 * that drifts from the agreed tiers fails here as well as in the loader test.
 * Placement: the spec puts A-13 at core integration; core has no integration
 * harness, and the cross-package database suites live here.
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

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { getLimitsForStudio, initCore, loadLocales, runWithLocale } from "@breatic/core";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";
import * as projectService from "@server/modules/project/project.service.js";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // already initialised by a sibling suite in this worker
  }
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "tier-limits-1968-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * One account on a stored tier.
 * @param tier - Its membership tier.
 * @returns Its id and email.
 */
async function user(tier: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await sql`insert into users(id, email, email_verified, membership_tier) values (${id}, ${email}, true, ${tier})`;
  return { id, email };
}

/**
 * A studio administered by `adminId`.
 * @param adminId - Its admin.
 * @param type - Personal or team.
 * @returns Its id and slug.
 */
async function studio(adminId: string, type: "personal" | "team" = "team"): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${id}, ${adminId}, ${`tl-${id}`}, ${type}, 'Limits')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${id}, ${adminId}, 'admin')`;
  return { id, slug: `tl-${id}` };
}

/**
 * Add `n` guest members to a studio, outside the gate.
 * @param studioId - The studio.
 * @param n - How many.
 */
async function addStudioMembers(studioId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const u = await user("base");
    await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${u.id}, 'guest')`;
  }
}

/**
 * A project with its owner row.
 * @param studioId - Its studio.
 * @param ownerId - Its owner.
 * @returns Its id.
 */
async function project(studioId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into projects(id, studio_id, created_by_user_id, name, slug) values (${id}, ${studioId}, ${ownerId}, 'Limits', ${id})`;
  await sql`insert into project_members(project_id, user_id, role) values (${id}, ${ownerId}, 'owner')`;
  return id;
}

/**
 * Registered bytes in a studio.
 * @param studioId - Whose pool.
 * @param producedBy - The asset's producer.
 * @param size - How many bytes.
 */
async function bytes(studioId: string, producedBy: string, size: number): Promise<void> {
  const key = randomUUID();
  await sql`insert into studio_assets(studio_id, produced_by_user_id, content_hash, storage_key, file_url, mime_type, kind, source, size_bytes)
    values (${studioId}, ${producedBy}, ${key}, ${key}, ${`https://example.test/${key}.png`}, 'image/png', 'image', 'upload', ${size})`;
}

/**
 * Invitations waiting in one studio.
 * @param studioId - The studio.
 * @returns How many rows.
 */
async function invitations(studioId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from studio_invitations where studio_id = ${studioId}`;
  return row!.n;
}

const TIERS = {
  base: { team_studios: 0, projects_per_studio: 9999, concurrent_editors: 2, studio_members: 1, project_members: 4, storage_bytes: 5368709120, running_tasks_per_user: 2 },
  pro: { team_studios: 1, projects_per_studio: 9999, concurrent_editors: 4, studio_members: 10, project_members: 8, storage_bytes: 107374182400, running_tasks_per_user: 5 },
  team: { team_studios: 3, projects_per_studio: 9999, concurrent_editors: 20, studio_members: 50, project_members: 40, storage_bytes: 536870912000, running_tasks_per_user: 10 },
  self_hosted: { team_studios: 9999, projects_per_studio: 9999, concurrent_editors: 9999, studio_members: 9999, project_members: 9999, storage_bytes: 109951162777600, running_tasks_per_user: 9999 },
} as const;

describe("1968 tier limits at the gates", () => {
  it.each(Object.keys(TIERS) as (keyof typeof TIERS)[])("A-13 getLimitsForStudio for a %s studio carries running_tasks_per_user", async (tier) => {
    const admin = await user(tier);
    const s = await studio(admin.id);
    expect(await getLimitsForStudio(s.id)).toEqual(TIERS[tier]);
  });

  it("A-14 a team studio with 50 members refuses the 51st invitation with the zh-CN member-limit sentence", async () => {
    const admin = await user("team");
    const s = await studio(admin.id);
    await addStudioMembers(s.id, 49);
    const invitee = await user("base");
    const before = await invitations(s.id);
    const refused = runWithLocale("zh-CN", () => studioInviteService.createInvite(s.slug, admin.id, invitee.email, "guest"));
    await expect(refused).rejects.toMatchObject({
      statusCode: 409,
      name: "ConflictError",
      message: "这个 Studio 的会员等级最多可有 50 位成员，升级可添加更多。",
    });
    expect(await invitations(s.id)).toBe(before);
  });

  it("A-15 a team studio with 49 members accepts the 50th invitation and writes the row", async () => {
    const admin = await user("team");
    const s = await studio(admin.id);
    await addStudioMembers(s.id, 48);
    const invitee = await user("base");
    const before = await invitations(s.id);
    await expect(studioInviteService.createInvite(s.slug, admin.id, invitee.email, "guest")).resolves.toMatchObject({ invitationId: expect.any(String) });
    expect(await invitations(s.id)).toBe(before + 1);
  });

  it("A-16 a pro team studio with 10 members refuses the 11th invitation naming 10", async () => {
    const admin = await user("pro");
    const s = await studio(admin.id);
    await addStudioMembers(s.id, 9);
    const invitee = await user("base");
    await expect(studioInviteService.createInvite(s.slug, admin.id, invitee.email, "guest")).rejects.toMatchObject({
      statusCode: 409,
      message: "This studio's plan allows up to 10 members. Upgrade to add more.",
    });
  });

  it("A-17 a pro project with 8 collaborators refuses the 9th invitation naming 8", async () => {
    const admin = await user("pro");
    const s = await studio(admin.id);
    const p = await project(s.id, admin.id);
    for (let i = 0; i < 8; i++) {
      const u = await user("base");
      await sql`insert into project_members(project_id, user_id, role, added_by) values (${p}, ${u.id}, 'viewer', ${admin.id})`;
    }
    const invitee = await user("base");
    await expect(projectInviteService.createInvite(p, admin.id, invitee.email, "viewer")).rejects.toMatchObject({
      statusCode: 409,
      message: "This project allows up to 8 collaborators. Upgrade to add more.",
    });
  });

  it("A-18 a base personal studio with 10 projects creates an 11th", async () => {
    const admin = await user("base");
    const s = await studio(admin.id, "personal");
    for (let i = 0; i < 10; i++) {
      await sql`insert into projects(studio_id, created_by_user_id, name, slug) values (${s.id}, ${admin.id}, 'Seed', ${randomUUID()})`;
    }
    await expect(projectService.create(admin.id, s.id, "Eleventh", randomUUID(), "canvas")).resolves.toMatchObject({ studioId: s.id });
  });

  it("A-19 a pro studio is refused at exactly 100 GiB used and let through one byte under", async () => {
    const full = await user("pro");
    const fullStudio = await studio(full.id, "personal");
    const fullProject = await project(fullStudio.id, full.id);
    await bytes(fullStudio.id, full.id, 107374182400);
    await expect(assertStorageAllowance(fullProject, "upload")).rejects.toMatchObject({ statusCode: 507 });

    const room = await user("pro");
    const roomStudio = await studio(room.id, "personal");
    const roomProject = await project(roomStudio.id, room.id);
    await bytes(roomStudio.id, room.id, 107374182399);
    await expect(assertStorageAllowance(roomProject, "upload")).resolves.toBeUndefined();
  });

  it("I-04 the catalog offers 2, 5 and 10 running tasks", async () => {
    const a = await user("base");
    const { catalog } = await readAccountMembership(a.id);
    const offered = catalog.map((offer) => [offer.tier, offer.limits.running_tasks_per_user]);
    expect(offered).toEqual([
      ["base", 2],
      ["pro", 5],
      ["team", 10],
    ]);
  });
});
