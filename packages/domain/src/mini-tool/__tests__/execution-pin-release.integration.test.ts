// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End of retryability at the terminal commit (S6e E4-5, inner#1306 test plan §90; frames-split design §7.15 可重试结束).
 *
 * An execution whose terminal commit has no failed output releases its `execution` and `prepared` pins in that
 * commit; each key that lost its last live reference is registered as a `derived` reclaim row. A terminal commit with
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
 * Seed the run's execution and prepared pins and an analysis pin on the same L, under a per-run source key.
 * @param f - The fixture.
 * @param withAnalysis - Whether an analysis also pins L.
 * @returns The keys.
 */
async function pinned(f: ExecutionFixture, withAnalysis = false): Promise<{ source: string; full: string; table: string; prepared: string }> {
  const t = f.plan.presentationRef.source.toolInputId;
  const source = `video/pin-release/${f.taskId}.mp4`;
  const keys = { source, full: `${source}.video-source-ledger.${t}.json`, table: `${source}.video-presentation-table.${t}.json`, prepared: `${source}.${f.taskId}:prep:0:a1` };
  const insert = async (kind: string, holder: string, preparedKey: string | null, objects: string[]): Promise<void> => {
    const [row] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id,prepared_key) VALUES (${kind},${holder},${t},${preparedKey}) RETURNING id`;
    for (const key of objects) await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${row!.id},${key})`;
  };
  await insert("execution", f.taskId, null, [keys.full, keys.table]);
  await insert("prepared", f.taskId, keys.prepared, [keys.prepared]);
  if (withAnalysis) await insert("analysis", randomUUID(), null, [keys.full, keys.table]);
  return keys;
}

/**
 * Persist the provider-returned model step and its result, so a late registration is accepted.
 * @param f - The fixture.
 * @throws {Error} When a real step, end or result write fails.
 */
async function returned(f: ExecutionFixture): Promise<void> {
  const { stepId, identity } = await executionIdentity(f);
  await recordMiniToolStepResult({ taskId: f.taskId, stepId, identity, outcome: "done", result: ["https://provider.example.test/late.webm"] },
    { kind: "generate", parse: () => ({ providerURL: "https://provider.example.test/late.webm" }) });
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
  it("TR01 a terminal commit with no failed output releases the run's execution and prepared pins and registers their keys", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false))).record.status).toBe("completed");
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.prepared, keys.table].sort());
  });

  it("TR02 keys still pinned by an analysis are not registered when the run releases them", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f, true);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false));
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.prepared]);
  });

  it("TR03 a terminal commit with a failed output keeps the pins and registers nothing", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, true))).record.status).toBe("failed");
    expect(await livePins(f)).toEqual(["execution", "prepared"]);
    expect(await queued(keys.source)).toEqual([]);
  });

  // inner#1306 test plan §97 (frames-split §7.15 可重试结束; execution design §9.4): a failed output whose failure reason is
  // not retryable (a lip-sync reason with `no_face` or `model_rejected`, judged by shared `lipsyncFailureRetryable`) ends
  // retryability at the terminal commit, so the pins are released there; a retryable reason keeps them for a takeover.
  // The reason is the failed output's `error` (§9.4: CommitFail writes the one reason).
  it.each([
    ["no_face", { kind: "lipsync", persons: [{ personId: "person-1", detectionNumber: 1, step: "faces", category: "no_face" }], shared: null }],
    ["model_rejected beside a stopped person", { kind: "lipsync", persons: [
      { personId: "person-1", detectionNumber: 1, step: "gen", category: "model_rejected" },
      { personId: "person-2", detectionNumber: 2, step: "track", category: "stopped" },
    ], shared: null }],
  ])("TR05 a terminal commit whose failed output's lip-sync reason is %s releases the pins and registers their keys", async (_name, reason) => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    const failed = { ...completion(f, true), error: reason, outputs: [{ ...f.plan.outputs[0]!, result: { status: "failed" as const, error: reason }, late: false }] };
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, failed)).record.status).toBe("failed");
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.prepared, keys.table].sort());
  });

  it("TR06 a terminal commit whose failed output's lip-sync reason is retryable keeps the pins", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    const reason = { kind: "lipsync", persons: [{ personId: "person-1", detectionNumber: 1, step: "gen", category: "timeout" }], shared: { step: "stitch", category: "failed" } };
    const failed = { ...completion(f, true), error: reason, outputs: [{ ...f.plan.outputs[0]!, result: { status: "failed" as const, error: reason }, late: false }] };
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, failed);
    expect(await livePins(f)).toEqual(["execution", "prepared"]);
    expect(await queued(keys.source)).toEqual([]);
  });

  // frames-split §7.15: a failed run whose only failed output is later registered late stays failed but has no failed
  // output left, so nothing can retry it and the late commit releases its pins.
  it("TR07 a late registration of a failed run's only failed output releases the pins and registers their keys", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f); await returned(f);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, true));
    expect(await livePins(f)).toEqual(["execution", "prepared"]);
    const late = (await miniToolExecutionService.finishMiniToolExecution(f.taskId, { ...completion(f, false), expectedVersion: 1 })).record;
    expect(late).toMatchObject({ status: "failed", outputs: [{ result: f.registered, late: true }] });
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.prepared, keys.table].sort());
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
