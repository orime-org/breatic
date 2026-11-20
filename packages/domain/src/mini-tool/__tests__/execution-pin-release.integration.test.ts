// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End of retryability at the terminal commit (S6e E4-5, inner#1306 test plan §90; frames-split design §7.15 可重试结束).
 *
 * An execution whose terminal commit has no failed output releases its `execution` pin in that commit; each key that lost its last live reference is registered as a `derived` reclaim row. A terminal commit with
 * a failed output keeps the pins: a later retry takes over (released in that retry's admission) or the node is removed
 * (offline reconciliation, registry row 18, no runtime case). The pins are seeded with SQL so these cases do not depend
 * on the admission's own pin writes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore, loadLocales } from "@breatic/core";
import {
  miniToolExecutionService, upstreamStepRepo, recordMiniToolStepResult,
  type MiniToolExecutionCompletion,
} from "@domain/index.js";
import { seedExecution, type ExecutionFixture } from "./execution-lifecycle-fixtures.js";
import { executionIdentity } from "./execution-step-fixtures.js";

let pg: ReturnType<typeof createPgClient>;
const ERROR = { code: "provider_failed" };
beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1" }); loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "execution-pin-release", max: 4 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/**
 * The run's terminal observation.
 * @param f - The fixture.
 * @param failed - Whether its one output failed.
 * @returns It.
 */
function completion(f: ExecutionFixture, failed: boolean): MiniToolExecutionCompletion {
  return { planFingerprint: f.plan.planFingerprint, expectedVersion: 0, error: failed ? ERROR : null,
    outputs: [{ ...f.plan.outputs[0]!, result: failed ? { status: "failed", error: ERROR } : f.registered, late: false }] };
}

/**
 * Seed the run's execution pin and an analysis pin on the same L, under a per-run source key.
 * @param f - The fixture.
 * @param withAnalysis - Whether an analysis also pins L.
 * @returns The keys.
 */
async function pinned(f: ExecutionFixture, withAnalysis = false): Promise<{ source: string; full: string; table: string }> {
  const t = f.plan.presentationRef.source.toolInputId;
  const source = `video/pin-release/${f.taskId}.mp4`;
  const keys = { source, full: `${source}.video-source-ledger.${t}.json`, table: `${source}.video-presentation-table.${t}.json` };
  const insert = async (kind: string, holder: string, objects: string[]): Promise<void> => {
    const [row] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id) VALUES (${kind},${holder},${t}) RETURNING id`;
    for (const key of objects) await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${row!.id},${key})`;
  };
  await insert("execution", f.taskId, [keys.full, keys.table]);
  if (withAnalysis) await insert("analysis", randomUUID(), [keys.full, keys.table]);
  return keys;
}

/**
 * Persist the container job's done result and its receipt, so a late registration is accepted.
 * @param f - The fixture.
 * @throws {Error} When a real step, end or result write fails.
 */
async function returned(f: ExecutionFixture): Promise<void> {
  const { stepId, identity } = await executionIdentity(f);
  await recordMiniToolStepResult({ taskId: f.taskId, stepId, identity, outcome: "done", result: { state: "done" } },
    { kind: "container_job", parse: () => ({ state: "done" }) });
  await upstreamStepRepo.recordInline(stepId, { "miniToolAsset:0": f.registered.assetId }, 0);
}

/**
 * Live pin kinds of the run.
 * @param f - The fixture.
 * @returns Sorted kinds.
 */
async function livePins(f: ExecutionFixture): Promise<string[]> {
  return (await pg<{ holder_kind: string }[]>`SELECT holder_kind FROM presentation_pins WHERE holder_id=${f.taskId} AND deleted_at IS NULL ORDER BY holder_kind`).map((row) => row.holder_kind);
}

/**
 * Derived rows under a source.
 * @param source - The source key.
 * @returns Sorted keys.
 */
async function queued(source: string): Promise<string[]> {
  return (await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE starts_with(storage_key, ${source}) AND kind='derived' ORDER BY storage_key`).map((row) => row.storage_key);
}

describe("terminal release (design §7.15 可重试结束)", () => {
  it("TR01 a terminal commit with no failed output releases the run's execution pin and registers its keys", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false))).record.status).toBe("completed");
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.table].sort());
  });

  it("TR02 keys still pinned by an analysis are not registered when the run releases them", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f, true);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false));
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([]);
  });

  it("TR03 a terminal commit with a failed output keeps the pins and registers nothing", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, true))).record.status).toBe("failed");
    expect(await livePins(f)).toEqual(["execution"]);
    expect(await queued(keys.source)).toEqual([]);
  });

  // frames-split §7.15: a failed run whose only failed output is later registered late stays failed but has no failed
  // output left, so nothing can retry it and the late commit releases its pins.
  it("TR07 a late registration of a failed run's only failed output releases the pins and registers their keys", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f); await returned(f);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, true));
    expect(await livePins(f)).toEqual(["execution"]);
    const late = (await miniToolExecutionService.finishMiniToolExecution(f.taskId, { ...completion(f, false), expectedVersion: 1 })).record;
    expect(late).toMatchObject({ status: "failed", outputs: [{ result: f.registered, late: true }] });
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.table].sort());
  });

  it("TR04 replaying the completed terminal commit releases and registers nothing more", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false));
    const once = await queued(keys.source);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false));
    expect(await queued(keys.source)).toEqual(once);
    expect(await livePins(f)).toEqual([]);
  });
});
