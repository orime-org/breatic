// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap at the repository's default configuration (inner#1790,
 * test spec C-149 and C-152, D configuration: 10 MiB limit): editors of a full
 * canvas and of a document just past the full line reconnect with offline
 * edits without a trial, and per-update admission on a fragmented 8 MB text
 * stays within 20 ms.
 *
 * `Server` and `createLogger` are wrapped, not replaced, as in
 * `document-size-limit.integration.test.ts`; the `beforeSync` wrap also times
 * each production call with `performance.now()` (spec C-152).
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModuleShape from "@breatic/core";
import * as core from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, spaceContentDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { canvasDoc, fill, fragText, refMeasure } from "./helpers/document-size-fixtures.js";
import { openDoc, openSocket } from "./helpers/document-size-live.js";
import type { SizeDocClient, SizeSocket } from "./helpers/document-size-live.js";
import { SYNC } from "./helpers/live-hocuspocus.js";

const { state } = vi.hoisted(() => ({
  state: {
    timings: [] as Array<{ documentName: string; type: number; ms: number }>,
    logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }>,
  },
}));

vi.mock("@hocuspocus/server", async (importOriginal) => {
  const real = await importOriginal<typeof HocuspocusServerModule>();
  type Config = ConstructorParameters<typeof real.Server>[0];
  /**
   * Time every production `beforeSync` call.
   * @param config - What production passed.
   * @returns The configuration the real server gets.
   */
  const wrap = (config: Config): Config => {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const original = cfg.beforeSync as ((payload: unknown) => Promise<void>) | undefined;
    return {
      ...cfg,
      beforeSync: async (payload: { documentName: string; type: number }): Promise<void> => {
        const startedAt = performance.now();
        try {
          await original?.(payload);
        } finally {
          state.timings.push({ documentName: payload.documentName, type: payload.type, ms: performance.now() - startedAt });
        }
      },
    };
  };
  class Server extends real.Server {
    constructor(config: Config) {
      super(wrap(config));
    }
  }
  return { ...real, Server };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const real = await importOriginal<typeof CoreModuleShape>();
  return {
    ...real,
    createLogger: (...args: Parameters<typeof real.createLogger>): ReturnType<typeof real.createLogger> => {
      const logger = real.createLogger(...args);
      return new Proxy(logger, {
        get(target, prop, receiver): unknown {
          if (prop === "warn" || prop === "error") {
            return (...lineArgs: unknown[]): unknown => {
              state.logs.push({ level: prop, args: lineArgs });
              return Reflect.apply(Reflect.get(target, prop, receiver), target, lineArgs);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

/** Spec 0.2 D configuration, derived values. */
const FULL_AT_D = 10_223_616;
const WARN_AT_D = 8_388_608;

type Instance = Awaited<ReturnType<typeof createCollabServer>>;

core.initCore(process.env);
core.loadLocales();
const sockets: SizeSocket[] = [];
let active: Instance;

/**
 * A synced client on a new socket.
 * @param fixture - Whose session.
 * @param name - Document name.
 * @param doc - The client copy to bring.
 * @returns The client.
 */
async function syncedOn(fixture: ActivityCollabFixture, name: string, doc?: Y.Doc): Promise<SizeDocClient> {
  const socket = await openSocket(active.server.address.port, fixture.cookie);
  sockets.push(socket);
  const client = await openDoc(socket, name, { doc });
  await client.sync();
  return client;
}

/**
 * Trials the (document, user) pair used, from the real quota key.
 * @param name - Document name.
 * @param userId - User id.
 * @returns Its size, 0 when absent.
 */
async function trials(name: string, userId: string): Promise<number> {
  return core.getRedis().zcard(`${core.env.ENV}:ratelimit:collab-doc-size-trial:${name}:${userId}`);
}

/**
 * Refusal log lines for a document.
 * @param name - Document name.
 * @returns Their fields.
 */
function refusals(name: string): unknown[] {
  return state.logs
    .filter((l) => l.level === "warn" && l.args[1] === "document_size_limit_refused")
    .map((l) => l.args[0] as Record<string, unknown>)
    .filter((f) => f.documentName === name);
}

beforeAll(async () => {
  active = await createCollabServer({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"), redisKeyPrefix: `size-default-${randomUUID()}`, shutdownDeadline: () => undefined });
  await active.server.listen();
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (active) {
    active.stopUpgradeSessions();
    active.storeLoop.stop();
    await active.seatHandover.stop();
    await active.server.destroy();
  }
});

describe("default limit", () => {
  it("C-149 three editors reconnect at once with offline edits on a full canvas and a just-full document, untried", async () => {
    const fixture = await seedCollabActivity();
    const canvasName = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
    const documentName = spaceContentDocName(fixture.projectId, fixture.spaceIds.document, "document");
    const canvas = canvasDoc(20_000, 0.5);
    fill(canvas, FULL_AT_D + 1000);
    const text = new Y.Doc();
    fill(text, FULL_AT_D + 100);
    expect(refMeasure(text)).toBeGreaterThanOrEqual(FULL_AT_D);
    await yjsRepo.upsertDocData(canvasName, Y.encodeStateAsUpdate(canvas));
    await yjsRepo.upsertDocData(documentName, Y.encodeStateAsUpdate(text));

    for (const name of [canvasName, documentName]) {
      const editors: SizeDocClient[] = [];
      for (let i = 0; i < 3; i++) editors.push(await syncedOn(fixture, name));
      for (const e of editors) e.socket.close();
      const moveOne = (d: Y.Doc): void => {
        const nodes = d.getMap<Y.Map<unknown>>("nodes");
        const live = [...nodes.keys()][0];
        if (live !== undefined) nodes.get(live)?.set("x", 999);
      };
      const typeOne = (d: Y.Doc): void => d.getText("t").insert(5, "k");
      if (name === canvasName) {
        moveOne(editors[0]!.doc);
        typeOne(editors[1]!.doc);
        moveOne(editors[2]!.doc);
        typeOne(editors[2]!.doc);
      } else {
        for (const e of editors) typeOne(e.doc);
      }
      const back = await Promise.all(editors.map((e) => syncedOn(fixture, name, e.doc)));
      for (const c of back) await c.confirm();
      for (const c of back) expect(c.closeReasons()).not.toContain(COLLAB_DOCUMENT_TOO_LARGE_REASON);
      expect(refusals(name)).toEqual([]);
      expect(await trials(name, fixture.userId)).toBe(0);
    }
  });

  it("C-152 each of 100 single-character deletes on a fragmented 8 MB text is decided within 20 ms", async () => {
    const fixture = await seedCollabActivity();
    const name = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
    const src = fragText(425_000);
    const bytes = refMeasure(src);
    expect(bytes).toBeGreaterThanOrEqual(8_000_000);
    expect(bytes).toBeLessThan(8_400_000);
    expect(bytes).toBeLessThan(WARN_AT_D);
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(src));
    const client = await syncedOn(fixture, name);

    const pushesBefore = client.sizePushes().length;
    const timingsBefore = state.timings.length;
    const startedAt = Date.now();
    for (let i = 0; i < 100; i++) {
      client.edit((d) => {
        const t = d.getText("t");
        t.delete((i * 7919) % (t.length - 1), 1);
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.confirm();
    const totalMs = Date.now() - startedAt;

    expect(client.closeReasons()).not.toContain(COLLAB_DOCUMENT_TOO_LARGE_REASON);
    expect(refusals(name)).toEqual([]);
    const decided = state.timings.slice(timingsBefore).filter((t) => t.documentName === name && t.type === SYNC.update);
    expect(decided).toHaveLength(100);
    expect(Math.max(...decided.map((t) => t.ms))).toBeLessThanOrEqual(20);
    // Exact re-measures are what push `doc:size` while the phase stays normal.
    const remeasured = client.sizePushes().length - pushesBefore;
    expect(remeasured).toBeLessThanOrEqual(Math.ceil(totalMs / 2000) + 1);
  });
});
