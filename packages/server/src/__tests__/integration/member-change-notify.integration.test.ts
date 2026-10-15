// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Integration test: every committed write to `project_members` reaches the
 * member-change listener (inner#911).
 *
 * The notification comes from a trigger on the table, so it does not depend on
 * which code path wrote the row. These cases write the table directly, through
 * a rolled-back transaction, and through the studio and project services that
 * write it.
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
  PROJECT_MEMBER_CHANGED_CHANNEL,
  type MemberChange,
  type MemberChangeListener,
} from "@breatic/core";

initCore(process.env);
loadLocales();

import * as studioMemberService from "../../modules/studio/studioMember.service.js";
import * as projectMembersService from "../../modules/project/projectMembers.service.js";
import * as roleUpgradeService from "../../modules/role-upgrade-request/roleUpgradeRequest.service.js";
import * as projectTransferService from "../../modules/project/projectTransfer.service.js";

const ADMIN = "00000000-0000-0000-0000-000000911001";
const MEMBER = "00000000-0000-0000-0000-000000911002";
const LEAVER = "00000000-0000-0000-0000-000000911003";
const GUEST = "00000000-0000-0000-0000-000000911004";
const ASKER = "00000000-0000-0000-0000-000000911005";
const HEIR = "00000000-0000-0000-0000-000000911006";
const TEAM = "00000000-0000-0000-0000-000000911010";
const P_ADMIN = "00000000-0000-0000-0000-000000911020";
const P_MEMBER = "00000000-0000-0000-0000-000000911021";
const P_LEAVER = "00000000-0000-0000-0000-000000911022";
const P_RAW = "00000000-0000-0000-0000-000000911023";
const P_HANDOVER = "00000000-0000-0000-0000-000000911024";
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
    { id: ASKER, email: "asker@c911.dev" },
    { id: HEIR, email: "heir@c911.dev" },
  ]);
  await db.insert(schema.studios).values({
    id: TEAM, createdByUserId: ADMIN, slug: TEAM_SLUG, type: "team", name: "C911",
  });
  await db.insert(schema.studioMembers).values([
    { studioId: TEAM, userId: ADMIN, role: "admin" },
    { studioId: TEAM, userId: MEMBER, role: "maintainer" },
    { studioId: TEAM, userId: LEAVER, role: "maintainer" },
    { studioId: TEAM, userId: ASKER, role: "maintainer" },
    { studioId: TEAM, userId: HEIR, role: "maintainer" },
  ]);
  await db.insert(schema.projects).values([
    { id: P_ADMIN, studioId: TEAM, createdByUserId: ADMIN, name: "Admin's", slug: "admins" },
    { id: P_MEMBER, studioId: TEAM, createdByUserId: MEMBER, name: "Member's", slug: "members" },
    { id: P_LEAVER, studioId: TEAM, createdByUserId: LEAVER, name: "Leaver's", slug: "leavers" },
    { id: P_RAW, studioId: TEAM, createdByUserId: ADMIN, name: "Raw", slug: "raw" },
    { id: P_HANDOVER, studioId: TEAM, createdByUserId: ADMIN, name: "Handover", slug: "handover" },
  ]);
  await db.insert(schema.projectMembers).values([
    { projectId: P_ADMIN, userId: ADMIN, role: "owner" },
    { projectId: P_ADMIN, userId: MEMBER, role: "editor" },
    { projectId: P_ADMIN, userId: LEAVER, role: "viewer" },
    { projectId: P_MEMBER, userId: MEMBER, role: "owner" },
    { projectId: P_LEAVER, userId: LEAVER, role: "owner" },
    { projectId: P_RAW, userId: ADMIN, role: "owner" },
    { projectId: P_RAW, userId: GUEST, role: "viewer" },
    { projectId: P_HANDOVER, userId: ADMIN, role: "owner" },
    { projectId: P_HANDOVER, userId: ASKER, role: "viewer" },
    { projectId: P_HANDOVER, userId: HEIR, role: "editor" },
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
    expect(await listener.probe(1000)).toBe(true);
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

  it("announces both the old and the new pair when a row's key changes", async () => {
    await pgClient`insert into project_members (project_id, user_id, role) values (${P_RAW}, ${MEMBER}, 'viewer')`;
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ projectId: P_RAW, userId: MEMBER }));
    const before = changes.length;
    await pgClient`update project_members set user_id = ${LEAVER} where project_id = ${P_RAW} and user_id = ${MEMBER}`;
    await vi.waitFor(() => expect(changes.length).toBe(before + 2));
    expect(changes.slice(before)).toEqual([
      { projectId: P_RAW, userId: MEMBER },
      { projectId: P_RAW, userId: LEAVER },
    ]);
    await pgClient`delete from project_members where project_id = ${P_RAW} and user_id = ${LEAVER}`;
  });

  it("hands a payload it cannot read to onInvalid", async () => {
    await db.execute(sql`select pg_notify(${PROJECT_MEMBER_CHANGED_CHANNEL}, 'not json')`);
    await vi.waitFor(() => expect(invalid).toContain("not json"));
  });
});

describe("the service write paths", () => {
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

  it("still announces a role changed inside a project", async () => {
    const before = changes.length;
    await projectMembersService.changeRole(P_HANDOVER, HEIR, "viewer", ADMIN);
    await projectMembersService.changeRole(P_HANDOVER, HEIR, "editor", ADMIN);
    await vi.waitFor(() => {
      expect(changes.slice(before).filter((c) => c.userId === HEIR && c.projectId === P_HANDOVER)).toHaveLength(2);
    });
  });

  it("announces a viewer whose upgrade request was approved", async () => {
    const { requestId } = await roleUpgradeService.request({
      requesterUserId: ASKER,
      projectId: P_HANDOVER,
      projectName: "Handover",
    });
    const before = changes.length;
    await roleUpgradeService.approve({ requestId, ownerUserId: ADMIN });
    await vi.waitFor(() => {
      expect(changes.slice(before)).toContainEqual({ projectId: P_HANDOVER, userId: ASKER });
    });
  });

  it("announces both owners of a confirmed project transfer", async () => {
    await projectTransferService.requestProjectTransfer(P_HANDOVER, ADMIN, HEIR);
    const [transfer] = await pgClient<{ id: string }[]>`
      select id from project_transfers where project_id = ${P_HANDOVER} and status = 'pending'`;
    const before = changes.length;
    await projectTransferService.confirmProjectTransfer(transfer!.id, HEIR);
    await vi.waitFor(() => {
      const fresh = changes.slice(before);
      expect(fresh).toContainEqual({ projectId: P_HANDOVER, userId: ADMIN });
      expect(fresh).toContainEqual({ projectId: P_HANDOVER, userId: HEIR });
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

describe("reconnecting", () => {
  it("starts listening again after the listen connection is killed, and hears changes after it", async () => {
    const listensBefore = listening;
    await pgClient`select pg_terminate_backend(pid) from pg_stat_activity
      where query ilike 'listen %' and pid <> pg_backend_pid()`;
    await vi.waitFor(() => expect(listening).toBe(listensBefore + 1), { timeout: 10_000 });
    expect(await listener.probe(1000)).toBe(true);
    await drain();
  });
});

describe("stopping", () => {
  /**
   * The backends currently running a LISTEN, other than this session.
   * @returns Their count.
   */
  async function listenBackends(): Promise<number> {
    const [row] = await pgClient<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
      where query ilike 'listen %' and pid <> pg_backend_pid()`;
    return row?.n ?? 0;
  }

  it("delivers nothing and fails the probe once stopped", async () => {
    await listener.stop();
    expect(await listener.probe(500)).toBe(false);

    // The stopped listener's connection still LISTENs. A second listener tells
    // when the notification has certainly been sent; by then the stopped one
    // has had it too, and must have dropped it.
    const seen: string[] = [];
    const other = await pgClient.listen(PROJECT_MEMBER_CHANGED_CHANNEL, (raw) => {
      seen.push(raw);
    });
    const before = changes.length;
    await pgClient`insert into project_members (project_id, user_id, role) values (${P_RAW}, ${ASKER}, 'viewer')`;
    await vi.waitFor(() => expect(seen.some((raw) => raw.includes(ASKER))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(changes.length).toBe(before);
    await other.unlisten();
  });

  it("does not report a restart once stopped", async () => {
    const listensBefore = listening;
    await pgClient`select pg_terminate_backend(pid) from pg_stat_activity
      where query ilike 'listen %' and pid <> pg_backend_pid()`;
    await vi.waitFor(async () => expect(await listenBackends()).toBe(0));
    // postgres.js re-listens on its own; once its backend is back, the restart
    // it would have reported has happened.
    await vi.waitFor(async () => expect(await listenBackends()).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listening).toBe(listensBefore);
  });
});
