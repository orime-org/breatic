// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Turning the cap off with a restart (inner#1790, test spec C-151): a tab whose
 * document was `full` under the I configuration reconnects to an instance
 * started with `max_document_bytes: 0`, is told `limit = 0`, and can add again.
 *
 * Configuration is read once per process (C-21), so the second instance is
 * built from a fresh module graph after the configuration changes, the way a
 * restarted collab would read it. `Server` and `createLogger` are wrapped, not
 * replaced, as in `document-size-limit.integration.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import type * as SizeModuleShape from "@collab/services/document-size.js";
import * as core from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, spaceContentDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import { fill } from "./helpers/document-size-fixtures.js";
import { openDoc, openSocket } from "./helpers/document-size-live.js";
import type { SizeSocket } from "./helpers/document-size-live.js";

const { state } = vi.hoisted(() => ({
  state: {
    // Spec 10.2 I configuration.
    config: {
      max_document_bytes: 262_144,
      document_size_warn_ratio: 0.8,
      document_size_full_margin_bytes: 6554,
      document_size_delete_headroom_bytes: 6554,
      document_size_overwrite_reserve_bytes: 1638,
      document_size_measure_interval_ms: 2000,
      document_size_trials_per_user_per_minute: 6,
      document_size_trial_budget_ms_per_second: 200,
    },
    logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }>,
  },
}));

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

vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  return { ...real, getCollabConfig: () => ({ ...real.getCollabConfig(), ...state.config }) };
});

type Instance = Awaited<ReturnType<typeof createCollabServer>>;

core.initCore(process.env);
core.loadLocales();
const sockets: SizeSocket[] = [];
const running: Instance[] = [];

/**
 * Stop an instance the way shutdown does.
 * @param instance - The instance.
 */
async function stop(instance: Instance): Promise<void> {
  instance.stopUpgradeSessions();
  instance.storeLoop.stop();
  await instance.seatHandover.stop();
  await instance.server.destroy();
}

afterAll(async () => {
  for (const socket of sockets) socket.close();
  for (const instance of running) await stop(instance);
});

describe("max_document_bytes changed to 0 and collab restarted", () => {
  it("C-151 a full tab reconnects, is told limit 0, and adds 40 KiB", async () => {
    const fixture = await seedCollabActivity();
    const name = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
    const src = new Y.Doc();
    fill(src, 255_590 + 1000);
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(src));

    const first = await createCollabServer({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"), redisKeyPrefix: `size-off-${randomUUID()}`, shutdownDeadline: () => undefined });
    await first.server.listen();
    const socket = await openSocket(first.server.address.port, fixture.cookie);
    sockets.push(socket);
    const tab = await openDoc(socket, name);
    await tab.sync();
    expect(tab.sizePushes().at(-1)?.phase).toBe("full");
    await stop(first);

    state.config = { ...state.config, max_document_bytes: 0 };
    vi.resetModules();
    const coreNext = (await import("@breatic/core"));
    coreNext.initCore(process.env);
    coreNext.loadLocales();
    const { createCollabServer: createNext } = (await import("@collab/hocuspocus.js"));
    const sizeNext = (await import("@collab/services/document-size.js")) as typeof SizeModuleShape;
    const next = await createNext({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"), redisKeyPrefix: `size-off-${randomUUID()}`, shutdownDeadline: () => undefined });
    running.push(next);
    await next.server.listen();

    const socketNext = await openSocket(next.server.address.port, fixture.cookie);
    sockets.push(socketNext);
    const back = await openDoc(socketNext, name, { doc: tab.doc });
    await back.sync();
    expect(back.sizePushes()).toEqual([
      { type: "doc:size", bytes: 0, limit: 0, ceiling: 0, room: 0, overwriteRoom: 0, phase: "normal" },
    ]);
    back.edit((d) => {
      const t = d.getText("t");
      t.insert(t.length, "z".repeat(40 * 1024));
    });
    await back.confirm();
    expect(back.closeReasons()).not.toContain(COLLAB_DOCUMENT_TOO_LARGE_REASON);
    expect(next.hocuspocus.documents.get(name)?.getText("t").toString().endsWith("z".repeat(40 * 1024))).toBe(true);
    expect(sizeNext.readDocSizeRecord(name)).toBeUndefined();
  });
});
