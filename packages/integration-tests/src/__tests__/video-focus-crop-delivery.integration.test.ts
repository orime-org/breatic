// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Video focus crop delivery (frames-split design §5.5 "交付", §7.18; test plan §68.2 FI01–FI07, FI10, FI13).
 *
 * A registered crop stays in the existing delivery ledger, but delivery branches by tool: it settles the panel node's task
 * row through `settleTaskForNode`, writes no node history, and its counts event carries `focusImageAppend` (only when the
 * settle landed) instead of `result`. collab appends the image to the panel node's `focusImages` and records the taskId in
 * `focusCropOutcomes` (`added`, or `refused` when 200 images are held), skipping any taskId it already marked.
 *
 * SQL, node tasks, the tasks queue and the task-events stream are real; the canvas document is a real Y.Doc fed the actual
 * stream payloads through collab's `applyNodeTaskCounts`. The execution is seeded through the existing real fixture and its
 * frozen plan rewritten to the focus-crop shape design §5.5 fixes ("请求照现有计划请求的形状带draft", "计划形状").
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, createQueue, getNodeTaskConfig, getStreamRedis, initCore, initLogger, loadLocales, taskEventsStreamKey } from "@breatic/core";
import { miniToolExecutionService } from "@breatic/domain";
import { CANVAS_NODES_KEY } from "@breatic/shared";
import { hashMiniToolValue } from "@breatic/shared/mini-tools";
import type { Queue } from "bullmq";
import { runTask } from "@worker/handlers/dispatch.js";
import { failedResult } from "@worker/handlers/mini-tool/run-video-tool.js";
import { finishMiniToolExecutionAndNotify } from "@worker/handlers/mini-tool/execution-completion.js";
import * as wavespeed from "@worker/providers/wavespeed.js";
import * as upload from "@worker/handlers/backend-upload.js";
import { applyNodeTaskCounts } from "@collab/services/node-task-counts.js";
import { seedExecution, type ExecutionFixture } from "../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";

const CROP = { x: 480, y: 270, width: 960, height: 540 };
const SOURCE_NAME = "Clip 7";
const MAX_FOCUS_ENTRIES = 200;
type NodeStatus = "running" | "failed" | "expired";
type Payload = Record<string, unknown>;
interface Crop extends ExecutionFixture {
  panelNodeId: string;
  planFingerprint: string;
  image: { assetId: string; canonicalURL: string; width: number; height: number };
}

let pg: ReturnType<typeof createPgClient>;
let queue: Queue<Record<string, unknown>>;
const docs: Y.Doc[] = [];

beforeAll(() => {
  initCore({ ...process.env, ENV: "staging", PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", UPLOAD_BASE_URL: "https://assets.example.test" });
  loadLocales(); initLogger("video-focus-crop-delivery");
  pg = createPgClient(inject("DATABASE_URL"), { name: "video-focus-crop-delivery", max: 4 });
  queue = createQueue("tasks");
});
beforeEach(() => {
  vi.spyOn(wavespeed, "runPrediction").mockRejectedValue(new Error("Focus-crop delivery must not call a provider"));
  vi.spyOn(upload, "storeFromUrl").mockRejectedValue(new Error("Focus-crop delivery must not transfer media"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const doc of docs.splice(0)) doc.destroy();
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/**
 * Seed a finished focus crop with one registered PNG whose delivery is pending, and the panel node's task row.
 * @param nodeStatus - The panel node's row status at delivery time.
 * @param outcome - Whether the run's only output registered or failed; a failed run is not finished here.
 * @returns The fixture.
 * @throws {Error} On fixture SQL failure.
 */
async function seedCrop(nodeStatus: NodeStatus = "running", outcome: "registered" | "unfinished" = "registered"): Promise<Crop> {
  const f = await seedExecution(pg, "running");
  const panelNodeId = f.plan.outputs[0]!.nodeId;
  if (outcome === "registered") {
    // The real finish writes the manifest and record shapes; the plan is rewritten to the crop right after.
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, { planFingerprint: f.plan.planFingerprint, expectedVersion: 0,
      outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }], error: null });
  }
  const assetId = randomUUID(); const canonicalURL = `https://assets.example.test/image/focus/${assetId}.png`;
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,generation_task_id,width,height)
    VALUES (${assetId},${f.studioId},${"c".repeat(64)},${`image/focus/${assetId}.png`},${canonicalURL},20480,'image/png','image','ai',${f.userId},${f.taskId},960,540)`;
  const plan = structuredClone(f.plan) as unknown as Record<string, unknown> & { draft: { params: unknown }; outputs: unknown[]; requestFingerprint: string; planFingerprint: string };
  plan.tool = "video.focus-crop";
  // A container tool names itself as its model, as extract-frames does; the removal's provider fields do not apply.
  plan.model = "video.focus-crop";
  for (const key of ["provider", "body", "modelCredits", "preparation"]) delete plan[key];
  plan.draft.params = { frameIndex: 42, crop: CROP, sourceName: SOURCE_NAME };
  plan.outputs = [{ outputIndex: 0, nodeId: panelNodeId, recipe: { kind: "frame", frameIndex: 42, crop: CROP } }];
  plan.credits = 0; plan.chargeTo = "platform";
  const { requestFingerprint: _request, planFingerprint: _plan, ...projection } = plan;
  plan.planFingerprint = await hashMiniToolValue(projection);
  await pg`UPDATE tasks SET task_type='image', model='video.focus-crop', params=${pg.json({ miniToolExecution: plan } as never)} WHERE id=${f.taskId}`;
  if (outcome === "registered") {
    const [row] = await pg<{ record: Record<string, unknown> & { outputs: Array<Record<string, unknown>> } }[]>`SELECT result->'miniToolExecution' AS record FROM tasks WHERE id=${f.taskId}`;
    const record = row!.record;
    record.planFingerprint = plan.planFingerprint;
    record.outputs = [{ ...record.outputs[0], ...plan.outputs[0] as object, result: { status: "registered", assetId, canonicalURL, kind: "image", contentHash: "c".repeat(64),
      mimeType: "image/png", size: 20480, width: 960, height: 540, duration: null, cover: null }, late: false }];
    const delivery = { schemaVersion: 1, planFingerprint: plan.planFingerprint, version: 1, outputs: [{ outputIndex: 0, state: "pending" }], lastErrorCode: null };
    await pg`UPDATE tasks SET result=result || ${pg.json({ miniToolExecution: record, miniToolDelivery: delivery } as never)} WHERE id=${f.taskId}`;
  }
  const startedAt = new Date(Date.now() - (nodeStatus === "expired" ? getNodeTaskConfig().default_budget_ms + 1 : 0));
  if (nodeStatus === "expired") await pg`UPDATE tasks SET created_at=${startedAt} WHERE id=${f.taskId}`;
  await pg`INSERT INTO node_tasks (project_id,space_id,node_id,kind,action,status,started_by_user_id,budget_ms,label,task_id,started_at,settled_at)
    VALUES (${f.projectId},${f.plan.spaceId},${panelNodeId},'generation','mini_tool',${nodeStatus},${f.userId},${getNodeTaskConfig().default_budget_ms},'video.focus-crop',${f.taskId},${startedAt},${nodeStatus === "running" ? null : new Date()})`;
  return { ...f, panelNodeId, planFingerprint: plan.planFingerprint, image: { assetId, canonicalURL, width: 960, height: 540 } };
}

/**
 * Wake delivery for the crop's current delivery version.
 * @param f - The crop.
 * @param version - The delivery version.
 * @returns Nothing.
 * @throws {Error} When the worker throws.
 */
async function deliver(f: Crop, version = 1): Promise<void> {
  await runTask({ id: `delivery-${f.taskId}-${version}`, name: "deliver-mini-tool-results", data: { taskId: f.taskId, deliveryVersion: version } } as unknown as Parameters<typeof runTask>[0]);
}

/**
 * The actual stream entries published for the panel node, in stream order.
 * @param f - The crop.
 * @returns Their ids and payloads.
 * @throws {Error} When a stored payload is not an object.
 */
async function events(f: Crop): Promise<Array<{ id: string; payload: Payload }>> {
  return (await getStreamRedis().xrange(taskEventsStreamKey(), "-", "+")).flatMap(([id, fields]) => {
    const value: unknown = JSON.parse(fields[fields.indexOf("payload") + 1]!);
    if (value === null || typeof value !== "object") throw new Error("Stream payload is not an object");
    return (value as Payload).nodeId === f.panelNodeId ? [{ id, payload: value as Payload }] : [];
  });
}

/**
 * The SQL delivery sibling.
 * @param f - The crop.
 * @returns It.
 * @throws {Error} When the query fails.
 */
async function deliveryState(f: Crop): Promise<unknown> {
  const [row] = await pg`SELECT result->'miniToolDelivery' AS delivery FROM tasks WHERE id=${f.taskId}`;
  return row?.delivery;
}

/**
 * A canvas document holding the panel node with its own content and the given focus images.
 * @param f - The crop.
 * @param focusImages - What the panel already holds.
 * @returns The document and the panel's data map.
 */
function canvas(f: Crop, focusImages: unknown[] = []): { doc: Y.Doc; data: Y.Map<unknown> } {
  const doc = new Y.Doc(); docs.push(doc);
  const node = new Y.Map<unknown>(); doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).set(f.panelNodeId, node);
  node.set("type", "image");
  const data = new Y.Map<unknown>(); node.set("data", data);
  data.set("content", "https://assets.example.test/image/panel.png");
  data.set("focusImages", focusImages);
  data.set("taskCounts", { running: 1, done: 0, failed: 0, expired: 0 });
  return { doc, data };
}

/**
 * Feed payloads to collab's applier in order, holding the counts version as the listener does.
 * @param doc - The canvas document.
 * @param entries - Stream entries.
 * @param held - The counts version held before them.
 * @returns The counts version held after them.
 */
function apply(doc: Y.Doc, entries: Array<{ id: string; payload: Payload }>, held?: string): string | undefined {
  let version = held;
  for (const entry of entries) version = applyNodeTaskCounts(doc, entry.payload as Parameters<typeof applyNodeTaskCounts>[1], { version: entry.id, countsVersion: version });
  return version;
}

/**
 * The image the crop appends.
 * @param f - The crop.
 * @returns It.
 */
function appended(f: Crop): Record<string, unknown> {
  return { id: f.taskId, url: f.image.canonicalURL, name: SOURCE_NAME, width: f.image.width, height: f.image.height };
}

/**
 * Filler images that already fill the panel.
 * @param count - How many.
 * @returns Them.
 */
function filler(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, at) => ({ id: randomUUID(), url: `https://assets.example.test/image/fill-${at}.png`, name: "old", width: 10, height: 10 }));
}

/**
 * Node history rows of the crop.
 * @param f - The crop.
 * @returns Their ids.
 */
async function historyOf(f: Crop): Promise<unknown[]> {
  return [...await pg`SELECT id FROM node_history WHERE task_id=${f.taskId}`];
}

describe("video focus crop delivery appends to the panel node (design §5.5 交付, §7.18)", () => {
  it("FI01 the delivery event appends to focusImages and records added, with no node history and no content change", async () => {
    const f = await seedCrop();
    await deliver(f);
    expect(await deliveryState(f)).toMatchObject({ version: 2, outputs: [{ outputIndex: 0, state: "published" }] });
    const published = await events(f);
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).not.toHaveProperty("result");
    expect(published[0]!.payload).not.toHaveProperty("resultOrigin");
    expect(published[0]!.payload).toMatchObject({ counts: { running: 0, done: 1, failed: 0, expired: 0 }, focusImageAppend: expect.objectContaining({ nodeId: f.panelNodeId }) });
    expect(await historyOf(f)).toEqual([]);
    const { doc, data } = canvas(f);
    apply(doc, published);
    expect(data.get("focusImages")).toEqual([appended(f)]);
    expect(data.get("focusCropOutcomes")).toEqual({ [f.taskId]: "added" });
    expect(data.get("content")).toBe("https://assets.example.test/image/panel.png");
  });

  it("FI02 a settle repeated after a lost acknowledgement and a stream redelivery append only once", async () => {
    const f = await seedCrop();
    await deliver(f);
    // The acknowledgement is lost: the ledger goes back to pending and delivery settles the row again.
    await pg`UPDATE tasks SET result=jsonb_set(result,'{miniToolDelivery}',${pg.json({ schemaVersion: 1, planFingerprint: f.planFingerprint, version: 3, outputs: [{ outputIndex: 0, state: "pending" }], lastErrorCode: null })}) WHERE id=${f.taskId}`;
    await deliver(f, 3);
    const published = await events(f);
    expect(published.some((entry) => "focusImageAppend" in entry.payload)).toBe(true);
    const { doc, data } = canvas(f);
    const held = apply(doc, published);
    // The stream redelivers the first entry under a newer id.
    const [ms] = published.at(-1)!.id.split("-");
    apply(doc, [{ id: `${Number(ms) + 1}-0`, payload: published[0]!.payload }], held);
    expect(data.get("focusImages")).toEqual([appended(f)]);
    expect(data.get("focusCropOutcomes")).toEqual({ [f.taskId]: "added" });
  });

  it("FI03 republishing only the counts adds nothing", async () => {
    const f = await seedCrop();
    await deliver(f);
    const published = await events(f);
    const { doc, data } = canvas(f);
    const held = apply(doc, published);
    expect(data.get("focusImages")).toEqual([appended(f)]);
    const [ms] = published.at(-1)!.id.split("-");
    apply(doc, [{ id: `${Number(ms) + 5}-0`, payload: { nodeId: f.panelNodeId, counts: { running: 0, done: 1, failed: 0, expired: 0 } } }], held);
    expect(data.get("focusImages")).toEqual([appended(f)]);
  });

  it("FI04 an image the user deleted inside the marker window is not added back by a replay", async () => {
    const f = await seedCrop();
    await deliver(f);
    const published = await events(f);
    const { doc, data } = canvas(f);
    const held = apply(doc, published);
    expect(data.get("focusImages")).toEqual([appended(f)]);
    doc.transact(() => { data.set("focusImages", []); });
    const [ms] = published.at(-1)!.id.split("-");
    apply(doc, [{ id: `${Number(ms) + 9}-0`, payload: published[0]!.payload }], held);
    expect(data.get("focusImages")).toEqual([]);
    expect(data.get("focusCropOutcomes")).toEqual({ [f.taskId]: "added" });
  });

  it("FI05 a panel already holding 200 images records refused and appends nothing", async () => {
    const f = await seedCrop();
    await deliver(f);
    const full = filler(MAX_FOCUS_ENTRIES);
    const { doc, data } = canvas(f, full);
    apply(doc, await events(f));
    expect(data.get("focusImages")).toEqual(full);
    expect(data.get("focusCropOutcomes")).toEqual({ [f.taskId]: "refused" });
  });

  it("FI06 a failed crop settles the panel node's row failed and appends nothing", async () => {
    const f = await seedCrop("running", "unfinished");
    await finishMiniToolExecutionAndNotify(f.taskId, { planFingerprint: f.planFingerprint, expectedVersion: 0,
      outputs: [{ outputIndex: 0, nodeId: f.panelNodeId, recipe: { kind: "frame", frameIndex: 42, crop: CROP }, result: failedResult("mini_tool_failed"), late: false } as never], error: null }, getStreamRedis());
    expect([...await pg`SELECT status FROM node_tasks WHERE task_id=${f.taskId}`]).toEqual([{ status: "failed" }]);
    const published = await events(f);
    expect(published.some((entry) => "focusImageAppend" in entry.payload)).toBe(false);
    const { doc, data } = canvas(f);
    apply(doc, published);
    expect(data.get("focusImages")).toEqual([]);
    expect(data.get("focusCropOutcomes")).toBeUndefined();
  });

  it("FI07 a row already judged expired gets no append from the late delivery, and no node history", async () => {
    const f = await seedCrop("expired");
    await deliver(f);
    const published = await events(f);
    expect(published.some((entry) => "focusImageAppend" in entry.payload)).toBe(false);
    expect(await historyOf(f)).toEqual([]);
    expect([...await pg`SELECT status FROM node_tasks WHERE task_id=${f.taskId}`]).toEqual([{ status: "expired" }]);
  });

  it("FI10 a failed publication stays pending in the delivery ledger and is delivered by the next wake", async () => {
    const f = await seedCrop(); const redis = getStreamRedis(); const key = taskEventsStreamKey();
    const originalType = await redis.type(key); const backup = `${key}:focus-crop-fixture:${randomUUID()}`;
    if (originalType !== "none") await redis.rename(key, backup);
    try { await redis.set(key, "fixture wrong type"); await deliver(f); }
    finally { await redis.del(key); if (originalType !== "none") await redis.rename(backup, key); }
    expect(await deliveryState(f)).toMatchObject({ version: 1, outputs: [{ outputIndex: 0, state: "pending" }], lastErrorCode: "delivery_publish_failed" });
    await runTask({ name: "discover-mini-tool-deliveries", data: {} } as unknown as Parameters<typeof runTask>[0]);
    expect((await queue.getWaiting()).some((job) => job.name === "deliver-mini-tool-results" && job.data.taskId === f.taskId)).toBe(true);
    await deliver(f);
    const published = await events(f);
    expect(published.filter((entry) => "focusImageAppend" in entry.payload)).toHaveLength(1);
    expect(await historyOf(f)).toEqual([]);
    const { doc, data } = canvas(f);
    apply(doc, published);
    expect(data.get("focusImages")).toEqual([appended(f)]);
  });

  it.each<[NodeStatus, boolean]>([["running", true], ["failed", false], ["expired", false]])(
    "FI13 delivery to a %s row branches by tool and carries the append only when the settle landed (%s)", async (status, lands) => {
      const f = await seedCrop(status);
      await deliver(f);
      const published = await events(f);
      expect(published).toHaveLength(1);
      expect(published[0]!.payload).not.toHaveProperty("result");
      expect("focusImageAppend" in published[0]!.payload).toBe(lands);
      expect(await historyOf(f)).toEqual([]);
    });
});
