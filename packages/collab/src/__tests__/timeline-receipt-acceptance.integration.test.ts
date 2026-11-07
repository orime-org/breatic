// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Landing acceptance after a Timeline store (inner#1711 design §5.1; acceptance V1, V2).
 *
 * The browser writes `operationReceipts[actionId]` into the Timeline document once the server has accepted an
 * execution. After collab stores that document, `acceptTimelineReceipts(documentName, state)` reads the receipts from
 * the bytes it just stored and moves each matching `awaiting_landing` row of that Project and Space to `queued`: the
 * action, the input hash, a listed Space, the document's frame rate and the original deadline must all agree. Each
 * accepted row is enqueued once under its execution id and signals the Space's task list.
 *
 * Real business database, Yjs database and Redis; the BullMQ queue is the real `timeline` queue.
 */

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createPgClient, createQueue, env, getStreamRedis, initCore, timelineExecutionRepo, type Redis } from "@breatic/core";
import { projectMetaDocName, spaceContentDocName, type TimelineExecution } from "@breatic/shared";
import { attachTimelineRecord, initializeTimelineDocument } from "@breatic/shared/space-content";
import { acceptTimelineReceipts } from "@collab/services/timeline-receipt-acceptance.js";
import { storeDoc } from "@collab/services/persistence.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

let sql: ReturnType<typeof createPgClient>;
let queue: ReturnType<typeof createQueue>;
let subscriber: Redis;
const signals: { channel: string; message: Record<string, unknown> }[] = [];
const ownedDocs = new Set<string>();
const ownedJobs = new Set<string>();

beforeAll(async () => {
  initCore(process.env);
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-receipts-test-driver", max: 4, prepare: false });
  queue = createQueue("timeline");
  subscriber = getStreamRedis().duplicate();
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    signals.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
  });
  await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
});

beforeEach(() => {
  signals.length = 0;
});

afterEach(async () => {
  for (const id of ownedJobs) await (await queue.getJob(id))?.remove();
  ownedJobs.clear();
  for (const name of ownedDocs) await yjsRepo.softDeleteByName(name);
  ownedDocs.clear();
});

afterAll(async () => {
  await subscriber?.quit();
  await queue?.close();
  await sql?.end({ timeout: 1 });
});

const FPS = { num: 24, den: 1 };

interface Fixture {
  projectId: string;
  spaceId: string;
  userId: string;
  documentName: string;
  execution: TimelineExecution;
}

/**
 * A Project whose meta document lists one Timeline Space, and one accepted execution in it.
 * @param options - What a case varies.
 * @param options.listed - Whether the meta document lists the Space.
 * @param options.inputFps - The frame rate frozen in the accepted input.
 * @param options.spaceId - Reuse a Space id, as a Project copy does.
 * @returns The Project, Space, document name and execution.
 * @throws {Error} When a fixture write fails.
 */
async function seed(options: { listed?: boolean; inputFps?: { num: number; den: number }; spaceId?: string } = {}): Promise<Fixture> {
  const userId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified) VALUES (${userId}, ${`tl-receipt-${userId}@example.test`}, true)`;
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${userId}, ${studioId}, 'personal', 'Receipts')`;
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug) VALUES (${projectId}, ${studioId}, ${userId}, 'Receipts', ${`rc-${projectId}`})`;
  const spaceId = options.spaceId ?? randomUUID();
  await storeMeta(projectId, options.listed === false ? [] : [spaceId]);
  const execution = await insertExecution(projectId, spaceId, userId, options.inputFps ?? FPS);
  return { projectId, spaceId, userId, documentName: spaceContentDocName(projectId, spaceId, "timeline"), execution };
}

/**
 * Accept an execution in a Project and Space.
 * @param projectId - The Project.
 * @param spaceId - The Space.
 * @param userId - Who accepted it.
 * @param fps - The frame rate frozen in its input.
 * @returns The row.
 * @throws {Error} When the insert conflicts.
 */
async function insertExecution(projectId: string, spaceId: string, userId: string, fps: { num: number; den: number }): Promise<TimelineExecution> {
  const execution = await timelineExecutionRepo.insert({
    projectId,
    spaceId,
    actorUserId: userId,
    kind: "web_animation_create",
    engine: "deepseek",
    actionId: randomUUID(),
    input: { prompt: "A red square", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps },
    inputHash: `sha256:${randomUUID()}`,
    deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
  });
  if (execution === null) throw new Error("Fixture execution conflicted");
  ownedJobs.add(execution.id);
  return execution;
}

/**
 * A second execution in the fixture's Space whose receipt does land: the control that shows acceptance ran.
 * @param fx - The Project and Space.
 * @param fps - The frame rate frozen in its input.
 * @returns The row.
 */
async function control(fx: Fixture, fps = FPS): Promise<TimelineExecution> {
  return insertExecution(fx.projectId, fx.spaceId, fx.userId, fps);
}

/**
 * Store a Project's meta document listing the given Timeline Spaces.
 * @param projectId - The Project.
 * @param spaceIds - The Spaces it lists.
 */
async function storeMeta(projectId: string, spaceIds: string[]): Promise<void> {
  const meta = new Y.Doc();
  const spaces = meta.getMap("spaces");
  for (const id of spaceIds) {
    const entry = new Y.Map<unknown>();
    spaces.set(id, entry);
    entry.set("type", "timeline");
    entry.set("name", "Timeline");
    entry.set("order", 0);
  }
  const name = projectMetaDocName(projectId);
  ownedDocs.add(name);
  await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(meta));
  meta.destroy();
}

/**
 * Encode a Timeline document carrying receipts.
 * @param receipts - The receipts by action id.
 * @param fps - The document's frame rate.
 * @returns The encoded state.
 */
function timelineState(receipts: Record<string, { executionId: string; inputHash: string }>, fps = FPS): Uint8Array {
  const doc = new Y.Doc();
  initializeTimelineDocument(doc, { width: 1920, height: 1080, fps });
  const map = doc.getMap("operationReceipts");
  for (const [actionId, receipt] of Object.entries(receipts)) {
    attachTimelineRecord(map, actionId, { ...receipt, landedAt: new Date().toISOString() });
  }
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/**
 * The receipt the browser writes for an execution.
 * @param execution - The accepted row.
 * @returns The receipts map holding it.
 */
function receiptOf(execution: TimelineExecution): Record<string, { executionId: string; inputHash: string }> {
  return { [execution.actionId]: { executionId: execution.id, inputHash: execution.inputHash } };
}

/**
 * Store the state as collab's persistence does, then run acceptance on those same bytes.
 * @param documentName - The Timeline document.
 * @param state - The bytes being stored.
 */
async function storeAndAccept(documentName: string, state: Uint8Array): Promise<void> {
  ownedDocs.add(documentName);
  await yjsRepo.upsertDocData(documentName, state);
  await acceptTimelineReceipts(documentName, state);
}

/**
 * The space-tasks signals one Space received, after giving late ones time to arrive.
 * @param projectId - The Project.
 * @param spaceId - The Space.
 * @returns Them.
 */
async function signalsFor(projectId: string, spaceId: string): Promise<Record<string, unknown>[]> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return signals.filter((s) => s.channel.includes(projectId) && s.message.spaceId === spaceId).map((s) => s.message);
}

/**
 * Read a row back.
 * @param id - The execution.
 * @returns The row.
 */
async function read(id: string): Promise<TimelineExecution> {
  const row = await timelineExecutionRepo.findById(id);
  if (row === undefined) throw new Error("Execution missing");
  return row;
}

describe("acceptTimelineReceipts", () => {
  it("queues a matching receipt's execution, enqueues it once under its id and signals the Space once", async () => {
    const fx = await seed();
    const before = Date.now();
    await storeAndAccept(fx.documentName, timelineState(receiptOf(fx.execution)));
    const row = await read(fx.execution.id);
    expect(row).toMatchObject({ status: "queued", attempt: 0, fence: null, deadlineAt: fx.execution.deadlineAt });
    expect(row.nextDispatchAt).not.toBeNull();
    expect(Date.parse(row.nextDispatchAt!)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(row.nextDispatchAt!)).toBeLessThanOrEqual(Date.now() + 1_000);
    const job = await queue.getJob(fx.execution.id);
    expect(job?.id).toBe(fx.execution.id);
    expect(job?.data).toMatchObject({ executionId: fx.execution.id });
    expect(await signalsFor(fx.projectId, fx.spaceId)).toEqual([
      { type: "project-space-tasks:changed", projectId: fx.projectId, spaceId: fx.spaceId, ts: expect.any(Number) },
    ]);
  });

  it("does nothing more when the same receipts are stored again", async () => {
    const fx = await seed();
    const state = timelineState(receiptOf(fx.execution));
    await storeAndAccept(fx.documentName, state);
    const queued = await read(fx.execution.id);
    const job = await queue.getJob(fx.execution.id);
    await storeAndAccept(fx.documentName, state);
    expect(await read(fx.execution.id)).toEqual(queued);
    expect((await queue.getJob(fx.execution.id))?.timestamp).toBe(job?.timestamp);
    expect(await signalsFor(fx.projectId, fx.spaceId)).toHaveLength(1);
  });

  it("leaves the row awaiting landing when the document's frame rate differs from the accepted one", async () => {
    const fx = await seed({ inputFps: { num: 24, den: 1 } });
    const landed = await control(fx, { num: 30, den: 1 });
    await storeAndAccept(fx.documentName, timelineState({ ...receiptOf(fx.execution), ...receiptOf(landed) }, { num: 30, den: 1 }));
    expect((await read(landed.id)).status).toBe("queued");
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    expect(await queue.getJob(fx.execution.id)).toBeUndefined();
    expect(await signalsFor(fx.projectId, fx.spaceId)).toHaveLength(1);
  });

  it("leaves the row awaiting landing when the receipt's input hash differs", async () => {
    const fx = await seed();
    const landed = await control(fx);
    await storeAndAccept(fx.documentName, timelineState({
      [fx.execution.actionId]: { executionId: fx.execution.id, inputHash: "sha256:other" },
      ...receiptOf(landed),
    }));
    expect((await read(landed.id)).status).toBe("queued");
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    expect(await queue.getJob(fx.execution.id)).toBeUndefined();
  });

  it("leaves the row awaiting landing when the receipt sits under another action id", async () => {
    const fx = await seed();
    const landed = await control(fx);
    await storeAndAccept(fx.documentName, timelineState({
      [randomUUID()]: { executionId: fx.execution.id, inputHash: fx.execution.inputHash },
      ...receiptOf(landed),
    }));
    expect((await read(landed.id)).status).toBe("queued");
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    expect(await queue.getJob(fx.execution.id)).toBeUndefined();
  });

  it("leaves the row awaiting landing once its original deadline has passed", async () => {
    const fx = await seed();
    const landed = await control(fx);
    await sql`UPDATE timeline_executions SET deadline_at = now() - interval '1 minute' WHERE id = ${fx.execution.id}`;
    const late = await read(fx.execution.id);
    await storeAndAccept(fx.documentName, timelineState({ ...receiptOf(fx.execution), ...receiptOf(landed) }));
    expect((await read(landed.id)).status).toBe("queued");
    expect(await read(fx.execution.id)).toEqual(late);
    expect(await queue.getJob(fx.execution.id)).toBeUndefined();
  });

  it("leaves the row awaiting landing when the Project no longer lists the Space, while a listed Space's row lands", async () => {
    const fx = await seed({ listed: false });
    await storeAndAccept(fx.documentName, timelineState(receiptOf(fx.execution)));
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    expect(await queue.getJob(fx.execution.id)).toBeUndefined();
    const listed = await seed();
    await storeAndAccept(listed.documentName, timelineState(receiptOf(listed.execution)));
    expect((await read(listed.execution.id)).status).toBe("queued");
  });

  it("ignores receipts a duplicated Project's document carries for executions its source Project owns", async () => {
    const source = await seed();
    const copy = await seed({ spaceId: source.spaceId });
    await storeAndAccept(copy.documentName, timelineState({ ...receiptOf(source.execution), ...receiptOf(copy.execution) }));
    expect((await read(copy.execution.id)).status).toBe("queued");
    expect(await read(source.execution.id)).toEqual(source.execution);
    expect(await queue.getJob(source.execution.id)).toBeUndefined();
    expect(await signalsFor(source.projectId, source.spaceId)).toEqual([]);
    expect(await signalsFor(copy.projectId, copy.spaceId)).toHaveLength(1);
  });

  it("reads the receipts from the bytes it is handed, not from what is stored", async () => {
    const fx = await seed();
    const handed = await control(fx);
    ownedDocs.add(fx.documentName);
    await yjsRepo.upsertDocData(fx.documentName, timelineState(receiptOf(fx.execution)));
    await acceptTimelineReceipts(fx.documentName, timelineState(receiptOf(handed)));
    expect((await read(handed.id)).status).toBe("queued");
    expect(await read(fx.execution.id)).toEqual(fx.execution);
  });

  it("runs after every Timeline store collab's persistence makes", async () => {
    const fx = await seed();
    ownedDocs.add(fx.documentName);
    await storeDoc({ documentName: fx.documentName, state: timelineState(receiptOf(fx.execution)) });
    expect((await read(fx.execution.id)).status).toBe("queued");
    expect((await queue.getJob(fx.execution.id))?.id).toBe(fx.execution.id);
  });
});
