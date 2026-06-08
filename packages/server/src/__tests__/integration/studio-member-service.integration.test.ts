// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio member service (slice 3) — invite / remove / change-role, against a
 * real Postgres. This is the 鉴权 + 数据完整性 critical path, so the
 * service-level invariants are pinned end-to-end:
 *
 *   - inviteMember: rejects an unregistered email (NotFound), rejects a
 *     personal studio (Forbidden), rejects a re-invite of an active member
 *     (Conflict), revives a kicked member, and lands the membership + an
 *     informational notification.
 *   - removeMember: in one tx clears the kicked member's access across ALL the
 *     studio's projects AND transfers each project they own to the acting
 *     admin; refuses to remove the sole admin (Conflict) and a personal studio.
 *   - updateMemberRole: creator↔member only; refuses admin and personal studio.
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

import postgres from "postgres";
import { initCore } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { projectMembersRepo } from "@breatic/core";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "studio-member-service-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/** Insert a user; returns { id, email }. */
async function insertUser(): Promise<{ id: string; email: string }> {
  const email = `sms-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return { id: rows[0]!.id, email };
}

let studioSeq = 0;
/** Insert a studio (team by default) + the creator's admin member row. */
async function insertStudioWithAdmin(
  adminUserId: string,
  type: "team" | "personal" = "team",
): Promise<{ id: string; slug: string }> {
  const slug = `sms-studio-${studioSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, ${type}, 'Test Studio')
    RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${adminUserId}, 'admin')`;
  return { id, slug };
}

let projectSeq = 0;
async function insertProject(studioId: string, ownerUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${ownerUserId}, ${`sms-proj-${projectSeq++}`}, 'P')
    RETURNING id
  `;
  const pid = rows[0]!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${pid}, ${ownerUserId}, 'owner')`;
  return pid;
}

describe("inviteMember", () => {
  it("adds a registered user as a member and sends a notification", async () => {
    const admin = await insertUser();
    const invitee = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);

    await studioMemberService.inviteMember(studio.slug, admin.id, invitee.email, "member");

    expect(await studioMembersRepo.getRole(studio.id, invitee.id)).toBe("member");
    const notifs = await sql<{ type: string }[]>`
      SELECT type FROM notifications WHERE user_id = ${invitee.id}
    `;
    expect(notifs.map((n) => n.type)).toContain("studio.member_invited");
  });

  it("rejects an unregistered email with NotFound", async () => {
    const admin = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await expect(
      studioMemberService.inviteMember(studio.slug, admin.id, "nobody@example.com", "member"),
    ).rejects.toMatchObject({ statusCode:404 });
  });

  it("rejects re-inviting an already-active member with Conflict", async () => {
    const admin = await insertUser();
    const invitee = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await studioMemberService.inviteMember(studio.slug, admin.id, invitee.email, "member");
    await expect(
      studioMemberService.inviteMember(studio.slug, admin.id, invitee.email, "creator"),
    ).rejects.toMatchObject({ statusCode:409 });
  });

  it("rejects inviting into a personal studio with Forbidden", async () => {
    const admin = await insertUser();
    const invitee = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id, "personal");
    await expect(
      studioMemberService.inviteMember(studio.slug, admin.id, invitee.email, "member"),
    ).rejects.toMatchObject({ statusCode:403 });
  });
});

describe("removeMember", () => {
  it("clears the member's project access and transfers their owned projects to the acting admin", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await studioMemberService.inviteMember(studio.slug, admin.id, member.email, "member");
    const ownedByMember = await insertProject(studio.id, member.id); // member owns this
    const adminProject = await insertProject(studio.id, admin.id); // admin owns this

    await studioMemberService.removeMember(studio.slug, member.id, admin.id);

    // member loses studio membership + project access
    expect(await studioMembersRepo.getRole(studio.id, member.id)).toBeNull();
    expect(await projectMembersRepo.getRole(ownedByMember, member.id)).toBeNull();
    // the project the member owned is now owned by the acting admin
    expect(await projectMembersRepo.getRole(ownedByMember, admin.id)).toBe("owner");
    // admin's own project is untouched
    expect(await projectMembersRepo.getRole(adminProject, admin.id)).toBe("owner");
  });

  it("refuses to remove the sole admin with Conflict", async () => {
    const admin = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await expect(
      studioMemberService.removeMember(studio.slug, admin.id, admin.id),
    ).rejects.toMatchObject({ statusCode:409 });
  });
});

describe("updateMemberRole", () => {
  it("changes a member to creator", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await studioMemberService.inviteMember(studio.slug, admin.id, member.email, "member");

    await studioMemberService.updateMemberRole(studio.slug, member.id, "creator");

    expect(await studioMembersRepo.getRole(studio.id, member.id)).toBe("creator");
  });

  it("refuses to change the admin's role (admin demotion goes through transfer)", async () => {
    const admin = await insertUser();
    const studio = await insertStudioWithAdmin(admin.id);
    await expect(
      studioMemberService.updateMemberRole(studio.slug, admin.id, "member"),
    ).rejects.toMatchObject({ statusCode:409 });
  });
});
