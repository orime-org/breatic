// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Integration test — the FULL cross-process lifecycle chain, end to end
 * against real Postgres (business + yjs) + real Redis Streams.
 *
 * This is the async path that the unit/integration tests above only cover
 * piecewise: archiving a project enqueues an outbox row in the business tx;
 * the server relay forwards it to the durable `project-lifecycle` Redis
 * Stream; the collab consumer reads it and asks every collab instance, over
 * the project control channel, to close the project's live connections so
 * they re-authenticate read-only. Here we drive the real relay, the real
 * consumer and the real control-plane subscriber, and assert the connection
 * was closed with the archive reason, the yjs docs are untouched, and the
 * outbox row is marked sent.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { eq, isNull } from "drizzle-orm";

import {
  initCore,
  createRedisClient,
  db as coreDb,
  lifecycleStreamKey,
  projectLifecycleOutbox,
  type Redis,
} from "@breatic/core";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { insertOutboxEvent } from "@server/modules/project/lifecycle-outbox.repo.js";
import { startLifecycleRelay } from "@server/modules/project/lifecycle-relay.js";
import { startLifecycleListener } from "@collab/services/lifecycle-listener.js";
import { startProjectControlSync } from "@collab/services/project-control-sync.js";
import type { GroupConsumer } from "@collab/services/stream-group-consumer.js";

initCore(process.env);

const PID = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
const META = `project-${PID}/meta`;
const CANVAS = `project-${PID}/canvas-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

// Minimal fake Hocuspocus holding one live connection on the project's meta
// doc; the archive handler closes it, and records the reason it was given.
const closedWith: string[] = [];
const liveConnections = new Map<unknown, unknown>([
  [
    {
      context: { user: { id: "u1" } },
      close: ({ reason }: { reason: string }) => closedWith.push(reason),
    },
    { clients: new Set<number>() },
  ],
]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeHocuspocus = { documents: new Map([[META, { connections: liveConnections }]]) } as any;

let stopRelay: { stop(): void };
let consumer: GroupConsumer;
let stopProjectControlSync: () => Promise<void>;
let streamRedis: Redis;
let coordination: Redis;

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
  streamRedis = createRedisClient(inject("REDIS_STREAM_URL"), { name: "itest-chain-stream" });
  coordination = createRedisClient(inject("REDIS_COLLAB_URL"), { name: "itest-chain-coord" });
  stopProjectControlSync = startProjectControlSync(fakeHocuspocus, streamRedis);
  stopRelay = startLifecycleRelay();
  consumer = startLifecycleListener({
    streamUrl: inject("REDIS_STREAM_URL"),
    streamKey: lifecycleStreamKey(),
    legacyCursorKey: "dev:collab:project-lifecycle:last-id",
    keyPrefix: "dev",
    instanceId: "itest-chain",
    coordination,
    settings: {
      maxHeld: 16,
      keyConcurrency: 16,
      blockMs: 100,
      leaseRetryMs: 50,
      claimIntervalMs: 15_000,
      claimIdleMs: 60_000,
      retryMinMs: 50,
      retryMaxMs: 200,
      maxFailures: 3,
      stopDeadlineMs: 2000,
      forgetIdleConsumerMs: 24 * 60 * 60 * 1000,
    },
  });
});

afterAll(async () => {
  stopRelay.stop();
  await consumer.stop();
  await stopProjectControlSync();
  await streamRedis.quit();
  await coordination.quit();
  await coreDb
    .delete(projectLifecycleOutbox)
    .where(eq(projectLifecycleOutbox.kind, "project:archived"));
});

describe("lifecycle outbox → relay → stream → consumer chain", () => {
  it("a project:archived outbox row closes the project's live connections across the chain", async () => {
    // Seed live yjs docs for the project (in the SEPARATE yjs DB).
    await yjsRepo.upsertDocData(META, new Uint8Array([1]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2]));

    // Enqueue the archive command in a business transaction (as the server
    // archive path does), then let the real relay + consumer run.
    await coreDb.transaction(async (tx) => {
      await insertOutboxEvent(tx, {
        type: "project:archived",
        projectId: PID,
        ts: Date.now(),
      });
    });

    await waitFor(
      async () => closedWith.length > 0,
      15000,
      "live connection closed via the chain",
    );
    expect(closedWith).toEqual(["Project archived"]);

    // Archiving keeps every document.
    expect(await yjsRepo.fetchDocData(META)).not.toBeNull();
    expect(await yjsRepo.fetchDocData(CANVAS)).not.toBeNull();

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
