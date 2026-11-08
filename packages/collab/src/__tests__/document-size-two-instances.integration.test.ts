// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Two collab instances sharing Redis and the databases (inner#1790, second
 * version, v2 collab test spec I-12, S configuration): instance 2 learns
 * about A's write on instance 1 only through the update the Redis extension
 * forwards, which its `onChange` counts by length (design 4.3), and pushes
 * the new phase to B once that crosses the warning line.
 *
 * Each instance needs its own size records, which are module state, so
 * instance 2 is built from a fresh module graph (`vi.resetModules`) with its
 * own core initialised from the same environment. The `Server` constructor
 * is wrapped, not replaced: it records each `onChange` call with the
 * instance's record read just before and just after the production hook ran
 * its synchronous part, so the case sees what that one call counted whatever
 * a measurement does later.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as ConfigModuleShape from "@collab/config.js";
import * as core from "@breatic/core";
import { createCollabServer } from "@collab/hocuspocus.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import { S, fill } from "./helpers/document-size-fixtures.js";
import { V2_PUSH_KEYS, canvasOf, member, openDoc, openSocket, pushKeys, pushWhere, seed, settle, startInstance, stopInstance } from "./helpers/document-size-live.js";
import type { Instance, SizeSocket } from "./helpers/document-size-live.js";
import { SYNC, waitFor } from "./helpers/live-hocuspocus.js";

const { state } = vi.hoisted(() => ({
  state: {
    instances: 0,
    /** Instance index → reads that instance's `current` for a document. */
    readers: [] as Array<((name: string) => number | undefined) | undefined>,
    changes: [] as Array<{ instance: number; documentName: string; update: Uint8Array; source: unknown; before?: number; after?: number }>,
  },
}));

vi.mock("@hocuspocus/server", async (importOriginal) => {
  const real = await importOriginal<typeof HocuspocusServerModule>();
  type Config = ConstructorParameters<typeof real.Server>[0];
  type ChangePayload = { documentName: string; update: Uint8Array; transactionOrigin?: { source?: unknown } | null };
  /**
   * Record every `onChange` call of this instance with its record around the call.
   * @param config - What production passed.
   * @returns The configuration the real server gets.
   */
  const wrap = (config: Config): Config => {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const instance = state.instances++;
    const original = cfg.onChange as ((payload: ChangePayload) => Promise<void>) | undefined;
    return {
      ...cfg,
      onChange: (payload: ChangePayload): Promise<void> => {
        const read = state.readers[instance];
        const before = read?.(payload.documentName);
        const running = original?.(payload) ?? Promise.resolve();
        const after = read?.(payload.documentName);
        state.changes.push({ instance, documentName: payload.documentName, update: payload.update, source: payload.transactionOrigin?.source, before, after });
        return running;
      },
    } as Config;
  };
  class Server extends real.Server {
    constructor(config: Config) {
      super(wrap(config));
    }
  }
  return { ...real, Server };
});

// Spec 0.2 configuration S.
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  const { S_CONFIG } = await import("./helpers/document-size-fixtures.js");
  return { ...real, getCollabConfig: () => ({ ...real.getCollabConfig(), ...S_CONFIG }) };
});

core.initCore(process.env);
core.loadLocales();
const sockets: SizeSocket[] = [];
const running: Instance[] = [];

afterAll(async () => {
  for (const socket of sockets) socket.close();
  for (const instance of running) await stopInstance(instance);
});

describe("two instances on one Redis", () => {
  it("I-12 instance 2 counts A's forwarded write by its length and pushes the warning to B", async () => {
    const prefix = `document-size-two-${randomUUID()}`;
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    const bytes = fill(src, 230_000);
    expect(bytes).toBeLessThan(S.W);
    expect(bytes + 10_000).toBeGreaterThanOrEqual(S.W);
    await seed(name, src);

    const first = await startInstance(createCollabServer, inject("REDIS_COLLAB_URL"), prefix);
    running.push(first);
    const sizeFirst = await import("@collab/services/document-size.js");
    state.readers[state.instances - 1] = (n: string): number | undefined => sizeFirst.readDocSizeRecord(n)?.current;

    vi.resetModules();
    const coreSecond = await import("@breatic/core");
    coreSecond.initCore(process.env);
    coreSecond.loadLocales();
    const { createCollabServer: createSecond } = await import("@collab/hocuspocus.js");
    const sizeSecond = await import("@collab/services/document-size.js");
    expect(sizeSecond).not.toBe(sizeFirst);
    const second = await startInstance(createSecond, inject("REDIS_COLLAB_URL"), prefix);
    running.push(second);
    const instanceSecond = state.instances - 1;
    state.readers[instanceSecond] = (n: string): number | undefined => sizeSecond.readDocSizeRecord(n)?.current;

    const member2 = await member(fixture, "editor");
    const socketB = await openSocket(second.server.address.port, member2.cookie);
    sockets.push(socketB);
    const b = await openDoc(socketB, name);
    await b.sync();
    await pushWhere(b, () => true, "connected push");
    const fromB = b.sizePushes().length;

    const socketA = await openSocket(first.server.address.port, fixture.cookie);
    sockets.push(socketA);
    const a = await openDoc(socketA, name);
    await a.sync();
    const changesFrom = state.changes.length;
    a.edit((d) => {
      const t = d.getText("t");
      t.insert(t.length, "y".repeat(10_000));
    });
    expect(await settle(a)).toEqual([]);

    const expectedText = first.hocuspocus.documents.get(name)!.getText("t").toString();
    await waitFor(() => second.hocuspocus.documents.get(name)?.getText("t").toString() === expectedText, "instance 2 received A's update", 30_000);
    const forwarded = state.changes
      .slice(changesFrom)
      .filter((c) => c.instance === instanceSecond && c.documentName === name && c.source !== "connection");
    expect(forwarded.some((c) => c.update.byteLength >= 10_000)).toBe(true);
    for (const c of forwarded) expect(c.after! - c.before!).toBe(c.update.byteLength);

    const push = await pushWhere(b, (p) => p.phase === "warning", "warning push from instance 2", fromB);
    expect(pushKeys(push)).toEqual(V2_PUSH_KEYS);
  });

  it("R7-34 on instance 2 the full push reaches B before the forwarded update that crossed the limit", async () => {
    const prefix = `document-size-two-${randomUUID()}`;
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    const bytes = fill(src, 240_000);
    expect(bytes).toBeGreaterThanOrEqual(S.W);
    expect(bytes + 30_000).toBeGreaterThanOrEqual(S.L);
    await seed(name, src);

    vi.resetModules();
    const coreFirst = await import("@breatic/core");
    coreFirst.initCore(process.env);
    coreFirst.loadLocales();
    const { createCollabServer: createFirst } = await import("@collab/hocuspocus.js");
    const first = await startInstance(createFirst, inject("REDIS_COLLAB_URL"), prefix);
    running.push(first);
    vi.resetModules();
    const coreSecond = await import("@breatic/core");
    coreSecond.initCore(process.env);
    coreSecond.loadLocales();
    const { createCollabServer: createSecond } = await import("@collab/hocuspocus.js");
    const second = await startInstance(createSecond, inject("REDIS_COLLAB_URL"), prefix);
    running.push(second);

    const socketB = await openSocket(second.server.address.port, (await member(fixture, "editor")).cookie);
    sockets.push(socketB);
    const b = await openDoc(socketB, name);
    await b.sync();
    await pushWhere(b, () => true, "connected push");
    const socketA = await openSocket(first.server.address.port, fixture.cookie);
    sockets.push(socketA);
    const a = await openDoc(socketA, name);
    await a.sync();
    const since = socketB.frames.length;

    a.edit((d) => {
      const t = d.getText("t");
      t.insert(t.length, "y".repeat(30_000));
    });
    expect(await settle(a)).toEqual([]);
    await waitFor(() => b.doc.getText("t").length === 30_000, "B received A's update through instance 2", 30_000);
    const frames = socketB.frames.slice(since).filter((f) => f.documentName === name);
    const pushAt = frames.findIndex((f) => f.stateless !== undefined && (JSON.parse(f.stateless) as { type?: unknown; phase?: unknown }).type === "doc:size"
      && (JSON.parse(f.stateless) as { phase?: unknown }).phase === "full");
    const updateAt = frames.findIndex((f) => f.syncSubType === SYNC.update && (f.payload?.byteLength ?? 0) >= 30_000);
    expect(pushAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeLessThan(updateAt);
  });
});
