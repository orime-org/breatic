// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test: studioInvitations.repo against real PostgreSQL.
 *
 * The studio invite-confirm handshake's data layer (2026-06-14). What this
 * catches that unit tests can't:
 *   - the `studio_invitations_one_pending` partial unique (a second LIVE
 *     pending for the same studio+invitee must 23505)
 *   - the accept CAS under CONCURRENCY (two confirms race → exactly one wins)
 *   - the `invited_user_id` / `studio_id` guards on accept / decline / revoke
 *   - expired pendings self-voiding (accept of a past-TTL invite → null)
 *   - re-invite after decline (partial unique only blocks LIVE pendings)
 *
 * @see packages/server/src/modules/studio/studioInvitations.repo.ts
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

// `ai` (Vercel AI SDK) pulls @opentelemetry/api whose ESM build crashes the
// vitest loader — mock it before importing the real @breatic/core barrel.
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

import { initCore, schema, createTestDb } from "@breatic/core";

initCore(process.env);

import * as invitesRepo from "../../modules/studio/studioInvitations.repo.js";

declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
  }
}

// Fixture IDs — inserted once, reused across tests.
const INVITER = "00000000-0000-0000-0000-0000000a0001";
const INVITEE = "00000000-0000-0000-0000-0000000a0002";
const STRANGER = "00000000-0000-0000-0000-0000000a0003";
const TEAM_STUDIO = "00000000-0000-0000-0000-0000000a0010";
const OTHER_STUDIO = "00000000-0000-0000-0000-0000000a0011";

let pgClient: ReturnType<typeof createTestDb>["client"];
let db: ReturnType<typeof createTestDb>["db"];

/** 7 days out — the standard live-pending window. */
function future(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

beforeAll(async () => {
  const t = createTestDb(inject("DATABASE_URL"));
  db = t.db;
  pgClient = t.client;

  await db.insert(schema.users).values([
    { id: INVITER, email: "inviter@invite-test.dev" },
    { id: INVITEE, email: "invitee@invite-test.dev" },
    { id: STRANGER, email: "stranger@invite-test.dev" },
  ]);
  // Personal studios supply the display names the list join reads; the team +
  // other studios are the invite targets / guard counter-example.
  await db.insert(schema.studios).values([
    {
      createdByUserId: INVITER,
      slug: "inviter-handle",
      type: "personal",
      name: "Inviter Name",
    },
    {
      createdByUserId: INVITEE,
      slug: "invitee-handle",
      type: "personal",
      name: "Invitee Name",
    },
    { id: TEAM_STUDIO, createdByUserId: INVITER, slug: "team-x", type: "team", name: "Team X" },
    { id: OTHER_STUDIO, createdByUserId: STRANGER, slug: "other-x", type: "team", name: "Other X" },
  ]);
});

afterAll(async () => {
  await pgClient.end();
});

beforeEach(async () => {
  // Each test starts from a clean invitations table (fixtures persist).
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- intentional whole-table reset between tests
  await db.delete(schema.studioInvitations);
});

describe("createPending + listPendingByStudio", () => {
  it("creates a pending invite and surfaces it with display fields", async () => {
    await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    const pending = await invitesRepo.listPendingByStudio(TEAM_STUDIO);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      invitedUserId: INVITEE,
      name: "Invitee Name",
      email: "invitee@invite-test.dev",
      role: "guest",
      invitedByName: "Inviter Name",
    });
  });

  it("rejects a second LIVE pending for the same (studio, invitee) — partial unique", async () => {
    await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    // drizzle 0.45 wraps the PG error in a DrizzleQueryError; the 23505 SQLSTATE
    // lives on `.cause` (the original postgres error), NOT the top level — the
    // service's isUniqueViolation walks the cause chain for exactly this reason.
    await expect(
      invitesRepo.createPending({
        studioId: TEAM_STUDIO,
        invitedUserId: INVITEE,
        role: "maintainer",
        invitedBy: INVITER,
        expiresAt: future(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows a pending in a DIFFERENT studio for the same invitee", async () => {
    await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });
    await invitesRepo.createPending({
      studioId: OTHER_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: STRANGER,
      expiresAt: future(),
    });

    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(1);
    expect(await invitesRepo.listPendingByStudio(OTHER_STUDIO)).toHaveLength(1);
  });
});

describe("acceptIfPending (CAS)", () => {
  it("accepts a live pending and returns its membership fields", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "maintainer",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    const accepted = await invitesRepo.acceptIfPending(id, INVITEE);

    expect(accepted).toMatchObject({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "maintainer",
      invitedBy: INVITER,
    });
    // No longer pending → leaves the list.
    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(0);
  });

  it("returns null on a second accept (already decided)", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });
    await invitesRepo.acceptIfPending(id, INVITEE);

    expect(await invitesRepo.acceptIfPending(id, INVITEE)).toBeNull();
  });

  it("under concurrency, exactly one of two simultaneous accepts wins", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    const [a, b] = await Promise.all([
      invitesRepo.acceptIfPending(id, INVITEE),
      invitesRepo.acceptIfPending(id, INVITEE),
    ]);

    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it("refuses to accept on behalf of another user (invited_user_id guard)", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    expect(await invitesRepo.acceptIfPending(id, STRANGER)).toBeNull();
    // Still pending — the wrong-user attempt did not consume it.
    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(1);
  });

  it("returns null when accepting an EXPIRED pending (self-void)", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await invitesRepo.acceptIfPending(id, INVITEE)).toBeNull();
    // Expired pendings are hidden from the list too.
    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(0);
  });
});

describe("declineIfPending / revokeIfPending", () => {
  it("declines a live pending (own invite); membership untouched; leaves list", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    const declined = await invitesRepo.declineIfPending(id, INVITEE);

    expect(declined).toEqual({ notificationId: null });
    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(0);
  });

  it("refuses decline on behalf of another user", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    expect(await invitesRepo.declineIfPending(id, STRANGER)).toBeNull();
  });

  it("revokes a live pending in the admin's own studio", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    const revoked = await invitesRepo.revokeIfPending(id, TEAM_STUDIO);

    expect(revoked).toEqual({ notificationId: null, invitedUserId: INVITEE });
    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(0);
  });

  it("refuses to revoke an invite belonging to a different studio (studio_id guard)", async () => {
    const id = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    expect(await invitesRepo.revokeIfPending(id, OTHER_STUDIO)).toBeNull();
    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(1);
  });
});

describe("re-invite after a terminal outcome", () => {
  it("allows a fresh pending after the previous one was declined", async () => {
    const first = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "guest",
      invitedBy: INVITER,
      expiresAt: future(),
    });
    await invitesRepo.declineIfPending(first, INVITEE);

    // Partial unique only blocks a LIVE pending, so a re-invite succeeds.
    const second = await invitesRepo.createPending({
      studioId: TEAM_STUDIO,
      invitedUserId: INVITEE,
      role: "maintainer",
      invitedBy: INVITER,
      expiresAt: future(),
    });

    expect(second).not.toEqual(first);
    expect(await invitesRepo.listPendingByStudio(TEAM_STUDIO)).toHaveLength(1);
  });
});
