// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The settlement of a generation whose upstream billed it after it finished (inner#1743), as properties over every
 * way it can go: what was known when the run finished, what each lookup answers (a price, no price, never), a write
 * that fails once at any point (the queue then runs the job again), and the job dying at any pickup, after which the
 * failed-job net settles what it left. Whatever happens, the task is charged at most once, and the amount is what was
 * known and what the lookups found added up and rounded to the cent once; a run that ends on its own is charged, and
 * its history rows and feed row carry the charged amount.
 *
 * A job that dies after its charge leaves its rows to the billed-redelivery net, which `failed-job-cleanup.test.ts`
 * covers; here the net runs only on a task still unbilled.
 *
 * The task row is a fake that keeps state the way the repository's compare-and-set writes do. No real Redis / DB.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import type { StoredAsset } from "@breatic/domain";

/** A write the case makes fail once. */
type CrashPoint = "updateCostWait" | "extendHold" | "recordGenerationSuccess" | "updateGenerationCredits" | "upsertGenerationSucceeded";

const h = vi.hoisted(() => {
  const state = {
    row: { status: "running", billedAt: null as Date | null, billedCredits: null as number | null, result: null as Record<string, unknown> | null, durationMs: 4_000 },
    charges: [] as number[],
    historyCredits: [] as number[],
    feedCredits: [] as number[],
    crashes: new Set<string>(),
    now: 0,
    delayedTo: 0,
  };
  /**
   * Fail once at a write the case names.
   * @param point - The write.
   * @throws {Error} The first time the write is reached, when the case names it.
   */
  const maybeCrash = (point: string): void => {
    if (state.crashes.delete(point)) throw new Error(`${point} failed`);
  };
  return {
    state,
    maybeCrash,
    runModelTask: vi.fn(),
    lookup: vi.fn(),
    resolveRegisteredProjectMedia: vi.fn<(_projectId: string, url: string) => Promise<StoredAsset>>(),
  };
});

vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: async () => 1_800_000_000_000 }));
vi.mock("@worker/handlers/model-task.js", () => ({ runModelTask: h.runModelTask, abandonedCosts: async () => [] }));
vi.mock("@worker/services/project-media.service.js", () => ({ resolveRegisteredProjectMedia: h.resolveRegisteredProjectMedia }));
vi.mock("@breatic/core", () => ({
  runWithConsent: (_consent: unknown, fn: () => unknown) => fn(),
  reportCollaboratorFirstAction: vi.fn(async () => undefined),
  serverAnalyticsWanted: vi.fn(() => false),
  trackServerEvent: vi.fn(),
  projectsRepo: { findOwnerStudioId: vi.fn(async () => undefined) },
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({ lock_duration_ms: 30_000 })),
  getAgentConfig: vi.fn(() => ({})),
  getNodeTaskConfig: () => ({ cost_wait_delay_ms: 1_000, cost_wait_attempts: 3 }),
  projectActivitiesRepo: {
    insertGenerationFailedIfAbsent: vi.fn(async () => null),
    upsertGenerationSucceeded: vi.fn(async (row: { payload: { credits?: number } }) => {
      h.maybeCrash("upsertGenerationSucceeded");
      if (row.payload.credits !== undefined) h.state.feedCredits.push(row.payload.credits);
      return "activity-1";
    }),
  },
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(async () => ({ keyFromUrl: () => "image/out.png" })),
  getUnderstandConfig: vi.fn(() => ({})),
  env: { CREDIT_MULTIPLIER: 1 },
  NotFoundError: class extends Error {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", async () => ({
  failureOutcome: (await import("@domain/node-task/failure-outcome.js")).failureOutcome,
  taskService: {
    getByIdInternal: vi.fn(async () => ({ ...h.state.row, userId: "user-1", startedAt: new Date(h.state.now - 4_000), providerResultUrl: null })),
    markRunning: vi.fn(async () => new Date(h.state.now - 4_000)),
    markCompleted: vi.fn(async (_taskId: string, result: Record<string, unknown>) => {
      if (h.state.row.status === "completed") return false;
      h.state.row = { ...h.state.row, status: "completed", result };
      return true;
    }),
    markCompletedAndBill: vi.fn(async () => {
      throw new Error("a run with a pending cost is never billed on completion");
    }),
    markBilledAndCharge: vi.fn(async (_taskId: string, credits: number) => {
      if (h.state.row.billedAt !== null) return false;
      h.state.row = { ...h.state.row, billedAt: new Date(h.state.now), billedCredits: credits };
      h.state.charges.push(credits);
      return true;
    }),
    markFailed: vi.fn(async () => true),
    recordProviderResult: vi.fn(),
  },
  taskRepo: {
    updateCostWait: vi.fn(async (_taskId: string, result: Record<string, unknown>) => {
      h.maybeCrash("updateCostWait");
      if (h.state.row.billedAt === null) h.state.row = { ...h.state.row, result };
    }),
    clearSending: vi.fn(),
  },
  upstreamStepRepo: { failOpenSteps: vi.fn() },
  assetService: { resolveOwnerStudioId: vi.fn(async () => "studio-1") },
  creditLotService: { settleCharge: vi.fn(async () => ({ billed: true, charged: "0", shortfall: "0", studioId: "studio-1", lotIds: [] })), pendingChargeRequestId: vi.fn(async () => "req-1") },
  creditHoldService: {
    extendHold: vi.fn(async () => h.maybeCrash("extendHold")),
    releaseHold: vi.fn(async () => undefined),
  },
  creditsForUsd: (await import("@domain/credit/usage-cost.js")).creditsForUsd,
  toChargeCredits: (await import("@domain/credit/credit-math.js")).toChargeCredits,
  provider: () => ({ cost: { lookup: h.lookup } }),
  modelCatalog: { getModelCatalog: () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) },
  nodeHistoryService: {
    recordGenerationFailure: vi.fn(async () => ({ id: "history-f" })),
    recordGenerationSuccess: vi.fn(async (entry: { metadata?: { credits?: number } }) => {
      h.maybeCrash("recordGenerationSuccess");
      if (entry.metadata?.credits !== undefined) h.state.historyCredits.push(entry.metadata.credits);
      return { id: "history-1" };
    }),
    updateGenerationCredits: vi.fn(async (_taskId: string, credits: number) => {
      h.maybeCrash("updateGenerationCredits");
      h.state.historyCredits.push(credits);
    }),
  },
  settleTaskForNode: vi.fn(async () => undefined),
  sceneTaskService: {},
  createUsageRecorder: vi.fn(() => ({ recordLookedUpCall: vi.fn(), settle: async () => 0 })),
  UNDERSTAND_PINS: {},
}));

import { DelayedError, type Job } from "bullmq";

import { toChargeCredits } from "@domain/credit/credit-math.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { runTask, type TaskJobData } from "@worker/handlers/dispatch.js";
import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";

const NOW = 1_700_000_000_000;
const URL = "https://cdn/out.png";
const ATTEMPTS = 3;
const DATA: TaskJobData = {
  taskId: "task-1",
  taskType: "image",
  userId: "user-1",
  projectId: "proj-1",
  spaceId: "space-1",
  params: { prompt: "a cat" },
  model: "nano-banana-2",
  targetNodeIds: ["node-1"],
  mode: "append",
};

/**
 * The job at an attempt, as the queue hands it over.
 * @param attemptsMade - Attempts already spent.
 * @returns The job.
 */
function jobOf(attemptsMade: number): Job {
  return {
    id: "job-1",
    attemptsMade,
    stalledCounter: 0,
    opts: { attempts: ATTEMPTS },
    moveToDelayed: async (until: number) => {
      h.state.delayedTo = until;
    },
    updateData: vi.fn(),
    extendLock: async () => 1,
    data: DATA,
  } as unknown as Job;
}

/** What one lookup answers whenever it is asked. */
type Answer = { kind: "known"; usd: number } | { kind: "missing" } | { kind: "never" };

const usd = fc.integer({ min: 0, max: 3_000 }).map((micro) => micro / 1_000_000);
const answer: fc.Arbitrary<Answer> = fc.oneof(
  usd.map((value) => ({ kind: "known" as const, usd: value })),
  fc.constant({ kind: "missing" as const }),
  fc.constant({ kind: "never" as const }),
);
const CRASH_POINTS: readonly CrashPoint[] = ["updateCostWait", "extendHold", "recordGenerationSuccess", "updateGenerationCredits", "upsertGenerationSucceeded"];

/**
 * Every amount the task may be charged: what was known, and what some of the lookups found, rounded once.
 * @param known - The dollars known when the run finished.
 * @param found - The dollars each answered lookup found, in lookup order.
 * @returns The amounts, one per set of lookups answered.
 */
function chargeable(known: readonly number[], found: readonly number[]): number[] {
  const knownCredits = creditsForUsd(known.reduce((sum, value) => sum + value, 0), 1);
  const amounts: number[] = [];
  for (let mask = 0; mask < 2 ** found.length; mask += 1) {
    const lookedUp = found.reduce((sum, value, i) => ((mask >> i) & 1 ? sum + value : sum), 0);
    amounts.push(toChargeCredits(knownCredits + creditsForUsd(lookedUp, 1)));
  }
  return amounts;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => h.state.now);
  h.resolveRegisteredProjectMedia.mockImplementation(async (_projectId, fileUrl) => ({
    assetId: "asset-1", fileUrl, kind: "image", coverUrl: null, width: null, height: null, durationSeconds: null, mimeType: "image/png", sizeBytes: 10,
  }));
});

describe("settling a generation that waited on its cost", () => {
  it("charges at most once, rounded once, and writes the charged amount wherever it ends", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(usd, { maxLength: 3 }),
        fc.array(answer, { minLength: 1, maxLength: 3 }),
        fc.subarray([...CRASH_POINTS], { maxLength: 2 }),
        fc.option(fc.integer({ min: 0, max: 6 }), { nil: undefined }),
        async (known, answers, crashes, diesAt) => {
          h.state.row = { status: "running", billedAt: null, billedCredits: null, result: null, durationMs: 4_000 };
          h.state.charges = [];
          h.state.historyCredits = [];
          h.state.feedCredits = [];
          h.state.crashes = new Set(crashes);
          h.state.now = NOW;
          const lookups = answers.map((_, i) => ({ upstream: "fal", predictionId: `p-${i}` }));
          h.runModelTask.mockResolvedValue({
            outputs: [{ kind: "url", url: URL }],
            costs: [
              ...known.map((value) => ({ state: "known", usd: value, source: "reported" })),
              ...lookups.map((lookup) => ({ state: "pending", lookup })),
            ],
            servedBy: "fal",
            passedOverCosts: [],
          });
          h.lookup.mockImplementation(async (lookup: { predictionId: string }) => {
            const given = answers[Number(lookup.predictionId.slice(2))]!;
            if (given.kind === "known") return { state: "known", usd: given.usd, source: "billing" };
            if (given.kind === "missing") return { state: "missing", reason: "no billing" };
            return { state: "pending", lookup };
          });

          let attemptsMade = 0;
          let ended: "finished" | "died" = "died";
          for (let pickup = 0; pickup < 40; pickup += 1) {
            if (diesAt === pickup) break;
            try {
              await runTask(jobOf(attemptsMade), "lock-token");
              ended = "finished";
              break;
            } catch (err) {
              if (err instanceof DelayedError) {
                h.state.now = h.state.delayedTo;
                continue;
              }
              attemptsMade += 1;
              if (attemptsMade >= ATTEMPTS) break;
            }
          }
          if (ended === "died" && h.state.row.billedAt === null) {
            await cleanupFailedJobNodes({} as never, { data: DATA, finishedOn: h.state.now }, "stalled");
          }

          const found = answers.flatMap((given) => (given.kind === "known" ? [given.usd] : []));
          expect(h.state.charges.length).toBeLessThanOrEqual(1);
          if (h.state.charges.length === 1) expect(chargeable(known, found)).toContain(h.state.charges[0]);
          if (ended === "finished") {
            expect(h.state.charges).toEqual([chargeable(known, found).at(-1)]);
            expect(h.state.historyCredits.at(-1)).toBe(h.state.charges[0]);
            expect(h.state.feedCredits.at(-1)).toBe(h.state.charges[0]);
          }
          // A task that finished its run and waited is billed by the net when its job dies.
          if (ended === "died" && h.state.row.status === "completed") expect(h.state.charges).toHaveLength(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
