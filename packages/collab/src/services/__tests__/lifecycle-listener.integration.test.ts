// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Lifecycle commands across two collab instances (inner#1497 §6.2, B4, B5).
 *
 * Two lifecycle consumers share one stream, and two control-plane subscribers
 * stand for the two instances' control planes. Each instance's Hocuspocus is a
 * stand-in holding one connection per document, which records how it was
 * closed: what is under test is that the copy runs once and that both
 * instances close their own connections.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import { createRedisClient, initCore, publishProjectConnectionsClose, type Redis } from "@breatic/core";
import type { ProjectConnectionsCloseReason, ProjectLifecycleEvent } from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { startProjectControlSync } from "@collab/services/project-control-sync.js";
import type { GroupConsumer, GroupConsumerSettings } from "@collab/services/stream-group-consumer.js";
import { startLifecycleListener } from "@collab/services/lifecycle-listener.js";

const SETTINGS: GroupConsumerSettings = {
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
};

let stream: Redis;
let coordination: Redis;
const stops: Array<() => Promise<void>> = [];
const consumers: GroupConsumer[] = [];

beforeAll(() => {
  initCore(process.env);
  stream = createRedisClient(process.env.REDIS_STREAM_URL!, { name: "itest-lifecycle-stream" });
  coordination = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-lifecycle-coord" });
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
  await Promise.all(stops.splice(0).map((s) => s()));
});

afterAll(async () => {
  await stream.quit();
  await coordination.quit();
});

/**
 * A stand-in instance: one recorded connection per document.
 * @param docNames - Documents it holds.
 * @returns Its server and the closes it saw.
 */
function fakeInstance(docNames: string[]): { hocuspocus: Hocuspocus; closed: Array<{ docName: string; code: number }> } {
  const closed: Array<{ docName: string; code: number }> = [];
  const documents = new Map<string, { connections: Map<unknown, unknown> }>();
  for (const docName of docNames) {
    documents.set(
      docName,
      {
        connections: new Map([
          [{ context: { user: { id: "u" } }, close: ({ code }: { code: number }) => closed.push({ docName, code }) }, {}],
        ]),
      },
    );
  }
  return { hocuspocus: { documents } as unknown as Hocuspocus, closed };
}

/**
 * Wait until a condition holds; a check that throws counts as not yet.
 * @param check - The condition.
 * @param timeoutMs - How long to keep trying.
 */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

/**
 * Two consumers on a stream, counting publishes.
 * @param streamKey - The stream; a fresh one when omitted.
 * @returns The stream key and the publishes so far.
 */
function startTwoConsumers(
  streamKey = `itest:stream:lifecycle:${randomUUID()}`,
): { streamKey: string; published: Array<[string, ProjectConnectionsCloseReason]> } {
  const id = randomUUID();
  const published: Array<[string, ProjectConnectionsCloseReason]> = [];
  for (const name of ["a", "b"]) {
    consumers.push(
      startLifecycleListener({
        streamUrl: process.env.REDIS_STREAM_URL!,
        streamKey,
        legacyCursorKey: `itest:cursor:${id}`,
        keyPrefix: `itest-${id}`,
        instanceId: name,
        coordination,
        settings: SETTINGS,
        publish: async (projectId, reason) => {
          published.push([projectId, reason]);
          await publishProjectConnectionsClose(projectId, reason);
        },
      }),
    );
  }
  return { streamKey, published };
}

/**
 * Append a lifecycle command.
 * @param streamKey - The stream.
 * @param event - The command.
 */
async function send(streamKey: string, event: ProjectLifecycleEvent): Promise<void> {
  await stream.xadd(streamKey, "*", "payload", JSON.stringify(event));
}

describe("lifecycle commands across two collab instances", () => {
  it("closes the project's connections on every instance when it is archived", async () => {
    const pid = randomUUID();
    const a = fakeInstance([`project-${pid}/meta`]);
    const b = fakeInstance([`project-${pid}/canvas-${randomUUID()}`]);
    stops.push(startProjectControlSync(a.hocuspocus, stream), startProjectControlSync(b.hocuspocus, stream));
    const { streamKey, published } = startTwoConsumers();
    await new Promise((r) => setTimeout(r, 200));

    await send(streamKey, { type: "project:archived", projectId: pid, ts: Date.now() });

    await until(() => a.closed.length === 1 && b.closed.length === 1);
    expect(a.closed[0]!.code).toBe(4407);
    expect(b.closed[0]!.code).toBe(4407);
    expect(published).toEqual([[pid, "archived"]]);
  });

  it("closes the project's connections on every instance when it is restored", async () => {
    const pid = randomUUID();
    const a = fakeInstance([`project-${pid}/meta`]);
    const b = fakeInstance([`project-${pid}/canvas-${randomUUID()}`]);
    stops.push(startProjectControlSync(a.hocuspocus, stream), startProjectControlSync(b.hocuspocus, stream));
    const { streamKey, published } = startTwoConsumers();
    await new Promise((r) => setTimeout(r, 200));

    await send(streamKey, { type: "project:restored", projectId: pid, ts: Date.now() });

    await until(() => a.closed.length === 1 && b.closed.length === 1);
    expect(a.closed[0]!.code).toBe(4408);
    expect(b.closed[0]!.code).toBe(4408);
    expect(published).toEqual([[pid, "restored"]]);
  });

  it("skips an entry whose payload is not an object without failing the rest of its batch", async () => {
    const pid = randomUUID();
    const a = fakeInstance([`project-${pid}/meta`]);
    stops.push(startProjectControlSync(a.hocuspocus, stream));
    // Both written before any consumer reads, so they arrive in one batch.
    const id = randomUUID();
    const streamKey = `itest:stream:lifecycle:${id}`;
    await stream.xadd(streamKey, "*", "payload", "null");
    await send(streamKey, { type: "project:archived", projectId: pid, ts: Date.now() });
    const { published } = startTwoConsumers(streamKey);

    await until(() => a.closed.length === 1);
    expect(published).toEqual([[pid, "archived"]]);
    await until(async () => Number(((await stream.xpending(streamKey, "collab-lifecycle")) as [number])[0]) === 0);
  });

  it("copies a duplicate once and then closes the new project's connections on every instance", async () => {
    const source = randomUUID();
    const target = randomUUID();
    const sourceMeta = new Y.Doc();
    sourceMeta.getMap("spaces").set("s1", "seeded");
    await yjsRepo.seedInitialState(`project-${source}/meta`, Y.encodeStateAsUpdate(sourceMeta));
    const a = fakeInstance([`project-${target}/meta`]);
    const b = fakeInstance([`project-${target}/meta`]);
    stops.push(startProjectControlSync(a.hocuspocus, stream), startProjectControlSync(b.hocuspocus, stream));
    const { streamKey, published } = startTwoConsumers();
    await new Promise((r) => setTimeout(r, 200));

    await send(streamKey, { type: "project:duplicated", sourceId: source, newId: target, ts: Date.now() });

    await until(() => a.closed.length === 1 && b.closed.length === 1);
    expect(a.closed[0]!.code).toBe(4406);
    expect(b.closed[0]!.code).toBe(4406);
    expect(published).toEqual([[target, "content-updated"]]);
    expect(await yjsRepo.fetchDocData(`project-${target}/meta`)).not.toBeNull();
  });
});
