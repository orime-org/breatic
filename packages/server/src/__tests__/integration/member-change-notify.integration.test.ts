// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Integration test: every committed write to `project_members` reaches the
 * member-change listener (inner#911).
 *
 * The notification comes from a trigger on the table, so it does not depend on
 * which code path wrote the row. These cases write the table directly, through
 * a rolled-back transaction, and through the studio and project services whose
 * writes used to go unannounced.
 *
 * @see packages/core/src/infra/member-change-listener.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi, inject } from "vitest";

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

import { sql } from "drizzle-orm";
import {
  initCore,
  loadLocales,
  schema,
  createTestDb,
  listenProjectMemberChanges,
  probeMemberListen,
  PROJECT_MEMBER_CHANGED_CHANNEL,
  type MemberChange,
  type MemberChangeListener,
} from "@breatic/core";

initCore(process.env);
loadLocales();

import * as studioMemberService from "../../modules/studio/studioMember.service.js";
import * as projectMembersService from "../../modules/project/projectMembers.service.js";

const ADMIN = "00000000-0000-0000-0000-000000911001";
const MEMBER = "00000000-0000-0000-0000-000000911002";
const LEAVER = "00000000-0000-0000-0000-000000911003";
const GUEST = "00000000-0000-0000-0000-000000911004";
const TEAM = "00000000-0000-0000-0000-000000911010";
const P_ADMIN = "00000000-0000-0000-0000-000000911020";
const P_MEMBER = "00000000-0000-0000-0000-000000911021";
const P_LEAVER = "00000000-0000-0000-0000-000000911022";
const P_RAW = "00000000-0000-0000-0000-000000911023";
const TEAM_SLUG = "c911-team";

let pgClient: ReturnType<typeof createTestDb>["client"];
let db: ReturnType<typeof createTestDb>["db"];
let listener: MemberChangeListener;
const changes: MemberChange[] = [];
const invalid: string[] = [];
let listening = 0;

/**
 * The changes received for one user, in arrival order.
 * @param userId - The user.
 * @returns Their project ids.
 */
function projectsFor(userId: string): string[] {
  return changes.filter((c) => c.userId === userId).map((c) => c.projectId);
}

/**
 * Write a sentinel row and wait until its notification arrives. Notifications
 * from one session are delivered in commit order, so once the sentinel is in,
 * anything committed before it that was going to arrive has arrived.
 * @returns Once the sentinel's change is in.
 */
async function drain(): Promise<void> {
  const before = changes.length;
  await pgClient`update project_members set role = case when role = 'viewer' then 'editor' else 'viewer' end
    where project_id = ${P_RAW} and user_id = ${GUEST}`;
  await vi.waitFor(() => {
    expect(changes.slice(before).some((c) => c.projectId === P_RAW && c.userId === GUEST)).toBe(true);
  });
}

beforeAll(async () => {
  const t = createTestDb(inject("DATABASE_URL"));
  db = t.db;
  pgClient = t.client;

  await db.insert(schema.users).values([
    { id: ADMIN, email: "admin@c911.dev", membershipTier: "pro" },
    { id: MEMBER, email: "member@c911.dev" },
    { id: LEAVER, email: "leaver@c911.dev" },
    { id: GUEST, email: "guest@c911.dev" },
  ]);
  await db.insert(schema.studios).values({
    id: TEAM, createdByUserId: ADMIN, slug: TEAM_SLUG, type: "team", name: "C911",
  });
  await db.insert(schema.studioMembers).values([
    { studioId: TEAM, userId: ADMIN, role: "admin" },
    { studioId: TEAM, userId: MEMBER, role: "maintainer" },
    { studioId: TEAM, userId: LEAVER, role: "maintainer" },
  ]);
  await db.insert(schema.projects).values([
    { id: P_ADMIN, studioId: TEAM, createdByUserId: ADMIN, name: "Admin's", slug: "admins" },
    { id: P_MEMBER, studioId: TEAM, createdByUserId: MEMBER, name: "Member's", slug: "members" },
    { id: P_LEAVER, studioId: TEAM, createdByUserId: LEAVER, name: "Leaver's", slug: "leavers" },
    { id: P_RAW, studioId: TEAM, createdByUserId: ADMIN, name: "Raw", slug: "raw" },
  ]);
  await db.insert(schema.projectMembers).values([
    { projectId: P_ADMIN, userId: ADMIN, role: "owner" },
    { projectId: P_ADMIN, userId: MEMBER, role: "editor" },
    { projectId: P_ADMIN, userId: LEAVER, role: "viewer" },
    { projectId: P_MEMBER, userId: MEMBER, role: "owner" },
    { projectId: P_LEAVER, userId: LEAVER, role: "owner" },
    { projectId: P_RAW, userId: ADMIN, role: "owner" },
    { projectId: P_RAW, userId: GUEST, role: "viewer" },
  ]);

  listener = await listenProjectMemberChanges({
    onChange: (change) => {
      changes.push(change);
    },
    onListening: () => {
      listening += 1;
    },
    onInvalid: (raw) => {
      invalid.push(raw);
    },
  });
});

afterAll(async () => {
  await listener?.stop();
  await pgClient.end();
});

describe("listening", () => {
  it("reports that it is listening once it starts", () => {
    expect(listening).toBe(1);
  });

  it("answers a liveness probe while it listens", async () => {
    expect(await probeMemberListen(1000)).toBe(true);
  });
});

describe("the trigger on project_members", () => {
  it("announces a row inserted by plain SQL", async () => {
    await pgClient`insert into project_members (project_id, user_id, role) values (${P_RAW}, ${MEMBER}, 'viewer')`;
    await vi.waitFor(() => expect(projectsFor(MEMBER)).toContain(P_RAW));
    expect(changes.at(-1)).toEqual({ projectId: P_RAW, userId: MEMBER });
  });

  it("announces a role change", async () => {
    const before = changes.length;
    await pgClient`update project_members set role = 'editor' where project_id = ${P_RAW} and user_id = ${MEMBER}`;
    await vi.waitFor(() => expect(changes.length).toBe(before + 1));
    expect(changes.at(-1)).toEqual({ projectId: P_RAW, userId: MEMBER });
  });

  it("announces a soft delete and a revival", async () => {
    const before = changes.length;
    await pgClient`update project_members set deleted_at = now() where project_id = ${P_RAW} and user_id = ${MEMBER}`;
    await pgClient`update project_members set deleted_at = null where project_id = ${P_RAW} and user_id = ${MEMBER}`;
    await vi.waitFor(() => expect(changes.length).toBe(before + 2));
  });

  it("stays quiet when only updated_at changes", async () => {
    const before = changes.length;
    await pgClient`update project_members set updated_at = now() where project_id = ${P_RAW} and user_id = ${MEMBER}`;
    await drain();
    expect(changes.slice(before).filter((c) => c.userId === MEMBER)).toEqual([]);
  });

  it("announces a hard delete", async () => {
    const before = changes.length;
    await pgClient`delete from project_members where project_id = ${P_RAW} and user_id = ${MEMBER}`;
    await vi.waitFor(() => expect(changes.length).toBe(before + 1));
    expect(changes.at(-1)).toEqual({ projectId: P_RAW, userId: MEMBER });
  });

  it("stays quiet when the transaction rolls back", async () => {
    const before = changes.length;
    await expect(
      pgClient.begin(async (tx) => {
        await tx`update project_members set role = 'editor' where project_id = ${P_RAW} and user_id = ${ADMIN}`;
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    await drain();
    expect(changes.slice(before).filter((c) => c.userId === ADMIN)).toEqual([]);
  });

  it("hands a payload it cannot read to onInvalid", async () => {
    await db.execute(sql`select pg_notify(${PROJECT_MEMBER_CHANGED_CHANNEL}, 'not json')`);
    await vi.waitFor(() => expect(invalid).toContain("not json"));
  });
});

describe("the write paths that used to go unannounced", () => {
  it("announces every project of a member removed from the studio, and the admin who takes over", async () => {
    const before = changes.length;
    await studioMemberService.removeMember(TEAM_SLUG, MEMBER);
    await vi.waitFor(() => {
      const fresh = changes.slice(before);
      expect(fresh).toContainEqual({ projectId: P_ADMIN, userId: MEMBER });
      expect(fresh).toContainEqual({ projectId: P_MEMBER, userId: MEMBER });
      expect(fresh).toContainEqual({ projectId: P_MEMBER, userId: ADMIN });
    });
  });

  it("announces every project of a member who leaves the studio", async () => {
    const before = changes.length;
    await studioMemberService.leaveStudio(TEAM_SLUG, LEAVER);
    await vi.waitFor(() => {
      const fresh = changes.slice(before);
      expect(fresh).toContainEqual({ projectId: P_ADMIN, userId: LEAVER });
      expect(fresh).toContainEqual({ projectId: P_LEAVER, userId: LEAVER });
      expect(fresh).toContainEqual({ projectId: P_LEAVER, userId: ADMIN });
    });
  });

  it("still announces a member removed from a project", async () => {
    const before = changes.length;
    await projectMembersService.remove(P_RAW, GUEST, ADMIN);
    await vi.waitFor(() => {
      expect(changes.slice(before)).toContainEqual({ projectId: P_RAW, userId: GUEST });
    });
  });
});

describe("stopping", () => {
  it("delivers nothing and fails the probe once stopped", async () => {
    await listener.stop();
    const before = changes.length;
    await pgClient`insert into project_members (project_id, user_id, role) values (${P_RAW}, ${LEAVER}, 'viewer')`;
    expect(await probeMemberListen(500)).toBe(false);
    expect(changes.length).toBe(before);
  });
});
