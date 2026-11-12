// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Rigging a generated 3D model (inner#1692, design 6.2 and 7.1): with
 * `rig_skeleton` on, a Tripo run takes an optional `rig` step after its own
 * generation. The rig step posts the generated model's address to
 * `tripo3d/rig`; when it fails for good the run still delivers the generated
 * model, says so with `notice: 'rig_failed'`, and bills only the generation.
 *
 * Invariants, for every rig outcome, attempt and redelivery:
 * - the generation is posted once across all pickups;
 * - the delivered address is the rig output when the rig succeeded, the
 *   generation output otherwise;
 * - billed predictions are exactly the steps that succeeded;
 * - `notice` is `rig_failed` exactly when the rig step ended failed;
 * - `StillRunning` and `DeadlinePassed` always propagate, a network error or
 *   5xx propagates unless this is the last attempt, and nothing else does.
 *
 * Runs against the real three_d catalog, which declares the rig step.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fc from "fast-check";
import { initCore } from "@breatic/core";
import type { upstreamStepRepo } from "@breatic/domain";
import type * as httpModule from "@worker/providers/http.js";

type Step = upstreamStepRepo.UpstreamStep;

const runPredictionMock = vi.fn();
const queryBillingMock = vi.fn();

vi.mock("@worker/providers/wavespeed.js", () => ({
  runPrediction: (...args: unknown[]) => runPredictionMock(...args),
}));

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return { ...actual, queryBilling: (...args: unknown[]) => queryBillingMock(...args) };
});

const { runCatalogTask } = await import("@worker/providers/run-steps.js");
const { UpstreamTaskFailed, HttpStatusError } = await import("@worker/providers/http.js");
const { StillRunning } = await import("@worker/providers/still-running.js");
const { DeadlinePassed } = await import("@breatic/shared");

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test", WAVESPEED_API_KEY: "test-key" });
});

const TASK = "0f5c2c7e-1111-4222-8333-944455556666";
const MODEL = "tripo-h3.1-t23d";
const GENERATE = "tripo3d/h3.1/text-to-3d";
const RIG = "tripo3d/rig";
const GEN_URL = "https://cdn/tripo/model.glb";
const RIG_URL = "https://cdn/tripo/rigged.glb";
const PROMPT = "a knight in plate armour";
const PRICE_PER_PREDICTION = 0.01;

/** The options `runPrediction` is handed. */
interface PredictionOptions {
  storedTaskId: string | null;
  persistTaskId: (id: string) => Promise<void>;
}

/**
 * In-memory step storage, optionally holding steps a previous pickup left.
 * @param preset - Steps already stored.
 * @returns The steps and the dependencies.
 */
function stores(preset: Step[] = []): { steps: Step[]; deps: Parameters<typeof runCatalogTask>[0] } {
  const steps: Step[] = preset.map((s) => ({ ...s, output: { ...s.output } }));
  const find = (id: string): Step => steps.find((s) => s.id === id)!;
  const deps: Parameters<typeof runCatalogTask>[0] = {
    steps: {
      ensureSteps: async (_taskId, plan) => {
        if (steps.length === 0) {
          plan.forEach((p, position) =>
            steps.push({ ...p, id: `step-${position}`, position, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 }),
          );
        }
        return steps.map((s) => ({ ...s, output: { ...s.output } }));
      },
      markSubmitted: async (id, predictionId) => {
        Object.assign(find(id), { status: "submitted", predictionId });
      },
      markDone: async (id, output) => {
        Object.assign(find(id), { status: "done", output: { ...find(id).output, ...output } });
      },
      markFailed: async (id, reason) => {
        Object.assign(find(id), { status: "failed", output: { ...find(id).output, error: reason } });
      },
      recordInline: async (id, output, cost) => {
        const step = find(id);
        Object.assign(step, { output: { ...step.output, ...output }, inlineCostUsd: step.inlineCostUsd + cost });
      },
    },
    clones: {
      findClone: async () => null,
      recordClone: async () => true,
      retireClone: async () => undefined,
    },
    sourceKeyOf: async () => null,
    describeImage: async (url: string) => ({ text: `a picture at ${url}`, costUsd: 0 }),
  };
  return { steps, deps };
}

/**
 * The run's context.
 * @param lastAttempt - Whether no retry follows this pickup.
 * @param deadlineAt - The task's deadline.
 * @returns The context.
 */
function ctx(lastAttempt: boolean, deadlineAt = Number.MAX_SAFE_INTEGER): Parameters<typeof runCatalogTask>[1] {
  return { taskId: TASK, studioId: null, deadlineAt, retryStarting: false, lastAttempt };
}

/**
 * A step a previous pickup left behind.
 * @param position - Its place in the run.
 * @param over - What differs from a pending generate step.
 * @returns The step.
 */
function stored(position: number, over: Partial<Step>): Step {
  return {
    id: `step-${position}`,
    taskId: TASK,
    position,
    kind: "generate",
    endpoint: GENERATE,
    itemIndex: null,
    status: "pending",
    predictionId: null,
    output: {},
    inlineCostUsd: 0,
    ...over,
  } as Step;
}

/** The generate step a previous pickup finished. */
const GENERATED = stored(0, { status: "done", predictionId: "pred-gen", output: { urls: [GEN_URL], prediction: "pred-gen" } });

/**
 * The calls made to one endpoint.
 * @param endpoint - The model path.
 * @returns Each call's body and options.
 */
function callsTo(endpoint: string): { body: Record<string, unknown>; opts: PredictionOptions }[] {
  return runPredictionMock.mock.calls
    .filter((call) => call[1] === endpoint)
    .map((call) => ({ body: call[2] as Record<string, unknown>, opts: call[3] as PredictionOptions }));
}

/**
 * The prediction ids billed so far.
 * @returns Them, in order.
 */
function billed(): string[] {
  return queryBillingMock.mock.calls.map((call) => call[1] as string);
}

/** What the rig endpoint does with one call. */
type RigOutcome =
  | { kind: "success" }
  | { kind: "upstreamFailed" }
  | { kind: "rejected"; status: number }
  | { kind: "noOutput"; outputs: unknown[] }
  | { kind: "unparseable" }
  | { kind: "network" }
  | { kind: "server"; status: number }
  | { kind: "stillRunning" }
  | { kind: "deadlinePassed" };

/**
 * Answer one rig call the way the outcome says. Failures that come back from
 * a prediction the upstream accepted (failed, still going, no output) leave
 * its id stored first, as the real submit does.
 * @param outcome - What happens.
 * @param opts - The options the call was handed.
 * @returns The prediction, on success or an answer without output.
 * @throws {Error} The outcome's error.
 */
async function rigAnswer(outcome: RigOutcome, opts: PredictionOptions): Promise<{ outputs: unknown[]; taskId: string }> {
  switch (outcome.kind) {
    case "success":
      return { outputs: [RIG_URL], taskId: opts.storedTaskId ?? "pred-rig" };
    case "upstreamFailed":
      await opts.persistTaskId("pred-rig");
      throw new UpstreamTaskFailed("wavespeed", "the model has no recognisable body");
    case "rejected":
      throw new HttpStatusError("wavespeed", outcome.status, "{\"message\":\"invalid model url\"}");
    case "noOutput":
      await opts.persistTaskId("pred-rig");
      return { outputs: outcome.outputs, taskId: "pred-rig" };
    case "unparseable":
      throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
    case "network":
      throw new TypeError("fetch failed");
    case "server":
      throw new HttpStatusError("wavespeed", outcome.status, "upstream unavailable");
    case "stillRunning":
      await opts.persistTaskId("pred-rig");
      throw new StillRunning(Date.now() + 5_000);
    case "deadlinePassed":
      throw new DeadlinePassed();
  }
}

/**
 * Make the generate endpoint answer the model and the rig endpoint answer as
 * the outcome says; the error a failing rig call throws is kept.
 * @param outcome - What the rig call does.
 * @returns A reference to the error the rig call threw, if any.
 */
function upstream(outcome: RigOutcome): { thrown: unknown } {
  const seen: { thrown: unknown } = { thrown: undefined };
  runPredictionMock.mockImplementation(async (_resolved: unknown, endpoint: string, _body: unknown, opts: PredictionOptions) => {
    if (endpoint !== RIG) return { outputs: [GEN_URL], taskId: "pred-gen" };
    try {
      return await rigAnswer(outcome, opts);
    } catch (err) {
      seen.thrown = err;
      throw err;
    }
  });
  return seen;
}

/** How one pickup ends for one rig outcome. */
type Verdict = "rigged" | "rigFailed" | "rethrown";

/**
 * What the design says one pickup does with a rig outcome.
 * @param outcome - What the rig call did.
 * @param lastAttempt - Whether no retry follows.
 * @returns The verdict.
 */
function verdictOf(outcome: RigOutcome, lastAttempt: boolean): Verdict {
  switch (outcome.kind) {
    case "success":
      return "rigged";
    case "upstreamFailed":
    case "rejected":
    case "noOutput":
    case "unparseable":
      return "rigFailed";
    case "network":
    case "server":
      return lastAttempt ? "rigFailed" : "rethrown";
    case "stillRunning":
    case "deadlinePassed":
      return "rethrown";
  }
}

const rigOutcome: fc.Arbitrary<RigOutcome> = fc.oneof(
  fc.constant<RigOutcome>({ kind: "success" }),
  fc.constant<RigOutcome>({ kind: "upstreamFailed" }),
  // 408 and 429 are left out: they say "ask again", not "this request is wrong".
  fc.integer({ min: 400, max: 499 }).filter((status) => status !== 408 && status !== 429).map((status): RigOutcome => ({ kind: "rejected", status })),
  fc.constantFrom<unknown[]>([], [""], [{}], [42]).map((outputs): RigOutcome => ({ kind: "noOutput", outputs })),
  fc.constant<RigOutcome>({ kind: "unparseable" }),
  fc.constant<RigOutcome>({ kind: "network" }),
  fc.integer({ min: 500, max: 599 }).map((status): RigOutcome => ({ kind: "server", status })),
  fc.constant<RigOutcome>({ kind: "stillRunning" }),
  fc.constant<RigOutcome>({ kind: "deadlinePassed" }),
);

const RIG_BODY = { model: GEN_URL, rig_type: "auto", spec: "vrm", out_format: "glb" };

beforeEach(() => {
  runPredictionMock.mockReset();
  queryBillingMock.mockReset();
  queryBillingMock.mockResolvedValue(PRICE_PER_PREDICTION);
});

describe("rigging a generated model (inner#1692)", () => {
  it("plans the rig after the generation, posts the generated model to it and delivers the rigged one", async () => {
    const { deps, steps } = stores();
    upstream({ kind: "success" });

    const result = await runCatalogTask(deps, ctx(false), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1);

    expect(steps.map((s) => `${s.kind}@${s.endpoint}`)).toEqual([`generate@${GENERATE}`, `rig@${RIG}`]);
    expect(callsTo(GENERATE)).toHaveLength(1);
    expect(callsTo(GENERATE)[0]!.body).not.toHaveProperty("rig_skeleton");
    expect(callsTo(RIG).map((call) => call.body)).toEqual([RIG_BODY]);
    expect(result.outputs).toEqual([{ url: RIG_URL }]);
    expect(result.notice).toBeUndefined();
    expect(billed()).toEqual(["pred-gen", "pred-rig"]);
    expect(result.cost).toBeCloseTo(2 * PRICE_PER_PREDICTION, 10);
  });

  it("takes no rig step when the switch is off, and keeps the switch off the generation's body", async () => {
    const { deps, steps } = stores();
    upstream({ kind: "success" });

    const result = await runCatalogTask(deps, ctx(false), "three_d", PROMPT, MODEL, { rig_skeleton: false }, 1);

    expect(steps.map((s) => s.kind)).toEqual(["generate"]);
    expect(callsTo(RIG)).toEqual([]);
    expect(callsTo(GENERATE)[0]!.body).not.toHaveProperty("rig_skeleton");
    expect(result.outputs).toEqual([{ url: GEN_URL }]);
    expect(result.notice).toBeUndefined();
  });

  it("posts the model a previous pickup generated to the rig, without generating again", async () => {
    const earlier = "https://cdn/tripo/earlier.glb";
    const { deps } = stores([
      stored(0, { status: "done", predictionId: "pred-gen", output: { urls: [earlier], prediction: "pred-gen" } }),
      stored(1, { kind: "rig", endpoint: RIG }),
    ]);
    upstream({ kind: "success" });

    const result = await runCatalogTask(deps, ctx(false), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1);

    expect(callsTo(GENERATE)).toEqual([]);
    expect(callsTo(RIG).map((call) => call.body)).toEqual([{ ...RIG_BODY, model: earlier }]);
    expect(result.outputs).toEqual([{ url: RIG_URL }]);
  });

  it("fails the whole run when the generation itself fails, and never rigs", async () => {
    const { deps, steps } = stores();
    runPredictionMock.mockRejectedValueOnce(new UpstreamTaskFailed("wavespeed", "prompt refused"));

    await expect(
      runCatalogTask(deps, ctx(true), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1),
    ).rejects.toBeInstanceOf(UpstreamTaskFailed);
    expect(steps.map((s) => s.status)).toEqual(["failed", "pending"]);
    expect(callsTo(RIG)).toEqual([]);
    expect(queryBillingMock).not.toHaveBeenCalled();
  });

  it("still throws on redelivery when the step that failed is the generation, not the optional rig", async () => {
    const { deps } = stores([
      stored(0, { status: "failed", predictionId: "pred-gen", output: { error: "prompt refused" } }),
      stored(1, { kind: "rig", endpoint: RIG }),
    ]);

    await expect(
      runCatalogTask(deps, ctx(false), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1),
    ).rejects.toThrow("prompt refused");
    expect(runPredictionMock).not.toHaveBeenCalled();
  });

  it("fails the run as expired when the deadline comes before the rig is submitted", async () => {
    const { deps, steps } = stores([GENERATED, stored(1, { kind: "rig", endpoint: RIG })]);
    upstream({ kind: "success" });

    await expect(
      runCatalogTask(deps, ctx(true, Date.now() - 1), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1),
    ).rejects.toBeInstanceOf(DeadlinePassed);
    expect(runPredictionMock).not.toHaveBeenCalled();
    expect(steps[1]!.status).not.toBe("failed");
  });

  it("keeps the reason on a rig step that failed for good", async () => {
    const { deps, steps } = stores();
    upstream({ kind: "upstreamFailed" });

    const result = await runCatalogTask(deps, ctx(false), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1);

    expect(steps[1]).toMatchObject({ kind: "rig", status: "failed", output: { error: "the model has no recognisable body" } });
    expect(result.notice).toBe("rig_failed");
    expect(result.outputs).toEqual([{ url: GEN_URL }]);
  });
});

describe("rig outcomes across attempts and redeliveries (inner#1692 property)", () => {
  it("delivers, bills, records and propagates as the design says for every outcome", async () => {
    await fc.assert(
      fc.asyncProperty(rigOutcome, fc.boolean(), fc.boolean(), fc.boolean(), async (outcome, lastAttempt, rerun, rerunLast) => {
        runPredictionMock.mockReset();
        queryBillingMock.mockReset();
        queryBillingMock.mockResolvedValue(PRICE_PER_PREDICTION);
        const { deps, steps } = stores();
        const seen = upstream(outcome);
        const verdict = verdictOf(outcome, lastAttempt);

        // ── First pickup ──
        const run = runCatalogTask(deps, ctx(lastAttempt), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1);
        if (verdict === "rethrown") {
          const err = await run.then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(err).toBeDefined();
          expect(err).toBe(seen.thrown);
          expect(steps[0]!.status).toBe("done");
          expect(steps[1]!.status).not.toBe("failed");
          expect(queryBillingMock).not.toHaveBeenCalled();
        } else {
          const result = await run;
          if (verdict === "rigged") {
            expect(result.outputs).toEqual([{ url: RIG_URL }]);
            expect(result.notice).toBeUndefined();
            expect(billed()).toEqual(["pred-gen", "pred-rig"]);
            expect(steps.map((s) => s.status)).toEqual(["done", "done"]);
          } else {
            expect(result.outputs).toEqual([{ url: GEN_URL }]);
            expect(result.notice).toBe("rig_failed");
            expect(billed()).toEqual(["pred-gen"]);
            expect(steps.map((s) => s.status)).toEqual(["done", "failed"]);
            expect(typeof steps[1]!.output.error).toBe("string");
            expect(steps[1]!.output.error).not.toBe("");
          }
          expect(result.cost).toBeCloseTo(billed().length * PRICE_PER_PREDICTION, 10);
        }
        expect(callsTo(GENERATE)).toHaveLength(1);
        expect(callsTo(GENERATE)[0]!.body).not.toHaveProperty("rig_skeleton");
        expect(callsTo(RIG).map((call) => call.body)).toEqual([RIG_BODY]);

        if (!rerun) return;

        // ── The task is delivered again; the rig, if asked, now succeeds ──
        const rigPredictionBefore = steps[1]!.predictionId;
        runPredictionMock.mockReset();
        queryBillingMock.mockReset();
        queryBillingMock.mockResolvedValue(PRICE_PER_PREDICTION);
        upstream({ kind: "success" });

        const again = await runCatalogTask(deps, ctx(rerunLast), "three_d", PROMPT, MODEL, { rig_skeleton: true }, 1);

        expect(callsTo(GENERATE)).toEqual([]);
        if (verdict === "rigFailed") {
          // The optional step already failed: skipped, the generated model delivered.
          expect(runPredictionMock).not.toHaveBeenCalled();
          expect(again.outputs).toEqual([{ url: GEN_URL }]);
          expect(again.notice).toBe("rig_failed");
          expect(billed()).toEqual(["pred-gen"]);
          expect(steps.map((s) => s.status)).toEqual(["done", "failed"]);
        } else if (verdict === "rigged") {
          expect(runPredictionMock).not.toHaveBeenCalled();
          expect(again.outputs).toEqual([{ url: RIG_URL }]);
          expect(again.notice).toBeUndefined();
          expect(billed()).toEqual(["pred-gen", "pred-rig"]);
        } else {
          // The rig was left going or retryable: asked again, by its stored id when it has one.
          const rigCalls = callsTo(RIG);
          expect(rigCalls).toHaveLength(1);
          expect(rigCalls[0]!.opts.storedTaskId).toBe(rigPredictionBefore);
          const rigPrediction = rigPredictionBefore ?? "pred-rig";
          expect(again.outputs).toEqual([{ url: RIG_URL }]);
          expect(again.notice).toBeUndefined();
          expect(billed()).toEqual(["pred-gen", rigPrediction]);
          expect(steps.map((s) => s.status)).toEqual(["done", "done"]);
        }
        expect(again.cost).toBeCloseTo(billed().length * PRICE_PER_PREDICTION, 10);
      }),
      { numRuns: 200 },
    );
  });
});
