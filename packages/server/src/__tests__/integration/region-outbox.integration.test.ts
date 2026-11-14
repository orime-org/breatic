// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The region outbox (inner#1955, acceptance 11) — real PG.
 *
 * A region that does not hold the global data changes the directory only
 * through its outbox: the business transaction writes an event beside its own
 * rows, a relay sends unsent events to the global region in id order, and the
 * global region applies each aggregate's events in order, at most once. This
 * suite runs as the region `sg`; the relay's delivery applies events with the
 * real global function on this same database, which holds both sides' tables.
 *
 * The pins:
 *
 *   1. A rename and a role change write their events in their own
 *      transaction, and a refused change writes none; the directory moves only
 *      once the relay has delivered.
 *   2. The relay delivers in id order and does not send an event twice.
 *   3. An event committed after an earlier, still-open one is delivered; the
 *      earlier one is delivered once it commits.
 *   4. An event the global region can never apply goes to the dead letters and
 *      the events after it are still delivered.
 *   5. A transient failure stops the relay without skipping anything.
 *   6. The global region acknowledges an event at or below the aggregate's
 *      last applied id without applying it.
 *   7. A snapshot rewrites the Studio's directory rows except its admin, and a
 *      change after the snapshot still wins.
 *   8. Two region writes to one Studio at once leave the directory equal to
 *      the region's rows.
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
import { initCore, loadLocales } from "@breatic/core";
import { regionOutboxApplyService, regionOutboxService, studioDirectoryService } from "@breatic/domain";
import * as studioService from "@server/modules/studio/studio.service.js";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import { waitUntilBlockedOn } from "./lock-probe.js";

const SINGAPORE = {
  REGION: "sg",
  GLOBAL_REGION: "us-west",
  GLOBAL_API_URL: "http://global.invalid:3002",
  IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: "unused" }),
  INTERNAL_API_SECRET: "region-outbox-test-secret",
};

loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  initCore({ ...process.env, ...SINGAPORE });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "region-outbox-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/** Delivers each event to the global region's apply function on this database. */
const applyHere: regionOutboxService.Deliver = (event) => regionOutboxApplyService.applyRegionEvent("sg", event);

/**
 * A verified account.
 * @returns Its id.
 */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`outbox-${Date.now()}-${seq++}@example.test`}, true)
    RETURNING id
  `;
  return row!.id;
}

/**
 * A team Studio in this region with an admin and a maintainer, and its
 * directory rows as the global region last saw them.
 * @returns Its id, slug and members.
 */
async function regionStudio(): Promise<{ studioId: string; slug: string; adminId: string; memberId: string }> {
  const adminId = await user();
  const memberId = await user();
  const slug = `ob-${crypto.randomBytes(5).toString("hex")}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminId}, ${slug}, 'team', 'Before') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${adminId}, 'admin')`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${memberId}, 'maintainer')`;
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${studioId}, ${slug}, 'sg', 'team', 'Before', ${adminId}, ${adminId}, 'live')
  `;
  await sql`
    INSERT INTO studio_directory_members (studio_id, user_id, role)
    VALUES (${studioId}, ${adminId}, 'admin'), (${studioId}, ${memberId}, 'maintainer')
  `;
  return { studioId, slug, adminId, memberId };
}

/**
 * The outbox events written for a Studio, in id order.
 * @param studioId - The Studio.
 * @returns Their types and whether each was sent.
 */
async function eventsFor(studioId: string): Promise<{ id: string; type: string; sent: boolean }[]> {
  return sql<{ id: string; type: string; sent: boolean }[]>`
    SELECT id::text, event_type AS type, sent_at IS NOT NULL AS sent FROM region_outbox
    WHERE aggregate_key LIKE ${`%${studioId}%`} ORDER BY region_outbox.id
  `;
}

/**
 * The directory's name and member roles of a Studio.
 * @param studioId - The Studio.
 * @returns Them.
 */
async function directoryView(studioId: string): Promise<{ name: string; members: Record<string, string> }> {
  const [row] = await sql<{ name: string }[]>`SELECT name FROM studio_directory WHERE studio_id = ${studioId}`;
  const members = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM studio_directory_members WHERE studio_id = ${studioId} AND deleted_at IS NULL
  `;
  return { name: row!.name, members: Object.fromEntries(members.map((m) => [m.user_id, m.role])) };
}

/**
 * The region's own name and member roles of a Studio.
 * @param studioId - The Studio.
 * @returns Them.
 */
async function regionView(studioId: string): Promise<{ name: string; members: Record<string, string> }> {
  const [row] = await sql<{ name: string }[]>`SELECT name FROM studios WHERE id = ${studioId}`;
  const members = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM studio_members WHERE studio_id = ${studioId} AND deleted_at IS NULL
  `;
  return { name: row!.name, members: Object.fromEntries(members.map((m) => [m.user_id, m.role])) };
}

/**
 * Relay until nothing is left to send.
 * @returns Once the outbox is drained.
 */
async function drain(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const result = await regionOutboxService.relayOutbox({ deliver: applyHere });
    if (result.delivered === 0 && result.deadLettered === 0) return;
  }
}

describe("writing to the outbox", () => {
  it("writes events with the business change and moves the directory only once delivered", async () => {
    const { studioId, slug, memberId } = await regionStudio();

    await studioService.updateStudio(slug, { name: "After" });
    await studioMemberService.updateMemberRole(slug, memberId, "guest");

    expect((await eventsFor(studioId)).map((event) => event.type)).toEqual([
      "studio.profile_changed",
      "studio_member.upserted",
    ]);
    expect((await directoryView(studioId)).name).toBe("Before");

    await drain();

    expect(await directoryView(studioId)).toEqual(await regionView(studioId));
  });

  it("writes nothing for a change the region refuses", async () => {
    const { studioId, slug, adminId } = await regionStudio();

    await expect(studioMemberService.updateMemberRole(slug, adminId, "guest")).rejects.toBeDefined();

    expect(await eventsFor(studioId)).toEqual([]);
  });
});

describe("relaying the outbox", () => {
  it("delivers in id order and never sends an event twice", async () => {
    const { studioId, slug } = await regionStudio();
    await studioService.updateStudio(slug, { name: "One" });
    await studioService.updateStudio(slug, { name: "Two" });
    const seen: string[] = [];

    await regionOutboxService.relayOutbox({
      deliver: async (event) => {
        seen.push(event.id);
        return applyHere(event);
      },
    });
    await regionOutboxService.relayOutbox({
      deliver: async (event) => {
        seen.push(event.id);
        return applyHere(event);
      },
    });

    const ids = (await eventsFor(studioId)).map((event) => event.id);
    expect(seen.filter((id) => ids.includes(id))).toEqual(ids);
    expect((await directoryView(studioId)).name).toBe("Two");
  });

  it("delivers an event committed after a still-open earlier one, and the earlier one once it commits", async () => {
    const first = await regionStudio();
    const second = await regionStudio();
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    let opened!: () => void;
    const open = new Promise<void>((resolve) => { opened = resolve; });
    const earlier = sql.begin(async (tx) => {
      await tx`
        INSERT INTO region_outbox (aggregate_key, event_type, payload)
        VALUES (${`studio:${first.studioId}`}, 'studio.profile_changed', ${tx.json({ studioId: first.studioId, name: "Late", version: 99 })})
      `;
      opened();
      await committed;
    });
    await open;
    await studioService.updateStudio(second.slug, { name: "Early" });

    await drain();
    expect((await directoryView(second.studioId)).name).toBe("Early");

    commit();
    await earlier;
    await drain();
    expect((await directoryView(first.studioId)).name).toBe("Late");
  });

  it("moves an event that can never apply to the dead letters and delivers the rest", async () => {
    const { studioId, slug } = await regionStudio();
    await studioService.updateStudio(slug, { name: "Poison" });
    await studioService.updateStudio(slug, { name: "Fine" });
    const [poison] = await eventsFor(studioId);

    const result = await regionOutboxService.relayOutbox({
      deliver: async (event) => (event.id === poison!.id ? "permanent_failure" : applyHere(event)),
    });

    expect(result.deadLettered).toBe(1);
    const [dead] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM region_outbox_dead_letters WHERE outbox_id = ${poison!.id}
    `;
    expect(dead!.n).toBe(1);
    expect((await directoryView(studioId)).name).toBe("Fine");
  });

  it("stops on a transient failure without skipping anything", async () => {
    const { studioId, slug } = await regionStudio();
    await studioService.updateStudio(slug, { name: "A" });
    await studioService.updateStudio(slug, { name: "B" });

    const result = await regionOutboxService.relayOutbox({
      deliver: async () => {
        throw new Error("global unavailable");
      },
    });

    expect(result.delivered).toBe(0);
    expect(result.stoppedBy).toBeInstanceOf(Error);
    expect((await eventsFor(studioId)).every((event) => !event.sent)).toBe(true);
    await drain();
    expect((await directoryView(studioId)).name).toBe("B");
  });
});

describe("applying in the global region", () => {
  it("acknowledges an event at or below the last applied id without applying it", async () => {
    const { studioId, slug } = await regionStudio();
    await studioService.updateStudio(slug, { name: "Old" });
    await studioService.updateStudio(slug, { name: "New" });
    const [older] = await sql<{ id: string; aggregate_key: string; event_type: string; payload: unknown }[]>`
      SELECT id::text, aggregate_key, event_type, payload FROM region_outbox
      WHERE aggregate_key = ${`studio:${studioId}`} ORDER BY region_outbox.id LIMIT 1
    `;
    await drain();

    const answer = await regionOutboxApplyService.applyRegionEvent("sg", {
      id: older!.id,
      aggregateKey: older!.aggregate_key,
      type: older!.event_type,
      payload: older!.payload,
    });

    expect(answer).toBe("duplicate");
    expect((await directoryView(studioId)).name).toBe("New");
  });
});

describe("snapshots", () => {
  it("rewrites the directory rows except the admin, and a later change still wins", async () => {
    const { studioId, slug, adminId, memberId } = await regionStudio();
    const stranger = await user();
    await sql`UPDATE studio_directory SET name = 'Corrupt', admin_user_id = ${stranger} WHERE studio_id = ${studioId}`;
    await sql`UPDATE studio_directory_members SET role = 'guest' WHERE studio_id = ${studioId} AND user_id = ${memberId}`;

    await studioDirectoryService.emitStudioSnapshot(studioId);
    await studioService.updateStudio(slug, { name: "Later" });
    await drain();

    const view = await directoryView(studioId);
    expect(view.name).toBe("Later");
    expect(view.members).toEqual({ [adminId]: "admin", [memberId]: "maintainer" });
    const [row] = await sql<{ admin: string }[]>`SELECT admin_user_id AS admin FROM studio_directory WHERE studio_id = ${studioId}`;
    expect(row!.admin).toBe(stranger);
  });

  it("records the sending region for every member, as a lost user_region.touched would have", async () => {
    const { studioId, adminId, memberId } = await regionStudio();
    await sql`DELETE FROM user_regions WHERE user_id IN (${adminId}, ${memberId})`;

    await studioDirectoryService.emitStudioSnapshot(studioId);
    await drain();

    const rows = await sql<{ userId: string; region: string }[]>`
      SELECT user_id AS "userId", region FROM user_regions WHERE user_id IN (${adminId}, ${memberId})
    `;
    expect(rows.map((row) => `${row.userId}:${row.region}`).sort()).toEqual([`${adminId}:sg`, `${memberId}:sg`].sort());
  });
});

describe("concurrent writes to one Studio", () => {
  it("leave the directory equal to the region's rows", async () => {
    const { studioId, slug, memberId } = await regionStudio();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const gate = sql.begin(async (tx) => {
      await tx`SELECT id FROM studios WHERE id = ${studioId} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;

    const writes = Promise.all([
      studioService.updateStudio(slug, { name: "Raced" }),
      studioMemberService.removeMember(slug, memberId),
    ]);
    await waitUntilBlockedOn(sql, ["studios", "for update"], 2);
    release();
    await gate;
    await writes;
    await drain();

    expect(await directoryView(studioId)).toEqual(await regionView(studioId));
  });
});
