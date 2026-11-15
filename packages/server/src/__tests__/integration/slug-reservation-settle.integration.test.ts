// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Settling a slug reservation the sweep found past due (inner#1955): it stays
 * while the Studio's region still has events of the Studio to deliver, or
 * holds the slug the directory does not show yet; it goes once every event is
 * delivered and the directory shows it, or the region holds another. The
 * sweep never writes the directory, and a reservation not yet due is left
 * alone.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, studioDirectoryRepo } from "@breatic/core";
import { directoryWrites, regionOutboxApplyService } from "@breatic/domain";
import { mirrorInDirectory } from "./directory-fixtures.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore({ ...process.env, REGION: "us-west", GLOBAL_REGION: "us-west" });
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "slug-settle-test" } });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A Studio in the directory with a reservation for a new slug.
 * @param dueMinutesAgo - How long ago the reservation fell due; negative is still ahead.
 * @returns The Studio and both slugs.
 */
async function reserved(dueMinutesAgo: number): Promise<{ studioId: string; oldSlug: string; newSlug: string }> {
  const tag = crypto.randomBytes(5).toString("hex");
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`slug-settle-${tag}@example.test`}, true) RETURNING id`;
  const oldSlug = `ss-old-${tag}`;
  const newSlug = `ss-new-${tag}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${oldSlug}, 'team', 'S') RETURNING id`;
  await mirrorInDirectory(sql, studio!.id);
  await sql`
    INSERT INTO slug_reservations (slug, studio_id, expires_at)
    VALUES (${newSlug}, ${studio!.id}, now() - (${dueMinutesAgo} * interval '1 minute'))`;
  return { studioId: studio!.id, oldSlug, newSlug };
}

/**
 * The directory slug and whether the reservation still stands.
 * @param studioId - The Studio.
 * @param slug - The reserved slug.
 * @returns Both.
 */
async function state(studioId: string, slug: string): Promise<{ directorySlug: string; held: boolean }> {
  const [row] = await sql<{ slug: string }[]>`SELECT slug FROM studio_directory WHERE studio_id = ${studioId}`;
  const held = await sql`SELECT 1 FROM slug_reservations WHERE slug = ${slug} AND deleted_at IS NULL`;
  return { directorySlug: row!.slug, held: held.length > 0 };
}

describe("settling a past-due slug reservation", () => {
  it("lists only reservations past due, with the Studio's region", async () => {
    const due = await reserved(1);
    const ahead = await reserved(-10);

    const listed = await studioDirectoryRepo.listDueSlugReservations(1000);

    expect(listed).toContainEqual({ slug: due.newSlug, studioId: due.studioId, region: null });
    expect(listed.map((r) => r.slug)).not.toContain(ahead.newSlug);
  });

  it("lets the slug go once every event is delivered and the directory shows the slug the region holds", async () => {
    const r = await reserved(1);
    await sql`UPDATE studio_directory SET slug = ${r.newSlug} WHERE studio_id = ${r.studioId}`;

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: r.newSlug, eventsInFlight: false });

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.newSlug, held: false });
  });

  it("keeps the slug held, due again later, while the region holds it and the directory does not show it", async () => {
    const r = await reserved(1);

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: r.newSlug, eventsInFlight: false });

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.oldSlug, held: true });
    const [row] = await sql<{ due: boolean }[]>`SELECT expires_at <= now() AS due FROM slug_reservations WHERE slug = ${r.newSlug} AND deleted_at IS NULL`;
    expect(row?.due).toBe(false);
  });

  // inner#1955: renamed S -> T -> S while the outbox was stalled; the directory
  // still shows the S from before T, and the T and S events are on their way.
  it("keeps the slug while events of the Studio are still on their way, though the directory shows it", async () => {
    const r = await reserved(1);
    await sql`UPDATE studio_directory SET slug = ${r.newSlug} WHERE studio_id = ${r.studioId}`;

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: r.newSlug, eventsInFlight: true });

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.newSlug, held: true });
  });

  // inner#1955: renamed to X and then to Y while the outbox was stalled; the
  // event carrying X has not landed yet.
  it("keeps a slug the region moved on from while events of the Studio are still on their way", async () => {
    const r = await reserved(1);

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: r.oldSlug, eventsInFlight: true });

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.oldSlug, held: true });
  });

  it("lets the slug go once every event is delivered and the region holds another", async () => {
    const r = await reserved(1);

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: r.oldSlug, eventsInFlight: false });

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.oldSlug, held: false });
  });

  it("leaves a reservation a rename reused since the region answered", async () => {
    const r = await reserved(1);
    expect(await directoryWrites.reserveSlug(r.newSlug, r.studioId)).toBe(true);

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: r.oldSlug, eventsInFlight: false });

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.oldSlug, held: true });
  });
});

describe("postponing a reservation whose region did not answer", () => {
  it("moves a due reservation a window later, still held", async () => {
    const r = await reserved(1);

    await directoryWrites.postponeSlugReservation(r.newSlug, r.studioId);

    const [row] = await sql<{ due: boolean }[]>`SELECT expires_at <= now() AS due FROM slug_reservations WHERE slug = ${r.newSlug} AND deleted_at IS NULL`;
    expect(row?.due).toBe(false);
  });

  it("leaves a reservation that is no longer due alone", async () => {
    const r = await reserved(-5);
    const [before] = await sql<{ at: string }[]>`SELECT expires_at::text AS at FROM slug_reservations WHERE slug = ${r.newSlug}`;

    await directoryWrites.postponeSlugReservation(r.newSlug, r.studioId);

    const [after] = await sql<{ at: string }[]>`SELECT expires_at::text AS at FROM slug_reservations WHERE slug = ${r.newSlug}`;
    expect(after?.at).toBe(before?.at);
  });
});

describe("reserving a slug for a rename", () => {
  it("answers a Studio's retry of its own reservation as held, with no second reservation", async () => {
    const r = await reserved(-5);

    expect(await directoryWrites.reserveSlug(r.newSlug, r.studioId)).toBe(true);
    const rows = await sql`SELECT 1 FROM slug_reservations WHERE slug = ${r.newSlug} AND deleted_at IS NULL`;
    expect(rows).toHaveLength(1);
  });

  it("refuses a slug another Studio holds", async () => {
    const r = await reserved(-5);
    const other = await reserved(-5);

    expect(await directoryWrites.reserveSlug(r.newSlug, other.studioId)).toBe(false);
  });

  // inner#1955: renamed a → b and straight back to a, before the outbox
  // moved the directory to b. The directory row's own a is about to go.
  it("reserves a slug the Studio's own directory row still shows", async () => {
    const r = await reserved(-5);

    expect(await directoryWrites.reserveSlug(r.oldSlug, r.studioId)).toBe(true);
    const rows = await sql`SELECT 1 FROM slug_reservations WHERE slug = ${r.oldSlug} AND studio_id = ${r.studioId} AND deleted_at IS NULL`;
    expect(rows).toHaveLength(1);
  });

  // inner#1955: renamed to a slug, away and straight back before the outbox
  // ran; the first event applying must not free the slug the last relies on.
  it("keeps a rename's reservation after its event applies, until the sweep settles it", async () => {
    const r = await reserved(-5);
    const stranger = await reserved(-5);
    const event = (id: string, slug: string) => ({
      id,
      aggregateKey: `studio:${r.studioId}`,
      type: "studio.profile_changed",
      payload: { studioId: r.studioId, slug },
    });

    await regionOutboxApplyService.applyRegionEvent("sg", event("901", r.newSlug));
    await regionOutboxApplyService.applyRegionEvent("sg", event("902", r.oldSlug));

    expect(await directoryWrites.reserveSlug(r.newSlug, stranger.studioId)).toBe(false);
  });
});

describe("the slug state a region answers for the sweep", () => {
  it("says events are in flight while one of the Studio's outbox events is unsent", async () => {
    const r = await reserved(-5);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO region_outbox (aggregate_key, event_type, payload)
      VALUES (${`studio:${r.studioId}`}, 'studio.profile_changed', ${sql.json({ studioId: r.studioId, slug: r.newSlug })})
      RETURNING id`;

    expect(await directoryWrites.slugState(r.studioId)).toEqual({ slug: r.oldSlug, eventsInFlight: true });

    await sql`UPDATE region_outbox SET sent_at = now() WHERE id = ${row!.id}`;
    expect(await directoryWrites.slugState(r.studioId)).toEqual({ slug: r.oldSlug, eventsInFlight: false });
  });
});

describe("a Studio's slug events landing after a stalled outbox", () => {
  // inner#1955: an sg admin renamed name and slug to X, then the slug to Y,
  // while the outbox was stalled. Another Studio tries X before the events land.
  it("applies both events, keeping the name, because X stays held until they land", async () => {
    const r = await reserved(1);
    const stranger = await reserved(-5);
    const second = `${r.newSlug}-y`;
    await sql`INSERT INTO slug_reservations (slug, studio_id, expires_at) VALUES (${second}, ${r.studioId}, now() - interval '1 minute')`;
    const event = (id: string, payload: Record<string, unknown>) => ({
      id,
      aggregateKey: `studio:${r.studioId}`,
      type: "studio.profile_changed",
      payload: { studioId: r.studioId, ...payload },
    });

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: second, eventsInFlight: true });
    expect(await directoryWrites.reserveSlug(r.newSlug, stranger.studioId)).toBe(false);

    expect(await regionOutboxApplyService.applyRegionEvent("sg", event("911", { name: "N1", slug: r.newSlug }))).toBe("applied");
    expect(await regionOutboxApplyService.applyRegionEvent("sg", event("912", { slug: second }))).toBe("applied");
    const [row] = await sql<{ name: string; slug: string }[]>`SELECT name, slug FROM studio_directory WHERE studio_id = ${r.studioId}`;
    expect(row).toEqual({ name: "N1", slug: second });

    await sql`UPDATE slug_reservations SET expires_at = now() - interval '1 minute' WHERE studio_id = ${r.studioId} AND deleted_at IS NULL`;
    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, { slug: second, eventsInFlight: false });
    await directoryWrites.settleSlugReservation(second, r.studioId, { slug: second, eventsInFlight: false });
    expect(await state(r.studioId, r.newSlug)).toMatchObject({ held: false });
    expect(await state(r.studioId, second)).toMatchObject({ held: false });
  });
});
