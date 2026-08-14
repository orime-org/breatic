// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test: projectInvite.service handshake against real PostgreSQL +
 * Redis. The critical path (project membership + auth, #1337). The direct
 * mirror of studio-invite-service.integration.test.
 *
 * What this pins beyond the repo:
 *   - the AUTH INVARIANT: a pending invitee is NOT a project member — project
 *     role resolution (`loadProjectRole`) returns null until they confirm (no
 *     membership leak), and the pending row never shows in the member list.
 *   - confirmInvite's full transaction: accept CAS + upsert membership + notify
 *     the inviting owner, applied EXACTLY ONCE under concurrency (property-based
 *     over N concurrent confirmers — the bell + email-link / double-click race).
 *   - createInvite validation (unregistered email, already-member, re-invite,
 *     owner role rejected) mapping to typed errors.
 *   - decline / revoke leave membership untouched.
 *   - an EXPIRED pending invite cannot be confirmed.
 *   - the Redis email-link token round-trip (peek / respond / consume).
 *
 * @see packages/server/src/modules/project-invite/projectInvite.service.ts
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
import fc from "fast-check";

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

import { eq, and, isNull, sql } from "drizzle-orm";
import {
  initCore,
  getMembershipLimits,
  schema,
  createTestDb,
  projectMembersRepo,
} from "@breatic/core";
import { NotFoundError, ConflictError } from "@breatic/core";

initCore(process.env);

import * as inviteService from "../../modules/project-invite/projectInvite.service.js";
import * as invitesRepo from "../../modules/project-invite/projectInvitations.repo.js";
import * as membersService from "../../modules/project/projectMembers.service.js";

declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
  }
}

const OWNER = "00000000-0000-0000-0000-0000000c0001";
const INVITEE = "00000000-0000-0000-0000-0000000c0002";
const STRANGER = "00000000-0000-0000-0000-0000000c0003";
const STUDIO = "00000000-0000-0000-0000-0000000c0010";
const PROJECT = "00000000-0000-0000-0000-0000000c0020";
const INVITEE_EMAIL = "invitee@proj-test.dev";

let pgClient: ReturnType<typeof createTestDb>["client"];
let db: ReturnType<typeof createTestDb>["db"];

beforeAll(async () => {
  const t = createTestDb(inject("DATABASE_URL"));
  db = t.db;
  pgClient = t.client;

  await db.insert(schema.users).values([
    // On `pro` because these cases are not about the ceiling: this account
    // administers the studio these projects live in, and both ceilings are read
    // from its tier. Kept level with the studio suite's fixture so that adding
    // a case here later cannot quietly start failing on base's four.
    { id: OWNER, email: "owner@proj-test.dev", membershipTier: "pro" },
    { id: INVITEE, email: INVITEE_EMAIL },
    { id: STRANGER, email: "stranger@proj-test.dev" },
  ]);
  // Personal studios supply the display names the invite payload reads.
  await db.insert(schema.studios).values([
    { id: STUDIO, createdByUserId: OWNER, slug: "proj-owner", type: "personal", name: "Owner" },
    { createdByUserId: INVITEE, slug: "proj-invitee", type: "personal", name: "Invitee" },
    { createdByUserId: STRANGER, slug: "proj-stranger", type: "personal", name: "Stranger" },
  ]);
  // The collaborator ceiling is read through the `admin` row of the studio a
  // project lives in, so the studio holding this fixture's project needs one.
  // The other two studios above are only there to supply display names and are
  // left without one — nothing in these cases resolves a ceiling through them.
  await db.insert(schema.studioMembers).values({
    studioId: STUDIO,
    userId: OWNER,
    role: "admin",
  });
  await db.insert(schema.projects).values({
    id: PROJECT,
    studioId: STUDIO,
    createdByUserId: OWNER,
    name: "Test Project",
    slug: "test-project",
    visibility: "private",
  });
  // The owner's project_members row (fixture, never cleaned).
  await db.insert(schema.projectMembers).values({
    projectId: PROJECT,
    userId: OWNER,
    role: "owner",
    addedBy: null,
  });
});

afterAll(async () => {
  await pgClient.end();
});

beforeEach(async () => {
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- intentional whole-table reset between tests
  await db.delete(schema.projectInvitations);
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- intentional whole-table reset between tests
  await db.delete(schema.notifications);
  // Drop any membership the invitee/stranger gained in a prior test (keep owner).
  await db
    .delete(schema.projectMembers)
    .where(eq(schema.projectMembers.userId, INVITEE));
  await db
    .delete(schema.projectMembers)
    .where(eq(schema.projectMembers.userId, STRANGER));
});

/** Count the invitee's ACTIVE membership rows on the project. */
async function inviteeMemberRows(): Promise<number> {
  const rows = await db
    .select({ userId: schema.projectMembers.userId })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, PROJECT),
        eq(schema.projectMembers.userId, INVITEE),
        isNull(schema.projectMembers.deletedAt),
      ),
    );
  return rows.length;
}

/** Count the project's ACTIVE members (auth-relevant member count). */
async function activeMemberCount(): Promise<number> {
  const rows = await db
    .select({ userId: schema.projectMembers.userId })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, PROJECT),
        isNull(schema.projectMembers.deletedAt),
      ),
    );
  return rows.length;
}

describe("createInvite", () => {
  it("creates a pending invite WITHOUT making the invitee a member (auth invariant)", async () => {
    await inviteService.createInvite(PROJECT, OWNER, INVITEE_EMAIL, "editor");

    // The invitee shows up as pending…
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(1);
    // …but is NOT a project member yet — role resolution returns null.
    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBeNull();
    expect(await inviteeMemberRows()).toBe(0);
    // …and the member count is unchanged (only the owner is a member).
    expect(await activeMemberCount()).toBe(1);
  });

  it("creates the actionable bell notification + links it to the invite", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "viewer",
    );

    const notices = await db
      .select({
        id: schema.notifications.id,
        type: schema.notifications.type,
        userId: schema.notifications.userId,
        expiresAt: schema.notifications.expiresAt,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, INVITEE));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.type).toBe("project.invite_request");
    expect(notices[0]?.expiresAt).not.toBeNull();

    // The invitation row links back to that notification.
    const linked = await db
      .select({ notificationId: schema.projectInvitations.notificationId })
      .from(schema.projectInvitations)
      .where(eq(schema.projectInvitations.id, invitationId));
    expect(linked[0]?.notificationId).toBe(notices[0]?.id);
  });

  it("returns a usable email-link token + carries it in the bell payload (single token, three channels)", async () => {
    // The project invite diverges from studio: all three channels (copy URL,
    // bell, email) funnel through the SAME landing page, so the token is minted
    // inside createInvite — returned to the caller (the route surfaces it as the
    // copyable URL + the email link) AND embedded in the notification payload
    // (so the bell can build the same `/decision?token=` link).
    const result = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "viewer",
    );

    // The token the owner's copyable link is built from.
    expect(result.shareToken).toMatch(/^[0-9a-f]{64}$/);

    // The bell payload carries the SAME token.
    const notices = await db
      .select({ payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, INVITEE));
    const payload = notices[0]?.payload as Record<string, unknown>;
    expect(payload.shareToken).toBe(result.shareToken);
    // …and the inviter's identity (name + @handle) for the actor-first bell row
    // ("[Owner] invited you to [Test Project]", the name clickable to the studio).
    expect(payload).toMatchObject({ inviterName: "Owner" });
    // Ids, not names: the @handle and slug are resolved at read time.
    expect(payload).toHaveProperty("inviterUserId");
    expect(payload).toHaveProperty("projectId");
    expect(payload).not.toHaveProperty("inviterHandle");
    expect(payload).not.toHaveProperty("projectSlug");
  });

  it("rejects an unregistered email with NotFound", async () => {
    await expect(
      inviteService.createInvite(PROJECT, OWNER, "nobody@proj-test.dev", "editor"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects inviting a user who already has project access with Conflict", async () => {
    await db.insert(schema.projectMembers).values({
      projectId: PROJECT,
      userId: INVITEE,
      role: "viewer",
      addedBy: OWNER,
    });

    await expect(
      inviteService.createInvite(PROJECT, OWNER, INVITEE_EMAIL, "editor"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a duplicate live pending with Conflict", async () => {
    await inviteService.createInvite(PROJECT, OWNER, INVITEE_EMAIL, "editor");
    await expect(
      inviteService.createInvite(PROJECT, OWNER, INVITEE_EMAIL, "viewer"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a missing project with NotFound", async () => {
    await expect(
      inviteService.createInvite(
        "00000000-0000-0000-0000-00000000dead",
        OWNER,
        INVITEE_EMAIL,
        "editor",
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("confirmInvite", () => {
  it("turns a pending invite into a real membership + notifies the owner", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );

    await inviteService.confirmInvite(invitationId, INVITEE);

    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBe("editor");
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(0);
    // The inviting owner gets a project.invite_accepted notice carrying the
    // invitee's identity (name + @handle) for the actor-first bell row.
    const ownerNotices = await db
      .select({
        type: schema.notifications.type,
        payload: schema.notifications.payload,
      })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, OWNER),
          eq(schema.notifications.type, "project.invite_accepted"),
        ),
      );
    expect(ownerNotices).toHaveLength(1);
    expect(ownerNotices[0]?.payload).toMatchObject({ inviteeName: "Invitee" });
    expect(ownerNotices[0]?.payload).toHaveProperty("inviteeUserId");
    expect(ownerNotices[0]?.payload).toHaveProperty("projectId");
    expect(ownerNotices[0]?.payload).not.toHaveProperty("inviteeHandle");
    // The invitee's bell notification is marked read.
    const inviteeUnread = await db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, INVITEE),
          isNull(schema.notifications.readAt),
        ),
      );
    expect(inviteeUnread).toHaveLength(0);
  });

  it("under concurrency, exactly one confirm wins per N confirmers (CAS invariant)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (n) => {
        // Reset between property runs.
        // eslint-disable-next-line drizzle/enforce-delete-with-where -- whole-table reset
        await db.delete(schema.projectInvitations);
        // eslint-disable-next-line drizzle/enforce-delete-with-where -- whole-table reset
        await db.delete(schema.notifications);
        await db
          .delete(schema.projectMembers)
          .where(eq(schema.projectMembers.userId, INVITEE));

        const { invitationId } = await inviteService.createInvite(
          PROJECT,
          OWNER,
          INVITEE_EMAIL,
          "viewer",
        );

        const results = await Promise.allSettled(
          Array.from({ length: n }, () =>
            inviteService.confirmInvite(invitationId, INVITEE),
          ),
        );

        // Exactly one confirm succeeds; the invitee gets exactly ONE membership.
        expect(
          results.filter((r) => r.status === "fulfilled"),
        ).toHaveLength(1);
        expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBe(
          "viewer",
        );
        expect(await inviteeMemberRows()).toBe(1);
      }),
      { numRuns: 8 },
    );
  });

  it("refuses confirm on behalf of another user (stays pending, no membership)", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );

    await expect(
      inviteService.confirmInvite(invitationId, STRANGER),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBeNull();
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(1);
  });

  it("refuses to confirm an EXPIRED pending invite (no membership)", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );
    // Force the invite past its window.
    await db
      .update(schema.projectInvitations)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.projectInvitations.id, invitationId));

    await expect(
      inviteService.confirmInvite(invitationId, INVITEE),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBeNull();
  });
});

describe("declineInvite / revokeInvite", () => {
  it("the decline CAS itself refuses an expired row (repo layer)", async () => {
    // The service test below covers the error the route returns; this covers
    // the predicate that produces it, so neither layer can lose the guard
    // without a red test. Mirror of the studio repo test.
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "viewer",
    );
    await db
      .update(schema.projectInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.projectInvitations.id, invitationId));

    expect(await invitesRepo.declineIfPending(invitationId, INVITEE)).toBeNull();
  });

  it("refuses to decline an EXPIRED invite (past the window there is no decision left)", async () => {
    // Expiry closes the invite outright: it is not "you may still say no".
    // The decline CAS carries the same not-expired predicate as the accept CAS,
    // so both answers stop at the same instant and the row stays 'pending'
    // rather than acquiring a decision it was too late to make.
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );
    await db
      .update(schema.projectInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.projectInvitations.id, invitationId));

    await expect(
      inviteService.declineInvite(invitationId, INVITEE),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await db
      .select({ status: schema.projectInvitations.status })
      .from(schema.projectInvitations)
      .where(eq(schema.projectInvitations.id, invitationId));
    expect(row?.status).toBe("pending");
  });

  it("decline leaves membership untouched and clears the pending", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );

    await inviteService.declineInvite(invitationId, INVITEE);

    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBeNull();
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(0);
    expect(await activeMemberCount()).toBe(1);
  });

  it("owner revoke clears the pending; the invitee never became a member", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );

    await inviteService.revokeInvite(PROJECT, invitationId);

    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(0);
    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBeNull();
  });

  it("revoke is scoped to the project — a wrong project id matches nothing", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );

    await expect(
      inviteService.revokeInvite(
        "00000000-0000-0000-0000-00000000beef",
        invitationId,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The invite is still live.
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(1);
  });
});

describe("re-invite lifecycle (#1769)", () => {
  it("accept → remove → re-invite SUCCEEDS (a removed member can be re-invited)", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );
    await inviteService.confirmInvite(invitationId, INVITEE);
    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBe("editor");

    await membersService.remove(PROJECT, INVITEE, OWNER);
    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBeNull();

    // Re-inviting the removed user must be allowed — a fresh pending invite.
    const again = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "viewer",
    );
    expect(again.invitationId).toBeTruthy();
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(1);
  });

  it("EXPIRED pending must not block a re-invite (#1769 root cause)", async () => {
    const { invitationId } = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );
    // The invite is never accepted and times out: expires_at moves to the past
    // while status stays 'pending' (no sweep flips expired pendings). Every read
    // path (listPending / accept CAS / landing) treats it as void…
    await db
      .update(schema.projectInvitations)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.projectInvitations.id, invitationId));
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(0);

    // …so re-inviting must succeed. Today it throws ConflictError because the
    // `project_invitations_one_pending` partial unique index keys on
    // status='pending' only and ignores expires_at.
    const again = await inviteService.createInvite(
      PROJECT,
      OWNER,
      INVITEE_EMAIL,
      "editor",
    );
    expect(again.invitationId).toBeTruthy();
    expect(await invitesRepo.listPendingByProject(PROJECT)).toHaveLength(1);
  });
});

// The collaborator ceiling itself moved to config/membership.yaml, keyed by
// the tier of the admin of the studio this project lives in (task #87). Its
// cases — both check points, the copy each reader gets, concurrency, and a
// confirm against a deleted project — live in
// `member-quota.integration.test.ts`, which can seed accounts on chosen tiers.
// What stays here is the invariant that the ceiling must never touch: open
// baseline access.
describe("open baseline is never gated by the collaborator ceiling", () => {
  it("INVARIANT: a baseline viewer materializes even at cap and is NOT counted (open baseline never blocked)", async () => {
    // Fill the explicit roster to this studio admin's real ceiling. Reading it
    // from the shipped config rather than pinning a number keeps the case
    // honest if the tier's numbers are ever retuned.
    const ceiling = getMembershipLimits("pro").project_members;
    for (let i = 0; i < ceiling; i++) {
      const [filler] = await db
        .insert(schema.users)
        .values({ email: `baseline-filler-${i}@svc-test.dev` })
        .returning({ id: schema.users.id });
      await db.insert(schema.projectMembers).values({
        projectId: PROJECT,
        userId: filler!.id,
        role: "editor",
        addedBy: OWNER,
      });
    }
    expect(await projectMembersRepo.countExplicitMembers(PROJECT)).toBe(ceiling);

    // A studio member opening the project auto-materializes as a baseline viewer
    // (addedBy null). Even with the cap full, this MUST succeed — open-baseline
    // viewing access is never gated by the collaborator cap.
    await projectMembersRepo.materializeBaselineViewer(PROJECT, INVITEE);

    expect(await projectMembersRepo.getRole(PROJECT, INVITEE)).toBe("viewer");
    // …and the auto-viewer does NOT consume ceiling budget — the explicit count
    // is unchanged, proving baseline viewers are exempt.
    expect(await projectMembersRepo.countExplicitMembers(PROJECT)).toBe(ceiling);
  });
});
