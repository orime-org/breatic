// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Pin release at a run's end (inner#1306; frames-split design §7.19, §7.15).
 *
 * Every terminal of a run releases its `execution` and `prepared` pins in that commit; each key that lost its last live
 * reference is registered as a `derived` reclaim row. A run is rerun only as a whole, so no failed output keeps a pin for
 * a retry. The pins are seeded with SQL so these cases do not depend on the admission's own pin writes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore, loadLocales } from "@breatic/core";
import {
  miniToolExecutionService, runningSlotService, type MiniToolExecutionCompletion,
} from "@domain/index.js";
import { seedExecution, type ExecutionFixture } from "./execution-lifecycle-fixtures.js";

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
    outputs: [{ ...f.plan.outputs[0]!, result: failed ? { status: "failed", error: ERROR } : f.registered }] };
}

/**
 * Seed the run's execution pin and an analysis pin on the same L, under a per-run source key.
 * @param f - The fixture.
 * @param withAnalysis - Whether an analysis also pins L.
 * @returns The keys.
 */
async function pinned(f: ExecutionFixture, withAnalysis = false): Promise<{ source: string; full: string; table: string; prepared: string }> {
  const t = f.plan.presentationRef.source.toolInputId;
  const source = `video/pin-release/${f.taskId}.mp4`;
  const keys = { source, full: `${source}.video-source-ledger.${t}.json`, table: `${source}.video-presentation-table.${t}.json`, prepared: `${source}.prepared.json` };
  const insert = async (kind: string, holder: string, objects: string[]): Promise<void> => {
    const [row] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id) VALUES (${kind},${holder},${t}) RETURNING id`;
    for (const key of objects) await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${row!.id},${key})`;
  };
  await insert("execution", f.taskId, [keys.full, keys.table]);
  const [prepared] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id,prepared_key) VALUES ('prepared',${f.taskId},${t},${`${source}.prepared.json`}) RETURNING id`;
  await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${prepared!.id},${`${source}.prepared.json`})`;
  if (withAnalysis) await insert("analysis", randomUUID(), [keys.full, keys.table]);
  return keys;
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

describe("terminal release (design §7.19)", () => {
  it("TR01 a terminal commit with no failed output releases the run's execution pin and registers its keys", async () => {
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

  it("TR03 a failed terminal commit releases the run's execution and prepared pins and registers their keys", async () => {
    const f = await seedExecution(pg, "running"); const keys = await pinned(f);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, true))).record.status).toBe("failed");
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.prepared, keys.table].sort());
  });

  it("TR05 an admission failure releases the run's execution and prepared pins", async () => {
    const f = await seedExecution(pg, "running"); await pinned(f);
    await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, ERROR);
    expect(await livePins(f)).toEqual([]);
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

/**
 * The run's stored execution record, as the task row holds it.
 * @param f - The fixture.
 * @returns Its outputs' results.
 */
async function storedResults(f: ExecutionFixture): Promise<unknown[]> {
  const [row] = await pg<{ result: { miniToolExecution: { outputs: { result: unknown }[] } } }[]>`SELECT result FROM tasks WHERE id=${f.taskId}`;
  return row!.result.miniToolExecution.outputs.map((output) => output.result);
}

/**
 * Seed a scene detection waiting for a running slot, pinning the run's source keys, beside the fixture's run.
 * @param f - The fixture whose person and Project it runs under.
 * @param keys - The keys it pins.
 * @returns Its task id.
 */
async function waitingAnalysis(f: ExecutionFixture, keys: string[]): Promise<string> {
  const id = randomUUID();
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${id},${f.userId},${f.projectId},${f.plan.spaceId},'mini_tool_analysis','append','mini_tool','pending','video.split',${pg.json({})},${pg.json({})})`;
  const [row] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id) VALUES ('analysis',${id},${f.plan.presentationRef.source.toolInputId}) RETURNING id`;
  for (const key of keys) await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${row!.id},${key})`;
  return id;
}

// inner#1968 design 3.9: a waiting run ends outside the worker when the person cancels it or the stale-waiter sweep finds
// its job lost; that end is the run's terminal state (frames-split §7.19), so its own lane ends there too.
describe("a waiting run ended outside the worker (frames-split §7.19, inner#1968 design 3.9)", () => {
  it("TR08 a cancelled waiting run releases its execution pin, registers its keys and ends every output failed as cancelled", async () => {
    const f = await seedExecution(pg, "pending"); const keys = await pinned(f);
    expect((await runningSlotService.cancelQueued(f.taskId)).cancelled).toBe(true);
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.prepared, keys.table].sort());
    expect(await storedResults(f)).toEqual([{ status: "failed", error: { code: "cancelled" } }]);
  });

  it("TR09 a waiting run the sweep fails releases its pins and ends every output failed", async () => {
    const f = await seedExecution(pg, "pending"); const keys = await pinned(f);
    expect((await runningSlotService.failTask(f.taskId, "internal")).failed).toBe(true);
    expect(await livePins(f)).toEqual([]);
    expect(await queued(keys.source)).toEqual([keys.full, keys.prepared, keys.table].sort());
    expect(await storedResults(f)).toEqual([{ status: "failed", error: { code: "internal" } }]);
  });

  it("TR10 a cancelled waiting scene detection releases its analysis pin and registers the keys nothing else pins", async () => {
    const f = await seedExecution(pg, "completed"); const keys = { source: `video/pin-release/${f.taskId}.mp4` };
    const own = [`${keys.source}.video-source-ledger.a.json`];
    const id = await waitingAnalysis(f, own);
    expect((await runningSlotService.cancelQueued(id)).cancelled).toBe(true);
    expect((await pg`SELECT 1 FROM presentation_pins WHERE holder_id=${id} AND deleted_at IS NULL`).length).toBe(0);
    expect(await queued(keys.source)).toEqual(own);
  });

  it("TR11 the sweep failing a waiting scene detection releases its analysis pin", async () => {
    const f = await seedExecution(pg, "completed");
    const id = await waitingAnalysis(f, [`video/pin-release/${f.taskId}.mp4.video-source-ledger.b.json`]);
    expect((await runningSlotService.failTask(id, "internal")).failed).toBe(true);
    expect((await pg`SELECT 1 FROM presentation_pins WHERE holder_id=${id} AND deleted_at IS NULL`).length).toBe(0);
  });
});
