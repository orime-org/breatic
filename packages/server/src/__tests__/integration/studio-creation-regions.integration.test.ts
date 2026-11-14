// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Creating a Studio when Studios live in regions (inner#1955) — real PG.
 *
 * The global directory guarantees one slug per Studio and one team-Studio
 * quota per account across every region. A Studio placed in the global
 * region is written in one transaction with no pending row. A Studio placed
 * in another region first takes a pending directory row (a semantic lock that
 * holds the slug and counts toward the quota), then asks the region to write
 * it, then turns the row live; a worker sweep finishes or abandons pending
 * rows the request could not finish.
 *
 * The other region is played by a client that calls the real region-side
 * functions on this same database, so the test controls when it is
 * unreachable or times out.
 *
 * The pins (acceptance 8):
 *
 *   1. A global-region creation writes the Studio, its admin and a live
 *      directory row, and leaves no pending row.
 *   2. The team quota counts the directory: a live team Studio in another
 *      region, or a pending row, limits creation in the global region too.
 *   3. An unreachable target region answers region_unavailable and writes
 *      nothing; choosing the global region then succeeds.
 *   4. A timed-out step 3 answers studio_creation_in_progress and leaves the
 *      pending row; an identical retry is let through, a changed one is not.
 *   5. After the sweep finishes a pending row, an identical retry returns the
 *      Studio already created.
 *   6. Two concurrent creations under a quota of one: exactly one succeeds.
 *   7. After the sweep abandons a pending row, an identical retry answers
 *      studio_creation_abandoned and the pending row is gone.
 *   8. The region decides abandonment and a late creation under one lock:
 *      whichever comes second sees the first.
 *   9. Two regions creating the same slug: one succeeds.
 *  10. The live slug check reports one's own pending slug as taken.
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

import crypto from "node:crypto";
import postgres from "postgres";
import { GLOBAL_REGION_SETTINGS } from "./global-region-env.js";
import { initCore, loadLocales } from "@breatic/core";
import { studioCreationService, studioRegionService } from "@breatic/domain";
import { studioService } from "@server/modules";
import { waitUntilBlockedOn } from "./lock-probe.js";

const REGION_ENV = {
  REGION: "us-west",
  GLOBAL_REGION: "us-west",
  REGION_API_URLS: JSON.stringify({ sg: "http://sg.invalid:3002" }),
  ...GLOBAL_REGION_SETTINGS,
};

loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  initCore({ ...process.env, ...REGION_ENV });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "studio-creation-regions-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/** How the stand-in region behaves on its next calls. */
interface RegionBehaviour {
  reachable: boolean;
  createTimesOut: boolean;
  createCalls: number;
}

/**
 * A client for the region `sg` that runs the real region-side functions on
 * this database, unless told to be unreachable or to time out.
 * @param behaviour - Mutable switches the test flips.
 * @returns The client factory the creation service is given.
 */
function standInRegion(behaviour: RegionBehaviour): studioCreationService.RegionClientFactory {
  return () => ({
    probe: async (): Promise<void> => {
      if (!behaviour.reachable) throw new Error("connect ECONNREFUSED");
    },
    createStudio: async (input) => {
      behaviour.createCalls++;
      if (!behaviour.reachable || behaviour.createTimesOut) throw new Error("timeout");
      return studioRegionService.createStudioInRegion(input);
    },
    abandonStudio: async (studioId) => {
      if (!behaviour.reachable) throw new Error("connect ECONNREFUSED");
      return studioRegionService.abandonStudioInRegion(studioId);
    },
  });
}

/**
 * A fresh region stand-in that answers normally.
 * @returns The switches.
 */
function healthy(): RegionBehaviour {
  return { reachable: true, createTimesOut: false, createCalls: 0 };
}

/**
 * A verified account on a tier, with a personal Studio in the global region.
 * @param tier - The membership tier.
 * @returns The account id.
 * @throws {Error} if an insert fails.
 */
async function account(tier: "pro" | "team"): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`create-region-${Date.now()}-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  return user!.id;
}

/**
 * A slug nobody has used.
 * @returns The slug.
 */
function freshSlug(): string {
  return `cr-${crypto.randomBytes(5).toString("hex")}`;
}

/**
 * The directory row of a Studio.
 * @param studioId - The Studio.
 * @returns Its state and region, or undefined when there is no row.
 */
async function directoryRow(studioId: string): Promise<{ state: string; region: string | null } | undefined> {
  const [row] = await sql<{ state: string; region: string | null }[]>`
    SELECT state, region FROM studio_directory WHERE studio_id = ${studioId} AND deleted_at IS NULL
  `;
  return row;
}

/**
 * Whether the region tables hold a Studio.
 * @param studioId - The Studio.
 * @returns True when a `studios` row exists.
 */
async function studioExists(studioId: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM studios WHERE id = ${studioId}`;
  return row!.n > 0;
}

/**
 * The reason code a rejected creation carries.
 * @param operation - The creation.
 * @returns The reason, or "resolved" when it succeeded.
 */
async function reasonOf(operation: Promise<unknown>): Promise<string> {
  return operation.then(
    () => "resolved",
    (err: unknown) => String((err as { reason?: string }).reason ?? (err as Error).message),
  );
}

describe("creating a Studio in the global region", () => {
  it("writes the Studio, its admin and a live directory row in one step", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();

    const studio = await studioCreationService.createStudio(
      { studioId, userId, type: "team", slug: freshSlug(), name: "Global team", region: "us-west" },
      { regionClient: standInRegion(healthy()) },
    );

    expect(studio.id).toBe(studioId);
    expect(await studioExists(studioId)).toBe(true);
    expect(await directoryRow(studioId)).toEqual({ state: "live", region: null });
    const [admin] = await sql<{ role: string }[]>`
      SELECT role FROM studio_directory_members WHERE studio_id = ${studioId} AND user_id = ${userId}
    `;
    expect(admin?.role).toBe("admin");
  });

  it("counts a live team Studio in another region toward the quota", async () => {
    const userId = await account("pro");
    const elsewhere = crypto.randomUUID();
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${elsewhere}, ${freshSlug()}, 'sg', 'team', 'Elsewhere', ${userId}, ${userId}, 'live')
    `;

    const reason = await reasonOf(
      studioCreationService.createStudio(
        { studioId: crypto.randomUUID(), userId, type: "team", slug: freshSlug(), name: "Second", region: "us-west" },
        { regionClient: standInRegion(healthy()) },
      ),
    );

    expect(reason).toBe("team_limit_reached");
  });
});

describe("creating a Studio in another region", () => {
  it("answers region_unavailable and writes nothing when the region cannot be reached", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();
    const region = healthy();
    region.reachable = false;

    const reason = await reasonOf(
      studioCreationService.createStudio(
        { studioId, userId, type: "team", slug: freshSlug(), name: "Far", region: "sg" },
        { regionClient: standInRegion(region) },
      ),
    );

    expect(reason).toBe("region_unavailable");
    expect(await directoryRow(studioId)).toBeUndefined();
    expect(region.createCalls).toBe(0);

    const studio = await studioCreationService.createStudio(
      { studioId: crypto.randomUUID(), userId, type: "team", slug: freshSlug(), name: "Near", region: "us-west" },
      { regionClient: standInRegion(region) },
    );
    expect(await directoryRow(studio.id)).toEqual({ state: "live", region: null });
  });

  it("goes live in the region with its directory row when every step succeeds", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();

    await studioCreationService.createStudio(
      { studioId, userId, type: "team", slug: freshSlug(), name: "Far", region: "sg" },
      { regionClient: standInRegion(healthy()) },
    );

    expect(await studioExists(studioId)).toBe(true);
    expect(await directoryRow(studioId)).toEqual({ state: "live", region: "sg" });
  });

  it("keeps the pending row after a timeout, lets an identical retry through and refuses a changed one", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();
    const slug = freshSlug();
    const region = healthy();
    region.createTimesOut = true;
    const input = { studioId, userId, type: "team" as const, slug, name: "Far", region: "sg" };

    expect(await reasonOf(studioCreationService.createStudio(input, { regionClient: standInRegion(region) }))).toBe(
      "studio_creation_in_progress",
    );
    expect(await directoryRow(studioId)).toEqual({ state: "pending", region: "sg" });

    const changed = await reasonOf(
      studioCreationService.createStudio(
        { ...input, studioId: crypto.randomUUID(), name: "Renamed" },
        { regionClient: standInRegion(healthy()) },
      ),
    );
    expect(changed).toBe("studio_creation_in_progress");

    region.createTimesOut = false;
    const retried = await studioCreationService.createStudio(input, { regionClient: standInRegion(region) });
    expect(retried.id).toBe(studioId);
    expect(await directoryRow(studioId)).toEqual({ state: "live", region: "sg" });
  });

  it("counts a pending row toward the quota", async () => {
    const userId = await account("pro");
    const region = healthy();
    region.createTimesOut = true;
    await reasonOf(
      studioCreationService.createStudio(
        { studioId: crypto.randomUUID(), userId, type: "team", slug: freshSlug(), name: "Pending", region: "sg" },
        { regionClient: standInRegion(region) },
      ),
    );

    const reason = await reasonOf(
      studioCreationService.createStudio(
        { studioId: crypto.randomUUID(), userId, type: "team", slug: freshSlug(), name: "Next", region: "us-west" },
        { regionClient: standInRegion(healthy()) },
      ),
    );

    expect(["team_limit_reached", "studio_creation_in_progress"]).toContain(reason);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM studio_directory WHERE admin_user_id = ${userId} AND deleted_at IS NULL
    `;
    expect(row!.n).toBe(1);
  });

  it("returns the Studio the sweep finished to an identical retry", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();
    const region = healthy();
    const input = { studioId, userId, type: "team" as const, slug: freshSlug(), name: "Far", region: "sg" };
    region.createTimesOut = true;
    await reasonOf(studioCreationService.createStudio(input, { regionClient: standInRegion(region) }));
    await studioRegionService.createStudioInRegion({
      studioId,
      slug: input.slug,
      name: input.name,
      type: input.type,
      adminUserId: userId,
    });

    await studioCreationService.sweepPendingStudios({ olderThanMs: 0, regionClient: standInRegion(healthy()) });
    expect(await directoryRow(studioId)).toEqual({ state: "live", region: "sg" });

    const calls = region.createCalls;
    const retried = await studioCreationService.createStudio(input, { regionClient: standInRegion(region) });
    expect(retried.id).toBe(studioId);
    expect(region.createCalls).toBe(calls);
  });

  it("keeps the cause of a creation the region refused, and the sweep names each row it could not settle", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();
    const region = healthy();
    const input = { studioId, userId, type: "team" as const, slug: freshSlug(), name: "Far", region: "sg" };
    region.createTimesOut = true;
    const refused = await studioCreationService.createStudio(input, { regionClient: standInRegion(region) }).catch((err: unknown) => err);
    expect((refused as Error).cause).toEqual(new Error("timeout"));

    const swept = await studioCreationService.sweepPendingStudios({
      olderThanMs: 0,
      regionClient: standInRegion({ ...healthy(), reachable: false }),
    });
    expect(swept.unreachable).toContainEqual({ studioId, region: "sg", err: new Error("connect ECONNREFUSED") });
  });

  it("answers studio_creation_abandoned to a retry after the sweep gave the row up", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();
    const region = healthy();
    const input = { studioId, userId, type: "team" as const, slug: freshSlug(), name: "Far", region: "sg" };
    region.createTimesOut = true;
    await reasonOf(studioCreationService.createStudio(input, { regionClient: standInRegion(region) }));

    await studioCreationService.sweepPendingStudios({ olderThanMs: 0, regionClient: standInRegion(healthy()) });
    expect(await directoryRow(studioId)).toBeUndefined();

    region.createTimesOut = false;
    expect(await reasonOf(studioCreationService.createStudio(input, { regionClient: standInRegion(region) }))).toBe(
      "studio_creation_abandoned",
    );
    expect(await directoryRow(studioId)).toBeUndefined();
    expect(await studioExists(studioId)).toBe(false);
  });

  it("lets exactly one of two concurrent creations through under a quota of one", async () => {
    const userId = await account("pro");
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const gate = sql.begin(async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;

    const pending = ["sg", "us-west"].map((region) =>
      reasonOf(
        studioCreationService.createStudio(
          { studioId: crypto.randomUUID(), userId, type: "team", slug: freshSlug(), name: `Tab ${region}`, region },
          { regionClient: standInRegion(healthy()) },
        ),
      ),
    );
    await waitUntilBlockedOn(sql, ["users", "for update"], 2);
    release();
    await gate;
    const reasons = await Promise.all(pending);

    expect(reasons.filter((reason) => reason === "resolved")).toHaveLength(1);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM studio_directory WHERE admin_user_id = ${userId} AND deleted_at IS NULL
    `;
    expect(row!.n).toBe(1);
  });

  it("gives one slug to only one of two regions creating it at once", async () => {
    const slug = freshSlug();
    const [first, second] = [await account("team"), await account("team")];

    const reasons = await Promise.all([
      reasonOf(
        studioCreationService.createStudio(
          { studioId: crypto.randomUUID(), userId: first, type: "team", slug, name: "A", region: "sg" },
          { regionClient: standInRegion(healthy()) },
        ),
      ),
      reasonOf(
        studioCreationService.createStudio(
          { studioId: crypto.randomUUID(), userId: second, type: "team", slug, name: "B", region: "us-west" },
          { regionClient: standInRegion(healthy()) },
        ),
      ),
    ]);

    expect(reasons.filter((reason) => reason === "resolved")).toHaveLength(1);
    expect(reasons).toContain("slug_taken");
  });

  it("reports one's own pending slug as taken", async () => {
    const userId = await account("team");
    const slug = freshSlug();
    const region = healthy();
    region.createTimesOut = true;
    await reasonOf(
      studioCreationService.createStudio(
        { studioId: crypto.randomUUID(), userId, type: "team", slug, name: "Far", region: "sg" },
        { regionClient: standInRegion(region) },
      ),
    );

    expect(await studioService.checkStudioSlug(slug)).toEqual({ available: false, reason: "taken" });
  });
});

describe("the region side of creation", () => {
  it("is idempotent for one studio id", async () => {
    const userId = await account("team");
    const input = { studioId: crypto.randomUUID(), slug: freshSlug(), name: "R", type: "team" as const, adminUserId: userId };

    expect(await studioRegionService.createStudioInRegion(input)).toBe("created");
    expect(await studioRegionService.createStudioInRegion(input)).toBe("exists");
  });

  it("refuses a creation that arrives after the studio id was abandoned", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();

    expect(await studioRegionService.abandonStudioInRegion(studioId)).toBe("abandoned");
    expect(
      await studioRegionService.createStudioInRegion({ studioId, slug: freshSlug(), name: "Late", type: "team", adminUserId: userId }),
    ).toBe("abandoned");
    expect(await studioExists(studioId)).toBe(false);
  });

  it("refuses to abandon a studio id that was already created", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();
    await studioRegionService.createStudioInRegion({ studioId, slug: freshSlug(), name: "Early", type: "team", adminUserId: userId });

    expect(await studioRegionService.abandonStudioInRegion(studioId)).toBe("exists");
    expect(await studioExists(studioId)).toBe(true);
  });

  it("settles a concurrent abandon and create the same way either side wins", async () => {
    const userId = await account("team");
    const studioId = crypto.randomUUID();

    const [created, abandoned] = await Promise.all([
      studioRegionService.createStudioInRegion({ studioId, slug: freshSlug(), name: "Race", type: "team", adminUserId: userId }),
      studioRegionService.abandonStudioInRegion(studioId),
    ]);

    const exists = await studioExists(studioId);
    if (exists) {
      expect(created).toBe("created");
      expect(abandoned).toBe("exists");
    } else {
      expect(created).toBe("abandoned");
      expect(abandoned).toBe("abandoned");
    }
  });
});
