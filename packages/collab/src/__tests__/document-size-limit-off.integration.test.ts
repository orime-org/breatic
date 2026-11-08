// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The cap switched off (inner#1790, second version; design 2 and 4.3, spec
 * answer Q9): an instance started with `max_document_bytes: 0` and the rest
 * of configuration S keeps no size record, tells every Space connection
 * `{ type: "doc:size", bytes: 0, limit: 0, ceiling: 0, phase: "normal" }`,
 * and never refuses a write, even on a document stored past the S ceiling.
 *
 * `createLogger` is wrapped, not replaced, to read the refusal lines.
 */

import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import * as core from "@breatic/core";
import { createCollabServer } from "@collab/hocuspocus.js";
import * as size from "@collab/services/document-size.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import { S, fill } from "./helpers/document-size-fixtures.js";
import { canvasOf, openDoc, openSocket, pushWhere, refusalsOf, seed, settle, startInstance, stopInstance } from "./helpers/document-size-live.js";
import type { Instance, SizeSocket } from "./helpers/document-size-live.js";

const { state } = vi.hoisted(() => ({
  state: { logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }> },
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

// Configuration S with the limit off.
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  const { S_CONFIG } = await import("./helpers/document-size-fixtures.js");
  return { ...real, getCollabConfig: () => ({ ...real.getCollabConfig(), ...S_CONFIG, max_document_bytes: 0 }) };
});

core.initCore(process.env);
core.loadLocales();
const sockets: SizeSocket[] = [];
let active: Instance;

beforeAll(async () => {
  active = await startInstance(createCollabServer, inject("REDIS_COLLAB_URL"));
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (active) await stopInstance(active);
});

describe("max_document_bytes 0", () => {
  it("Q9 a document past the S ceiling is told limit 0 with zero bytes and ceiling, keeps no record, and takes a 40 KiB add", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    expect(fill(src, 300_000)).toBeGreaterThanOrEqual(S.CEIL);
    await seed(name, src);
    const socket = await openSocket(active.server.address.port, fixture.cookie);
    sockets.push(socket);
    const tab = await openDoc(socket, name);
    await tab.sync();
    await pushWhere(tab, () => true, "connected push");
    expect(tab.sizePushes()).toEqual([{ type: "doc:size", seq: 0, bytes: 0, limit: 0, ceiling: 0, phase: "normal" }]);

    tab.edit((d) => {
      const t = d.getText("t");
      t.insert(t.length, "z".repeat(40 * 1024));
    });
    expect(await settle(tab)).toEqual([]);
    expect(active.hocuspocus.documents.get(name)?.getText("t").toString().endsWith("z".repeat(40 * 1024))).toBe(true);
    expect(size.readDocSizeRecord(name)).toBeUndefined();
    expect(refusalsOf(state.logs, name)).toEqual([]);
    expect(tab.sizePushes()).toHaveLength(1);
  });
});
