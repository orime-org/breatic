// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test — the FULL cross-process lifecycle chain, end to end
 * against real Postgres (business + yjs) + real Redis Streams.
 *
 * This is the cutover's async path that the unit/integration tests above
 * only cover piecewise: a project delete enqueues an outbox row in the
 * business tx; the server relay forwards it to the durable
 * `project-lifecycle` Redis Stream; the collab consumer reads it and
 * soft-deletes the project's docs in the SEPARATE yjs DB. Here we drive
 * the real relay + the real consumer and assert the yjs doc is gone +
 * the outbox row is marked sent.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { eq, isNull } from "drizzle-orm";

import {
  initCore,
  db as coreDb,
  projectLifecycleOutbox,
} from "@breatic/core";
import * as yjsRepo from "@breatic/collab/src/services/yjs-documents.repo.js";
import { insertOutboxEvent } from "@server/modules/project/lifecycle-outbox.repo.js";
import { startLifecycleRelay } from "@server/modules/project/lifecycle-relay.js";
import { startLifecycleListener } from "@breatic/collab/src/services/lifecycle-listener.js";

initCore(process.env);

const PID = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
const META = `project-${PID}/meta`;
const CANVAS = `project-${PID}/canvas-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

// Minimal fake Hocuspocus — the delete handler kicks connections, and
// with no live connections that walk is a no-op.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeHocuspocus = { documents: new Map() } as any;

let stopRelay: { stop(): void };
let stopConsumer: () => Promise<void>;

/**
 * Poll until `check` resolves true or the timeout elapses.
 * @param check - Predicate polled every 100ms
 * @param timeoutMs - Max wait before throwing
 * @param label - Error label when never met
 */
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition '${label}' not met within ${timeoutMs}ms`);
}

beforeAll(() => {
  stopRelay = startLifecycleRelay();
  stopConsumer = startLifecycleListener(
    fakeHocuspocus,
    inject("REDIS_STREAM_URL"),
    "dev",
  );
});

afterAll(async () => {
  stopRelay.stop();
  await stopConsumer();
  await coreDb
    .delete(projectLifecycleOutbox)
    .where(eq(projectLifecycleOutbox.kind, "project:deleted"));
});

describe("lifecycle outbox → relay → stream → consumer chain", () => {
  it("a project:deleted outbox row drives a yjs soft-delete across the chain", async () => {
    // Seed live yjs docs for the project (in the SEPARATE yjs DB).
    await yjsRepo.upsertDocData(META, new Uint8Array([1]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2]));
    expect(await yjsRepo.fetchDocData(META)).not.toBeNull();

    // Enqueue the delete command in a business transaction (as the server
    // deleteProject path does), then let the real relay + consumer run.
    await coreDb.transaction(async (tx) => {
      await insertOutboxEvent(tx, {
        type: "project:deleted",
        projectId: PID,
        ts: Date.now(),
      });
    });

    // The chain soft-deletes the project's docs in the yjs DB.
    await waitFor(
      async () =>
        (await yjsRepo.fetchDocData(META)) === null &&
        (await yjsRepo.fetchDocData(CANVAS)) === null,
      15000,
      "yjs docs soft-deleted via the chain",
    );

    // The relay marked the outbox row sent (no longer unsent).
    await waitFor(
      async () => {
        const unsent = await coreDb
          .select({ id: projectLifecycleOutbox.id })
          .from(projectLifecycleOutbox)
          .where(isNull(projectLifecycleOutbox.sentAt));
        return unsent.length === 0;
      },
      15000,
      "outbox row marked sent",
    );
  });
});
