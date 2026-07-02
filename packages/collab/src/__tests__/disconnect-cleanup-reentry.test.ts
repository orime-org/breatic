// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #1567 real-instance verification: does `cleanupOnDisconnect`'s
 * `await openDirectConnection(<same doc>)` INSIDE the onDisconnect hook
 * deadlock or recurse?
 *
 * Background: `feedback_hocuspocus_after_load_no_await_same_doc` proved
 * that awaiting openDirectConnection(same doc) inside afterLoadDocument
 * deadlocks (the doc's load promise is still pending while the hook
 * chain runs). disconnect-cleanup.ts:67 uses the same *pattern* from
 * onDisconnect, flagged 2026-06-18 as a suspected deadlock and never
 * verified (the unit test mocks openDirectConnection away).
 *
 * This test drives a REAL @hocuspocus/server instance (no network, no
 * PG — a 10-line in-memory store extension) with the production-shaped
 * onDisconnect wiring calling the REAL cleanupOnDisconnect, and
 * `unloadImmediately: true` to match config/collab.yaml. It pins:
 *
 *   1. NO DEADLOCK: the disconnect that triggers the cleanup resolves
 *      (a deadlock would time the test out).
 *   2. THE CLEANUP WORKS through the same-doc reopen: the u1-owned
 *      operationLock is stripped and persisted. (Option A, #1580 slice 4:
 *      handling is NOT reclaimed on disconnect — the lock strip is what
 *      proves the cleanup ran through the reopen.)
 *   3. NO RECURSION: the cleanup's own inner direct connection does not
 *      re-trigger onDisconnect into an unbounded cleanup loop (hook
 *      invocations stay bounded; two days of dev logs show zero
 *      system-context disconnects, this pins it structurally).
 *
 * Scope honesty: this drives the DirectConnection.disconnect path into
 * `hooks("onDisconnect")` (hocuspocus-server.cjs:2152). The production
 * trigger is a WS Connection's onClose (:2058) — a different call site
 * into the SAME hook chain with the same unload interplay; the per-doc
 * LOAD promise that deadlocked afterLoadDocument is not held in either
 * disconnect path. A full WS-socket repro would need a listening server
 * + provider client and is exercised by the real-browser smoke instead.
 */

import { describe, it, expect, vi } from "vitest";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";

// cleanupOnDisconnect imports createLogger from core; collab tests do not
// run initCore, so mock core with a no-op logger (standard pattern).
vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { cleanupOnDisconnect } from "@collab/hooks/disconnect-cleanup.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/canvas-22222222-2222-4222-9222-222222222222";

describe("#1567 disconnect-cleanup same-doc openDirectConnection re-entry (real Hocuspocus)", () => {
  it(
    "does not deadlock, cleans the node through the same-doc reopen, and does not recurse",
    { timeout: 15_000 },
    async () => {
      // 10-line in-memory store so the doc survives unloadImmediately
      // across the cleanup's reopen (production uses PG via the
      // persistence extension — same load/store contract).
      const store = new Map<string, Uint8Array>();
      const disconnectCalls: Array<string | undefined> = [];

      const server = new Server({
        // Match config/collab.yaml — the doc unloads as soon as its last
        // connection leaves, which is exactly the window the suspected
        // deadlock lives in.
        unloadImmediately: true,
        quiet: true,
        extensions: [
          {
            async onLoadDocument({ document, documentName }) {
              const stored = store.get(documentName);
              if (stored) Y.applyUpdate(document, stored);
              return document;
            },
            async onStoreDocument({ document, documentName }) {
              store.set(documentName, Y.encodeStateAsUpdate(document));
            },
          },
        ],
        // Production-shaped wiring (mirrors packages/collab/src/hocuspocus.ts):
        // every disconnect with a user context runs the REAL cleanup.
        onDisconnect: async ({ documentName, context }) => {
          const ctx = context as { user?: { id: string } };
          const userId = ctx.user?.id;
          disconnectCalls.push(userId);
          // Recursion guard FOR THE TEST ONLY: if the cleanup's inner
          // connection re-triggered onDisconnect in a loop, this array
          // would grow unbounded — the assertion below caps it. We still
          // call the real cleanup for every user-context disconnect,
          // exactly like production.
          if (userId && disconnectCalls.length < 10) {
            await cleanupOnDisconnect(server.hocuspocus, documentName, userId);
          }
        },
      });

      // ── Seed: a u1-owned frontend handling node + operationLock ──
      const seedConn = await server.hocuspocus.openDirectConnection(DOC, {
        user: { id: "u1" },
      });
      await seedConn.transact((doc) => {
        const nodesMap = doc.getMap<Y.Map<unknown>>("nodesMap");
        const node = new Y.Map<unknown>();
        const data = new Y.Map<unknown>();
        data.set("state", "handling");
        data.set("handlingBy", {
          userId: "u1",
          type: "frontend",
          startedAt: Date.now(),
        });
        data.set("operationLocks", [{ toolId: "adjust", userId: "u1" }]);
        node.set("id", "n1");
        node.set("data", data);
        nodesMap.set("n1", node);
      });

      // ── Trigger: last connection leaves → onDisconnect(u1) → REAL
      // cleanupOnDisconnect awaits openDirectConnection(SAME doc). A
      // deadlock here hangs this await → vitest timeout = proven true.
      await seedConn.disconnect();

      // Give the async unload/store tail a beat to settle.
      await new Promise((r) => setTimeout(r, 250));

      // ── 1+2. No deadlock (we got here) and the cleanup worked through
      // the reopen: read the persisted doc state fresh.
      const readConn = await server.hocuspocus.openDirectConnection(DOC, {
        user: { id: "reader" },
      });
      let state: unknown;
      let handlingBy: unknown;
      let locks: unknown;
      await readConn.transact((doc) => {
        const data = doc
          .getMap<Y.Map<unknown>>("nodesMap")
          .get("n1")
          ?.get("data") as Y.Map<unknown>;
        state = data.get("state");
        handlingBy = data.get("handlingBy");
        locks = data.get("operationLocks");
      });
      await readConn.disconnect();

      // Option A (#1580 slice 4): handling is NOT reclaimed on disconnect;
      // only the operationLock strip proves the cleanup ran through the reopen.
      expect(state).toBe("handling");
      expect(handlingBy).toMatchObject({ userId: "u1", type: "frontend" });
      expect(locks).toEqual([]);

      // ── 3. Bounded hook invocations: u1's disconnect, possibly the
      // cleanup/reader inner connections' own disconnects — but NOT an
      // unbounded recursion (the guard at 10 never trips).
      expect(disconnectCalls.length).toBeLessThan(10);

      await server.hocuspocus.closeConnections();
      // Server was never listen()ed — nothing else to tear down.
    },
  );
});
