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

// The decision window comes from the same config file. Pinned here to a value
// that is deliberately NOT the shipped seven: the invite deadline, the token
// TTL and the number the landing page prints are all supposed to come from the
// configured window, and anything that carries its own copy of 7 would pass
// against a mock that also said 7.
const decisionWindow = vi.hoisted(() => ({ days: 3 }));
vi.mock("@server/config/limits.js", () => ({
  getDecisionWindowDays: () => decisionWindow.days,
  getDecisionWindowMs: () => decisionWindow.days * 24 * 60 * 60 * 1000,
  getDecisionWindowSeconds: () => decisionWindow.days * 24 * 60 * 60,
}));

import { eq, and, inArray, isNull, sql } from "drizzle-orm";
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
    // On `pro` because these cases are not about the ceiling. `base` allows a
    // single studio member — the admin's own seat — so a base fixture here
    // would have every invite in the file refused for running out of room
    // rather than for the reason each case is about. (A base account CAN end
    // up administering a team studio: neither transfer nor a downgrade checks
    // the tier. It just cannot invite anyone once there.)
    { id: INVITER, email: "inviter@svc-test.dev", membershipTier: "pro" },
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
  // Drop any membership the invitee / stranger gained in a prior test (keep the admin).
  await db
    .delete(schema.studioMembers)
    .where(inArray(schema.studioMembers.userId, [INVITEE, STRANGER]));
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
    await inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "guest");

    // The invitee shows up as pending…
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(1);
    // …but is NOT a studio member yet — role resolution returns null.
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBeNull();
    expect(await inviteeMemberRows()).toBe(0);

    // The bell payload carries the inviter's identity (name + @handle) + the
    // studio slug, so the row renders "[Inviter] invited you to [Svc Team]"
    // with both the inviter name and the studio name clickable.
    const [reqNotif] = await db
      .select({ payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, INVITEE),
          eq(schema.notifications.type, "studio.invite_request"),
        ),
      );
    expect(reqNotif?.payload).toMatchObject({
      inviterName: "Inviter",
      studioName: "Svc Team",
    });
    // Ids, not names: the @handle and slug are resolved at read time.
    expect(reqNotif?.payload).toHaveProperty("inviterUserId");
    expect(reqNotif?.payload).toHaveProperty("studioId");
    expect(reqNotif?.payload).not.toHaveProperty("inviterHandle");
    expect(reqNotif?.payload).not.toHaveProperty("studioSlug");
  });

  it("rejects an unregistered email with NotFound", async () => {
    await expect(
      inviteService.createInvite("svc-team", INVITER, "nobody@svc-test.dev", "guest"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects inviting an already-active member with Conflict", async () => {
    await db
      .insert(schema.studioMembers)
      .values({ studioId: TEAM, userId: INVITEE, role: "guest", addedBy: INVITER });

    await expect(
      inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "guest"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a duplicate live pending with Conflict", async () => {
    await inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "guest");
    await expect(
      inviteService.createInvite("svc-team", INVITER, INVITEE_EMAIL, "maintainer"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("an EXPIRED pending must not block a re-invite (#1769)", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "guest",
    );
    // The invite times out unaccepted: expires_at moves to the past while status
    // stays 'pending' (every read path treats it as void, but the one-pending
    // partial index ignores expiry) → re-invite must still succeed.
    await db
      .update(schema.studioInvitations)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.studioInvitations.id, invitationId));
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(0);

    const again = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "maintainer",
    );
    expect(again.invitationId).toBeTruthy();
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(1);
  });

  it("refuses to invite into a personal studio (Forbidden)", async () => {
    await expect(
      inviteService.createInvite("svc-personal", STRANGER, INVITEE_EMAIL, "guest"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("confirmInvite", () => {
  it("turns a pending invite into a real membership + notifies the admin", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "maintainer",
    );

    await inviteService.confirmInvite(invitationId, INVITEE);

    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBe("maintainer");
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(0);
    // The inviting admin gets a studio.invite_accepted notice carrying the
    // invitee's identity (name + @handle) + the studio slug.
    const adminNotices = await db
      .select({
        type: schema.notifications.type,
        payload: schema.notifications.payload,
      })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, INVITER),
          eq(schema.notifications.type, "studio.invite_accepted"),
        ),
      );
    expect(adminNotices).toHaveLength(1);
    expect(adminNotices[0]?.payload).toMatchObject({
      inviteeName: "Invitee",
      studioName: "Svc Team",
    });
    expect(adminNotices[0]?.payload).toHaveProperty("inviteeUserId");
    expect(adminNotices[0]?.payload).toHaveProperty("studioId");
    expect(adminNotices[0]?.payload).not.toHaveProperty("inviteeHandle");
  });

  it("under concurrency, exactly one confirm wins; the invitee gets ONE membership", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "guest",
    );

    const results = await Promise.allSettled([
      inviteService.confirmInvite(invitationId, INVITEE),
      inviteService.confirmInvite(invitationId, INVITEE),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBe("guest");
    expect(await inviteeMemberRows()).toBe(1);
  });

  it("refuses confirm on behalf of another user (stays pending, no membership)", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "guest",
    );

    await expect(
      inviteService.confirmInvite(invitationId, STRANGER),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBeNull();
    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(1);
  });
});

describe("declineInvite / revokeInvite", () => {
  it("refuses to decline an EXPIRED invite (past the window there is no decision left)", async () => {
    // The repo-level CAS is covered in studio-invitations.integration.test; this
    // pins the service the route actually calls, so the NotFound the invitee
    // receives is asserted at the layer that produces their HTTP status.
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "guest",
    );
    await db
      .update(schema.studioInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.studioInvitations.id, invitationId));

    await expect(
      inviteService.declineInvite(invitationId, INVITEE),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await db
      .select({ status: schema.studioInvitations.status })
      .from(schema.studioInvitations)
      .where(eq(schema.studioInvitations.id, invitationId));
    expect(row?.status).toBe("pending");
  });

  it("decline leaves membership untouched and clears the pending", async () => {
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "guest",
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
      "guest",
    );

    await inviteService.revokeInvite("svc-team", invitationId);

    expect(await invitesRepo.listPendingByStudio(TEAM)).toHaveLength(0);
    expect(await studioMembersRepo.getRole(TEAM, INVITEE)).toBeNull();
  });
});

// The member ceiling itself moved to config/membership.yaml, keyed by the
// tier of the studio's current admin (task #87). Its cases — both check
// points, the copy each reader gets, concurrency, and a confirm against a
// deleted studio — live in `member-quota.integration.test.ts`, which can seed
// accounts on chosen tiers. What stays here is the handshake.

describe("the deadline the window actually enforces", () => {
  it("stamps the row deadline from the configured window, not a number of its own", async () => {
    // The landing page reads this row to say how long the invitee had. A getter
    // returning the wrong unit — or zero — would leave every other test in this
    // file green, so the deadline is measured rather than assumed.
    //
    // The Redis token half of this test went with the mechanism: a link no
    // longer carries a one-time token that expires on its own, it carries the
    // request's permanent share token and the ROW is what expires.
    const { invitationId } = await inviteService.createInvite(
      "svc-team",
      INVITER,
      INVITEE_EMAIL,
      "guest",
    );
    const windowMs = decisionWindow.days * 24 * 60 * 60 * 1000;

    const [row] = await db
      .select({ expiresAt: schema.studioInvitations.expiresAt })
      .from(schema.studioInvitations)
      .where(eq(schema.studioInvitations.id, invitationId));
    const aheadMs = row!.expiresAt.getTime() - Date.now();
    expect(aheadMs).toBeLessThanOrEqual(windowMs);
    expect(aheadMs).toBeGreaterThan(windowMs - 60_000);
  });
});
