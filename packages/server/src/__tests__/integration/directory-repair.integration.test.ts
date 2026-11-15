// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Repairing one Studio's directory row (inner#1955, design 6.9 and 6.13) —
 * real PG, internal app. The back office asks the global region; the Studio's
 * own region sends its whole state as a snapshot on the ordered outbox
 * channel, and in the global region that snapshot is applied at once.
 *
 * The pins:
 *
 *   1. A global-region Studio's stale directory row is rewritten from its
 *      region rows.
 *   2. A Studio the directory does not know answers 404.
 *   3. A Studio whose region cannot be reached answers 503.
 */

import crypto from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ADMIN, call, useInternalApp } from "./internal-api-harness.js";
import { GLOBAL_REGION_SETTINGS } from "./global-region-env.js";
import { StandInRefusal, startRegionStandIn } from "./region-harness.js";

const sg = await startRegionStandIn();
const suite = useInternalApp("directory-repair", {
  REGION_API_URLS: JSON.stringify({ sg: sg.url }),
  IDENTITY_SIGNING_KEY: GLOBAL_REGION_SETTINGS.IDENTITY_SIGNING_KEY,
  IDENTITY_SIGNING_KEY_ID: GLOBAL_REGION_SETTINGS.IDENTITY_SIGNING_KEY_ID,
});

afterEach(() => {
  sg.reset();
});

afterAll(async () => {
  await sg.close();
});

/**
 * A team Studio whose directory row has gone stale.
 * @param region - The directory's region for it; null is the global region.
 * @returns The Studio id and its real name.
 */
async function staleStudio(region: string | null): Promise<{ studioId: string; name: string }> {
  const [user] = await suite.sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`repair-${crypto.randomUUID()}@example.test`}, true) RETURNING id
  `;
  const slug = `rp-${crypto.randomBytes(5).toString("hex")}`;
  const name = `Real ${slug}`;
  const studioId = region === null
    ? (await suite.sql<{ id: string }[]>`
        INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${slug}, 'team', ${name}) RETURNING id
      `)[0]!.id
    : crypto.randomUUID();
  if (region === null) {
    await suite.sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${user!.id}, 'admin')`;
  }
  await suite.sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${studioId}, ${slug}, ${region}, 'team', 'Stale', ${user!.id}, ${user!.id}, 'live')
  `;
  return { studioId, name };
}

/**
 * Ask the global region to repair one Studio's directory row.
 * @param studioId - The Studio.
 * @returns The internal API's answer.
 */
function repair(studioId: string): ReturnType<typeof call> {
  return call(suite.baseUrl, `/internal/v1/directory/studios/${studioId}/snapshot`, { method: "POST", body: {}, admin: ADMIN });
}

describe("repairing a Studio's directory row", () => {
  it("rewrites a global-region Studio's row from its region rows", async () => {
    const { studioId, name } = await staleStudio(null);

    const answer = await repair(studioId);

    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ status: "emitted" });
    const [row] = await suite.sql<{ name: string }[]>`SELECT name FROM studio_directory WHERE studio_id = ${studioId}`;
    expect(row!.name).toBe(name);
  });

  it("answers 404 for a Studio the directory does not know", async () => {
    const answer = await repair(crypto.randomUUID());

    expect(answer.status).toBe(404);
    expect(answer.json).toMatchObject({ code: "not_found" });
  });

  it("asks the Studio's own region to emit its snapshot", async () => {
    const { studioId } = await staleStudio("sg");
    sg.answers.emitStudioSnapshot = true;

    const answer = await repair(studioId);

    expect(answer.status).toBe(200);
    expect(sg.received).toEqual([{ side: "region", fn: "emitStudioSnapshot", args: [studioId], signed: true }]);
  });

  it("answers 404 when the Studio's region does not hold the Studio", async () => {
    const { studioId } = await staleStudio("sg");
    sg.answers.emitStudioSnapshot = false;

    const answer = await repair(studioId);

    expect(answer.status).toBe(404);
  });

  it("answers a region's refusal as a failure of ours, never as region_unavailable", async () => {
    const { studioId } = await staleStudio("sg");
    sg.answers.emitStudioSnapshot = () => {
      throw new StandInRefusal(400, "invalid_body");
    };

    const answer = await repair(studioId);

    expect(answer.status).toBe(500);
    expect(answer.json).not.toMatchObject({ code: "region_unavailable" });
  });

  it("answers 503 when the Studio's region cannot be reached", async () => {
    const { studioId } = await staleStudio("nowhere");

    const answer = await repair(studioId);

    expect(answer.status).toBe(503);
    expect(answer.json).toMatchObject({ code: "region_unavailable" });
  });
});
