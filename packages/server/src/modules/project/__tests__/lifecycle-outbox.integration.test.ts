// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Forwarding the project-lifecycle outbox from several server instances
 * (inner#1497 §6.3, B8).
 *
 * Each row is taken in its own transaction with `FOR UPDATE SKIP LOCKED`, so
 * two relays running at once each get different rows and never forward the
 * same row.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { initCore } from "@breatic/core";
import type { ProjectLifecycleEvent } from "@breatic/shared";
import { forwardNextUnsent } from "@server/modules/project/lifecycle-outbox.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Insert unsent outbox rows.
 * @param count - How many.
 * @returns Their project ids, in insertion order.
 */
async function seed(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const projectId = randomUUID();
    const event: ProjectLifecycleEvent = { type: "project:archived", projectId, ts: Date.now() };
    await sql`INSERT INTO project_lifecycle_outbox (kind, payload) VALUES (${event.type}, ${sql.json(event as unknown as postgres.JSONValue)})`;
    ids.push(projectId);
  }
  return ids;
}

/**
 * Forward until the outbox has nothing left, recording what was published.
 * @param published - Receives each published event's project id.
 * @returns Resolves when a pass finds nothing.
 */
async function drain(published: string[]): Promise<void> {
  for (;;) {
    const result = await forwardNextUnsent(async (event) => {
      if ("projectId" in event) published.push(event.projectId);
      await new Promise((r) => setTimeout(r, 5));
    });
    if (!result) return;
  }
}

describe("forwardNextUnsent", () => {
  it("forwards each row once when two relays drain the outbox at the same time", async () => {
    const mine = new Set(await seed(30));
    const publishedA: string[] = [];
    const publishedB: string[] = [];

    await Promise.all([drain(publishedA), drain(publishedB)]);

    const ours = [...publishedA, ...publishedB].filter((id) => mine.has(id));
    expect(ours.sort()).toEqual([...mine].sort());
    expect(publishedA.filter((id) => mine.has(id)).length).toBeGreaterThan(0);
    expect(publishedB.filter((id) => mine.has(id)).length).toBeGreaterThan(0);
    const unsent = await sql`
      SELECT count(*)::int AS n FROM project_lifecycle_outbox
      WHERE sent_at IS NULL AND payload->>'projectId' = ANY(${[...mine]})`;
    expect(unsent[0]!.n).toBe(0);
  });

  it("forwards again only the row whose publish was not committed", async () => {
    await drain([]);
    const [first, second, third] = await seed(3);
    const published: string[] = [];

    // The second publish reaches the stream and then fails before its commit.
    for (;;) {
      const result = await forwardNextUnsent(async (event) => {
        if (!("projectId" in event)) return;
        published.push(event.projectId);
        if (event.projectId === second && published.filter((id) => id === second).length === 1) {
          throw new Error("lost before commit");
        }
      });
      if (!result) break;
    }

    expect(published.filter((id) => id === first)).toHaveLength(1);
    expect(published.filter((id) => id === second)).toHaveLength(2);
    expect(published.filter((id) => id === third)).toHaveLength(1);
  });

  it("leaves a row unsent and counts the attempt when the publish fails", async () => {
    await drain([]);
    const [projectId] = await seed(1);

    const result = await forwardNextUnsent(async () => {
      throw new Error("redis down");
    });

    expect(result?.error).toBeInstanceOf(Error);
    const rows = await sql`
      SELECT sent_at, attempts FROM project_lifecycle_outbox WHERE payload->>'projectId' = ${projectId!}`;
    expect(rows[0]!.sent_at).toBeNull();
    expect(rows[0]!.attempts).toBe(1);
  });
});
