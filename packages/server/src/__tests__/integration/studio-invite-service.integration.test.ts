// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test: studioInvite.service handshake against real PostgreSQL.
 *
 * The critical path (studio membership + auth). What this pins beyond the repo
 * tests:
 *   - the AUTH INVARIANT: a pending invitee is NOT a studio member — studio
 *     role resolution returns null until they confirm (no membership leak)
 *   - confirmInvite's full transaction: accept CAS + upsert membership + notify
 *     the inviting admin, applied EXACTLY ONCE under concurrency
 *   - createInvite validation (unregistered email, already-member, re-invite,
 *     personal studio) mapping to typed errors
 *   - decline / revoke leave membership untouched
 *
 * @see packages/server/src/modules/studio/studioInvite.service.ts
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
  inject,
} from "vitest";

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

import { eq, and, isNull } from "drizzle-orm";
import { initCore, schema, createTestDb } from "@breatic/core";
import { NotFoundError, ConflictError, ForbiddenError } from "@breatic/core";

initCore(process.env);

import { studioMembersRepo } from "@breatic/domain";
import * as inviteService from "../../modules/studio/studioInvite.service.js";
import * as invitesRepo from "../../modules/studio/studioInvitations.repo.js";

declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
  }
}

const INVITER = "00000000-0000-0000-0000-0000000b0001";
const INVITEE = "00000000-0000-0000-0000-0000000b0002";
const STRANGER = "00000000-0000-0000-0000-0000000b0003";
const TEAM = "00000000-0000-0000-0000-0000000b0010";
const PERSONAL = "00000000-0000-0000-0000-0000000b0011";
const INVITEE_EMAIL = "invitee@svc-test.dev";

let pgClient: ReturnType<typeof createTestDb>["client"];
let db: ReturnType<typeof createTestDb>["db"];

beforeAll(async () => {
  const t = createTestDb(inject("DATABASE_URL"));
  db = t.db;
  pgClient = t.client;

  await db.insert(schema.users).values([
    { id: INVITER, email: "inviter@svc-test.dev" },
    { id: INVITEE, email: INVITEE_EMAIL },
    { id: STRANGER, email: "stranger@svc-test.dev" },
  ]);
  await db.insert(schema.studios).values([
    { createdByUserId: INVITER, slug: "svc-inviter", type: "personal", name: "Inviter" },
    { createdByUserId: INVITEE, slug: "svc-invitee", type: "personal", name: "Invitee" },
    { id: TEAM, createdByUserId: INVITER, slug: "svc-team", type: "team", name: "Svc Team" },
    { id: PERSONAL, createdByUserId: STRANGER, slug: "svc-personal", type: "personal", name: "Stranger" },
  ]);
  // The inviter is the team studio's admin (fixture, never cleaned).
  await db
    .insert(schema.studioMembers)
    .values({ studioId: TEAM, userId: INVITER, role: "admin" });
});

afterAll(async () => {
  await pgClient.end();
});

beforeEach(async () => {
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- intentional whole-table reset between tests
  await db.delete(schema.studioInvitations);
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- intentional whole-table reset between tests
  await db.delete(schema.notifications);
  // Drop any membership the invitee gained in a prior test (keep the admin).
  await db
    .delete(schema.studioMembers)
    .where(eq(schema.studioMembers.userId, INVITEE));
});

/** Count the invitee's ACTIVE membership rows in the team studio. */
async function inviteeMemberRows(): Promise<number> {
  const rows = await db
    .select({ userId: schema.studioMembers.userId })
    .from(schema.studioMembers)
    .where(
      and(
        eq(schema.studioMembers.studioId, TEAM),
        eq(schema.studioMembers.userId, INVITEE),
        isNull(schema.studioMembers.deletedAt),
      ),
    );
  return rows.length;
}

describe("createInvite", () => {
  it("creates a pending invite WITHOUT making the invitee a member (auth invariant)", async () => {
    await inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "member");

    // The invitee shows up as pending…
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(1);
    // …but is NOT a studio member yet — role resolution returns null.
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBeNull();
    expect(await inviteeMemberRows()).toBe(0);
  });

  it("rejects an unregistered email with NotFound", async () => {
    await expect(
      inviteService.createInvite("svc-team", INVITER, "nobody@svc-test.dev", "member"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects inviting an already-active member with Conflict", async () => {
    await db
      .insert(schema.studioMembers)
      .values({ studioId: TEAM, userId: INVITEE, role: "member", addedBy: INVITER });

    await expect(
      inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "member"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a duplicate live pending with Conflict", async () => {
    await inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "member");
    await expect(
      inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "creator"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to invite into a personal studio (Forbidden)", async () => {
    await expect(
      inviteService.createInvite("svc-personal", STRANGER, INVITEE_EMAIL, "member"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("confirmInvite", () => {
  it("turns a pending invite into a real membership + notifies the admin", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "creator",
    );

    await inviteService.confirmInvite(invitationId, INVITEE);

    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBe("creator");
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(0);
    // The inviting admin gets a studio.invite_accepted notice.
    const adminNotices = await db
      .select({ type: schema.notifications.type })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, INVITER),
          eq(schema.notifications.type, "studio.invite_accepted"),
        ),
      );
    expect(adminNotices).toHaveLength(1);
  });

  it("under concurrency, exactly one confirm wins; the invitee gets ONE membership", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "member",
    );

    const results = await Promise.allSettled([
      inviteService.confirmInvite(invitationId, INVITEE),
      inviteService.confirmInvite(invitationId, INVITEE),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBe("member");
    expect(await inviteeMemberRows()).toBe(1);
  });

  it("refuses confirm on behalf of another user (stays pending, no membership)", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "member",
    );

    await expect(
      inviteService.confirmInvite(invitationId, STRANGER),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBeNull();
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(1);
  });
});

describe("declineInvite / revokeInvite", () => {
  it("decline leaves membership untouched and clears the pending", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "member",
    );

    await inviteService.declineInvite(invitationId, INVITEE);

    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBeNull();
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(0);
  });

  it("admin revoke clears the pending; the invitee never became a member", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "member",
    );

    await inviteService.revokeInvite("svc-team", invitationId);

    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(0);
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBeNull();
  });
});
