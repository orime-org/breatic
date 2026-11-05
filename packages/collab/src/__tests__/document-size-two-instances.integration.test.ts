// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Two collab instances sharing Redis and the databases (inner#1790, test spec
 * C-145): instance B learns about growth on instance A only through the
 * updates the Redis extension forwards, counted by `onChange` (design 4.3),
 * and refuses on its own once its record says the document is full.
 *
 * Each instance needs its own size records, which are module state, so B is
 * built from a fresh module graph (`vi.resetModules`) with its own core
 * initialised from the same environment. The `Server` constructor and
 * `createLogger` are wrapped, not replaced, as in
 * `document-size-limit.integration.test.ts`; the wrap also records every
 * `onChange` call with the instance it belongs to.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import * as core from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, spaceContentDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import { fill, onChangeBound, refMeasure, updateShape } from "./helpers/document-size-fixtures.js";
import { openDoc, openSocket } from "./helpers/document-size-live.js";
import type { SizeSocket } from "./helpers/document-size-live.js";
import { waitFor } from "./helpers/live-hocuspocus.js";

const { state } = vi.hoisted(() => ({
  state: {
    // Spec C-145: the I configuration with a 20 000-byte full margin and an
    // exact re-measure interval long enough not to cancel the upper bound.
    config: {
      max_document_bytes: 262_144,
      document_size_warn_ratio: 0.8,
      document_size_full_margin_bytes: 20_000,
      document_size_delete_headroom_bytes: 6554,
      document_size_overwrite_reserve_bytes: 1638,
      document_size_measure_interval_ms: 600_000,
      document_size_trials_per_user_per_minute: 6,
      document_size_trial_budget_ms_per_second: 200,
    },
    configs: [] as Array<Record<string, unknown>>,
    changes: [] as Array<{ instance: number; documentName: string; update: Uint8Array; source: string | undefined }>,
    logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }>,
  },
}));

vi.mock("@hocuspocus/server", async (importOriginal) => {
  const real = await importOriginal<typeof HocuspocusServerModule>();
  type Config = ConstructorParameters<typeof real.Server>[0];
  /**
   * Record the configuration and every `onChange` call of this instance.
   * @param config - What production passed.
   * @returns The configuration the real server gets.
   */
  const wrap = (config: Config): Config => {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const instance = state.configs.push(cfg) - 1;
    const original = cfg.onChange as ((payload: unknown) => Promise<void>) | undefined;
    return {
      ...cfg,
      onChange: async (payload: { documentName: string; update: Uint8Array; transactionOrigin?: { source?: string } | null }): Promise<void> => {
        state.changes.push({ instance, documentName: payload.documentName, update: payload.update, source: payload.transactionOrigin?.source });
        await original?.(payload);
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

afterAll(async () => {
  for (const socket of sockets) socket.close();
  for (const instance of running) {
    instance.stopUpgradeSessions();
    instance.storeLoop.stop();
    await instance.seatHandover.stop();
    await instance.server.destroy();
  }
});

describe("two instances on one Redis", () => {
  it("C-145 B counts A's growth from forwarded updates, pushes the phases and refuses on its own", async () => {
    const prefix = `document-size-two-${randomUUID()}`;
    const fixture = await seedCollabActivity();
    const name = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
    const src = new Y.Doc();
    fill(src, 150_000);
    await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(src));

    const a = await createCollabServer({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"), redisKeyPrefix: prefix, shutdownDeadline: () => undefined });
    running.push(a);
    await a.server.listen();
    const instanceA = state.configs.length - 1;

    vi.resetModules();
    const coreB = (await import("@breatic/core"));
    coreB.initCore(process.env);
    coreB.loadLocales();
    const { createCollabServer: createB } = (await import("@collab/hocuspocus.js"));
    const sizeB = await import("@collab/services/document-size.js");
    const b = await createB({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"), redisKeyPrefix: prefix, shutdownDeadline: () => undefined });
    running.push(b);
    await b.server.listen();
    const instanceB = state.configs.length - 1;
    expect(instanceB).not.toBe(instanceA);

    const socketB = await openSocket(b.server.address.port, fixture.cookie);
    sockets.push(socketB);
    const onB = await openDoc(socketB, name);
    await onB.sync();
    const loadedOnB = sizeB.readDocSizeRecord(name);
    expect(loadedOnB).toBeDefined();

    const socketA = await openSocket(a.server.address.port, fixture.cookie);
    sockets.push(socketA);
    const onA = await openDoc(socketA, name);
    await onA.sync();
    for (let i = 0; i < 9; i++) {
      onA.edit((d) => {
        const t = d.getText("t");
        t.insert(t.length, "y".repeat(10_240));
      });
      await onA.confirm();
      expect(refMeasure(a.hocuspocus.documents.get(name)!)).toBeLessThanOrEqual(262_144);
    }
    expect(onA.closeReasons()).not.toContain(COLLAB_DOCUMENT_TOO_LARGE_REASON);

    const expectedText = a.hocuspocus.documents.get(name)!.getText("t").toString();
    await waitFor(() => b.hocuspocus.documents.get(name)?.getText("t").toString() === expectedText, "B received A's nine updates", 30_000);
    const forwarded = state.changes.filter((c) => c.instance === instanceB && c.documentName === name && c.source === "redis");
    expect(forwarded).toHaveLength(9);
    for (const c of forwarded) expect(updateShape(c.update).ranges).toBe(0);
    const counted = forwarded.reduce((sum, c) => sum + onChangeBound(c.update), 0);
    expect(sizeB.readDocSizeRecord(name)?.upper).toBe(loadedOnB!.exact + counted);

    const phases = onB.sizePushes().map((p) => p.phase);
    const changes = phases.filter((p, i) => i > 0 && p !== phases[i - 1]);
    expect(phases[0]).toBe("normal");
    expect(changes).toEqual(["warning", "full"]);

    onB.edit((d) => {
      const t = d.getText("t");
      t.insert(t.length, "y".repeat(20_480));
    });
    await waitFor(() => onB.closeReasons().includes(COLLAB_DOCUMENT_TOO_LARGE_REASON), "B refused the append", 30_000);
    const refusedOnB = state.logs
      .filter((l) => l.level === "warn" && l.args[1] === "document_size_limit_refused")
      .map((l) => l.args[0] as Record<string, unknown>)
      .filter((f) => f.documentName === name);
    expect(refusedOnB.map((f) => f.step)).toEqual(["trial"]);
  });
});
