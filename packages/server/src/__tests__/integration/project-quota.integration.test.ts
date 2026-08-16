// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How many projects one studio may hold (task #86, membership block two) —
 * real Postgres.
 *
 * The ceiling comes from `config/membership.yaml`, keyed by the tier of the
 * studio's CURRENT admin — not by the tier of whoever is doing the creating,
 * and not from any number written in code.
 *
 * Two things this suite exists to pin that a unit test cannot:
 *
 *   1. **Both entry points are gated.** `projects` has exactly two inserts,
 *      `createProject` and `duplicateProject`, and the second one puts the copy
 *      in the SAME studio. Gating only the first leaves the ceiling false while
 *      every other case here goes green.
 *   2. **The ceiling survives concurrency.** Counting rows and then inserting
 *      is not a decision when two transactions do it at once — both count, both
 *      see room, both insert. Block one measured this on a `pro` account: three
 *      simultaneous requests left two rows behind.
 *
 * The concurrency cases hold a row lock from a separate connection so the
 * interleaving is observed rather than hoped for. Written with `Promise.all`
 * instead they pass with the lock deleted, because two short transactions reuse
 * one pooled connection and simply run one after the other.
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
import type { ConfiguredMembershipTier } from "@breatic/shared";
import { initCore, loadLocales, getMembershipLimits } from "@breatic/core";
import { projectService } from "@server/modules";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
// Without this every refusal below reads `server.project.…` instead of a
// sentence, and the message case would be asserting the key, not the copy.
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "project-quota-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** That tier's project-per-studio ceiling, straight from the shipped config. */
function ceilingFor(tier: ConfiguredMembershipTier): number {
  return getMembershipLimits(tier).projects_per_studio;
}

/**
 * An account on a given tier.
 * @param tier - Membership tier stamped on the account.
 * @returns The new user's id.
 */
async function insertUser(tier: ConfiguredMembershipTier): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`pq-${seq++}@example.test`}, true, ${tier}) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * A studio whose current admin is `adminUserId`.
 * @param adminUserId - Who administers it (and therefore whose tier decides
 *   this studio's ceilings).
 * @param type - `personal` or `team`; irrelevant to the ceiling, which is why
 *   the default is fine for most cases.
 * @returns The studio id.
 */
async function insertStudio(
  adminUserId: string,
  type: "personal" | "team" = "team",
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${`pq-s-${seq++}`}, ${type}, 'Studio') RETURNING id
  `;
  const studioId = rows[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${adminUserId}, 'admin')
  `;
  return studioId;
}

/**
 * Put `n` live projects in a studio without going through the service.
 *
 * Seeding by SQL is deliberate: the cases below are about the gate, and a
 * seeder that itself passed through the gate could not set up the
 * at-the-ceiling state the gate is supposed to refuse.
 * @param studioId - Studio to fill.
 * @param creatorUserId - Stamped as `created_by_user_id`.
 * @param n - How many to insert.
 */
async function seedProjects(
  studioId: string,
  creatorUserId: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug)
      VALUES (${studioId}, ${creatorUserId}, 'Seed', ${`pq-p-${seq++}`})
    `;
  }
}

/**
 * One project created through the service, owned by the caller.
 * @param userId - Creator (becomes owner).
 * @param studioId - Studio it lands in.
 * @returns The new project's id.
 */
async function createProject(userId: string, studioId: string): Promise<string> {
  const p = await projectService.create(
    userId,
    studioId,
    "Project",
    `pq-c-${seq++}`,
    "studio",
    "canvas",
  );
  return p.id;
}

describe("project count per studio — the create path", () => {
  it("refuses the one past the ceiling", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    await seedProjects(studio, admin, ceilingFor("base"));

    await expect(createProject(admin, studio)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("allows the last one under the ceiling (the test is >=, not >)", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    await seedProjects(studio, admin, ceilingFor("base") - 1);

    const id = await createProject(admin, studio);
    expect(id).toBeTruthy();
  });

  it("reads the ceiling from the studio's admin, not from whoever is creating", async () => {
    // The load-bearing case for "the ceiling belongs to the studio". A
    // maintainer on the narrowest tier creating inside a studio administered by
    // a wide-tier account must get the WIDE ceiling — the studio's capacity is
    // paid for by whoever administers it.
    const admin = await insertUser("pro");
    const maintainer = await insertUser("base");
    const studio = await insertStudio(admin);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studio}, ${maintainer}, 'maintainer')
    `;
    // One past base's ceiling, far below pro's.
    await seedProjects(studio, admin, ceilingFor("base"));
    expect(ceilingFor("pro")).toBeGreaterThan(ceilingFor("base"));

    const id = await createProject(maintainer, studio);
    expect(id).toBeTruthy();
  });

  it("follows a transfer to the new admin", async () => {
    // Ownership is the current `admin` row, never the immutable
    // `created_by_user_id`, so a studio handed to a narrower account starts
    // being held to that account's ceiling immediately.
    const from = await insertUser("pro");
    const to = await insertUser("base");
    const studio = await insertStudio(from);
    await seedProjects(studio, from, ceilingFor("base"));
    // Under pro there is still room.
    await expect(createProject(from, studio)).resolves.toBeTruthy();

    // Same two writes the transfer service makes: demote, then promote.
    await sql`
      UPDATE studio_members SET role = 'maintainer'
      WHERE studio_id = ${studio} AND user_id = ${from}
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${studio}, ${to}, 'admin')
    `;

    await expect(createProject(to, studio)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("does not count soft-deleted projects", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    await seedProjects(studio, admin, ceilingFor("base"));
    await sql`
      UPDATE projects SET deleted_at = now() WHERE studio_id = ${studio}
    `;

    await expect(createProject(admin, studio)).resolves.toBeTruthy();
  });

  it("does not count another studio's projects", async () => {
    const admin = await insertUser("base");
    const mine = await insertStudio(admin, "personal");
    const theirs = await insertStudio(await insertUser("base"), "personal");
    await seedProjects(theirs, admin, ceilingFor("base"));

    await expect(createProject(admin, mine)).resolves.toBeTruthy();
  });

  it("tells the person what their own studio's tier allows, not a number from code", async () => {
    // The whole sentence, not a substring. Block one measured why: with the
    // argument missing, `t()` hands back the ICU template itself, and the
    // template contains a literal digit inside one of its plural branches — so
    // "contains the number N" passes under exactly the mutation it should
    // catch.
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    await seedProjects(studio, admin, ceilingFor("base"));

    await expect(createProject(admin, studio)).rejects.toMatchObject({
      message: "This studio's plan allows up to 10 projects. Upgrade to create more.",
    });
  });

  it("puts a DIFFERENT tier's number in the sentence, so a hard-coded one shows", async () => {
    // The case above cannot tell a hard-coded number from the real one: its
    // studio is on `base`, whose ceiling is 10, so `t(..., { limit: 10 })`
    // produces the exact string it expects. Gate 2 measured that — writing the
    // number in left all 12 cases green.
    //
    // A second tier is what makes the pair discriminating: the two expected
    // sentences differ, so no single literal satisfies both.
    const admin = await insertUser("pro");
    const studio = await insertStudio(admin);
    await seedProjects(studio, admin, ceilingFor("pro"));
    expect(ceilingFor("pro")).not.toBe(ceilingFor("base"));

    await expect(createProject(admin, studio)).rejects.toMatchObject({
      message: "This studio's plan allows up to 100 projects. Upgrade to create more.",
    });
  });
});

describe("project count per studio — the duplicate path", () => {
  it("refuses a copy that would put the studio past its ceiling", async () => {
    // `duplicateProject` inserts into `source.studioId` — the same studio. A
    // gate on `create` alone leaves this path unbounded, and every case in the
    // suite above still passes.
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    const source = await createProject(admin, studio);
    await seedProjects(studio, admin, ceilingFor("base") - 1);

    await expect(projectService.duplicate(source, admin)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("allows a copy while there is still room", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    const source = await createProject(admin, studio);

    const copy = await projectService.duplicate(source, admin);
    expect(copy.studioId).toBe(studio);
  });

  it("refuses with the same sentence as the create path", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    const source = await createProject(admin, studio);
    await seedProjects(studio, admin, ceilingFor("base") - 1);

    await expect(projectService.duplicate(source, admin)).rejects.toMatchObject({
      message: "This studio's plan allows up to 10 projects. Upgrade to create more.",
    });
  });
});

describe("project count per studio — under concurrency", () => {
  /**
   * Park both calls behind a lock on the studio row, then release and settle.
   * @param studioId - The studio row both calls must queue on.
   * @param first - The first call, started while the gate is held.
   * @param second - The second call, started once the first is known parked.
   * @returns How many of the two succeeded.
   */
  async function raceOnStudioRow(
    studioId: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ): Promise<number> {
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let a: Promise<unknown>;
    let b: Promise<unknown>;
    try {
      await gate.begin(async (g) => {
        await g`SELECT id FROM studios WHERE id = ${studioId} FOR UPDATE`;
        a = first();
        await waitUntilBlockedOn(sql, ["studios", "for update"], 1);
        b = second();
        await waitUntilBlockedOn(sql, ["studios", "for update"], 2);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }
    const results = await Promise.allSettled([a!, b!]);
    return results.filter((r) => r.status === "fulfilled").length;
  }

  /**
   * How many live projects a studio holds.
   * @param studioId - Studio to count.
   * @returns The count.
   */
  async function liveProjects(studioId: string): Promise<number> {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM projects
      WHERE studio_id = ${studioId} AND deleted_at IS NULL
    `;
    return Number(rows[0]!.n);
  }

  it("lets only one of two simultaneous creates through the last slot", async () => {
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    await seedProjects(studio, admin, ceilingFor("base") - 1);

    const created = await raceOnStudioRow(
      studio,
      () => createProject(admin, studio),
      () => createProject(admin, studio),
    );

    expect(created).toBe(1);
    expect(await liveProjects(studio)).toBe(ceilingFor("base"));
  });

  it("lets only one through when a create and a duplicate race for it", async () => {
    // The two paths must queue on the SAME row. Gating them on different rows
    // would leave this pair racing past each other while both single-path cases
    // above stay green.
    const admin = await insertUser("base");
    const studio = await insertStudio(admin, "personal");
    const source = await createProject(admin, studio);
    await seedProjects(studio, admin, ceilingFor("base") - 2);

    const created = await raceOnStudioRow(
      studio,
      () => createProject(admin, studio),
      () => projectService.duplicate(source, admin),
    );

    expect(created).toBe(1);
    expect(await liveProjects(studio)).toBe(ceilingFor("base"));
  });
});
