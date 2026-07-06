// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Property-based fencing invariants for `handleNodeStateUpdateEvent`
 * (#1580 #7, unified-gen design 2026-07-03).
 *
 * Model-based test: an arbitrary interleaving of handling-open and close
 * events (arbitrary gens, arbitrary order — simulating zombie late writes,
 * duplicated stream deliveries, and retries) is applied both to the real
 * handler (real Y.Doc) and to a tiny reference model that restates the
 * CAS spec. The doc must end in exactly the model's state. Invariants:
 *
 *   1. `leaseGen` is monotonically non-decreasing.
 *   2. A close lands iff its gen equals the live lease's gen at that moment.
 *   3. An open lands iff its gen >= the current leaseGen.
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import fc from "fast-check";
import type { Hocuspocus } from "@hocuspocus/server";
import type { NodeStateUpdateEvent } from "@breatic/shared";

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  };
});
vi.mock("../services/event-stream.js", () => ({
  startStreamConsumer: vi.fn(),
}));

import { handleNodeStateUpdateEvent } from "../services/task-listener.js";

const DOC_NAME =
  "project-11111111-1111-4111-8111-111111111111/canvas-22222222-2222-4222-9222-222222222222";
const NODE_ID = "node-prop";

/** One step of the generated event sequence. */
type Op =
  | { kind: "open"; gen: number }
  | { kind: "close"; gen: number; content: string };

/**
 * Build a fresh doc with the canvas layout and one idle node.
 * @returns The seeded Y.Doc.
 */
function freshDoc(): Y.Doc {
  const doc = new Y.Doc();
  const nodesMap = doc.getMap("nodesMap");
  const nodeMap = new Y.Map();
  nodesMap.set(NODE_ID, nodeMap);
  const dataMap = new Y.Map();
  dataMap.set("state", "idle");
  nodeMap.set("data", dataMap);
  return doc;
}

/**
 * Wrap a doc in a Hocuspocus stub the handler can transact against.
 * @param doc - The doc the stubbed direct connection operates on.
 * @returns The stubbed Hocuspocus instance.
 */
function stubHocuspocus(doc: Y.Doc): Hocuspocus {
  return {
    openDirectConnection: async () => ({
      transact: async (cb: (d: Y.Doc) => void) => {
        cb(doc);
      },
      disconnect: async () => undefined,
    }),
  } as unknown as Hocuspocus;
}

/**
 * Translate an op into the wire event the server / worker would emit.
 * @param op - The generated open / close step.
 * @returns The node-state-update event.
 */
function toEvent(op: Op): NodeStateUpdateEvent {
  if (op.kind === "open") {
    return {
      type: "node-state-update",
      docName: DOC_NAME,
      nodeId: NODE_ID,
      gen: op.gen,
      update: {
        state: "handling",
        handlingBy: {
          userId: "u1",
          type: "backend",
          startedAt: 1_700_000_000_000,
          gen: op.gen,
        },
      },
    };
  }
  return {
    type: "node-state-update",
    docName: DOC_NAME,
    nodeId: NODE_ID,
    gen: op.gen,
    update: { state: "idle", content: op.content, handlingBy: undefined },
  };
}

/** Reference model: the CAS spec restated in three lines per op. */
interface Model {
  leaseGen: number;
  liveGen: number | null;
  content: string | undefined;
  state: "idle" | "handling";
}

/**
 * Apply one op to the reference model per the fencing spec.
 * @param m - The model state (mutated in place).
 * @param op - The op to apply.
 */
function applyToModel(m: Model, op: Op): void {
  if (op.kind === "open") {
    if (op.gen >= m.leaseGen) {
      m.leaseGen = op.gen;
      m.liveGen = op.gen;
      m.state = "handling";
    }
    return;
  }
  if (m.liveGen !== null && m.liveGen === op.gen) {
    m.content = op.content;
    m.state = "idle";
    m.liveGen = null;
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant<"open">("open"),
    gen: fc.integer({ min: 1, max: 6 }),
  }),
  fc.record({
    kind: fc.constant<"close">("close"),
    gen: fc.integer({ min: 1, max: 6 }),
    content: fc.string({ minLength: 1, maxLength: 8 }),
  }),
);

describe("fencing property (#1580 #7)", () => {
  it("an arbitrary event interleaving converges to the reference model", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 24 }), async (ops) => {
        const doc = freshDoc();
        const hocuspocus = stubHocuspocus(doc);
        const model: Model = {
          leaseGen: 0,
          liveGen: null,
          content: undefined,
          state: "idle",
        };

        let lastLeaseGen = 0;
        for (const op of ops) {
          await handleNodeStateUpdateEvent(hocuspocus, toEvent(op));
          applyToModel(model, op);

          const dataMap = (
            doc.getMap("nodesMap").get(NODE_ID) as Y.Map<unknown>
          ).get("data") as Y.Map<unknown>;
          const leaseGen = (dataMap.get("leaseGen") as number | undefined) ?? 0;
          // Invariant 1: leaseGen never decreases.
          expect(leaseGen).toBeGreaterThanOrEqual(lastLeaseGen);
          lastLeaseGen = leaseGen;
        }

        const dataMap = (
          doc.getMap("nodesMap").get(NODE_ID) as Y.Map<unknown>
        ).get("data") as Y.Map<unknown>;
        expect((dataMap.get("leaseGen") as number | undefined) ?? 0).toBe(
          model.leaseGen,
        );
        expect(dataMap.get("state")).toBe(model.state);
        expect(dataMap.get("content") as string | undefined).toBe(model.content);
        const hb = dataMap.get("handlingBy") as { gen: number } | undefined;
        expect(hb?.gen ?? null).toBe(model.liveGen);
      }),
      { numRuns: 200 },
    );
  });
});

describe("gen=0 missing-gen done is fenced (#1618 sole-guard)", () => {
  it("a done event carrying gen=0 does NOT clobber a live lease (gen>=1)", async () => {
    const doc = freshDoc();
    const hocuspocus = stubHocuspocus(doc);

    // Establish a live lease at gen 3.
    await handleNodeStateUpdateEvent(
      hocuspocus,
      toEvent({ kind: "open", gen: 3 }),
    );

    // A worker whose job payload lost the gen emits a done with gen=0
    // (genOf falls back to 0). After #1618 removed the worker-side
    // verifyCanvasNodeLock discard, the collab gen fence is the SOLE guard
    // against a stale result landing — it MUST drop this event.
    await handleNodeStateUpdateEvent(
      hocuspocus,
      toEvent({ kind: "close", gen: 0, content: "stale-result" }),
    );

    const dataMap = (
      doc.getMap("nodesMap").get(NODE_ID) as Y.Map<unknown>
    ).get("data") as Y.Map<unknown>;
    // The live lease is untouched: still handling, no stale content landed,
    // lease gen still 3, handlingBy still the live gen.
    expect(dataMap.get("state")).toBe("handling");
    expect(dataMap.get("content")).toBeUndefined();
    expect(dataMap.get("leaseGen")).toBe(3);
    expect((dataMap.get("handlingBy") as { gen: number }).gen).toBe(3);
  });
});
