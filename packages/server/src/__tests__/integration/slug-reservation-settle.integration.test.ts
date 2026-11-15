// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Settling a slug reservation the sweep found past due (inner#1955): the
 * directory takes the slug when the Studio's region holds it, and lets it go
 * when the region holds another; a reservation not yet due is left alone.
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

  it("gives the directory the slug when the region holds it", async () => {
    const r = await reserved(1);

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, r.newSlug);

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.newSlug, held: false });
  });

  it("lets the slug go when the region holds another", async () => {
    const r = await reserved(1);

    await directoryWrites.settleSlugReservation(r.newSlug, r.studioId, r.oldSlug);

    expect(await state(r.studioId, r.newSlug)).toEqual({ directorySlug: r.oldSlug, held: false });
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
      type: "studio.slug_changed",
      payload: { studioId: r.studioId, slug },
    });

    await regionOutboxApplyService.applyRegionEvent("sg", event("901", r.newSlug));
    await regionOutboxApplyService.applyRegionEvent("sg", event("902", r.oldSlug));

    expect(await directoryWrites.reserveSlug(r.newSlug, stranger.studioId)).toBe(false);
  });
});
