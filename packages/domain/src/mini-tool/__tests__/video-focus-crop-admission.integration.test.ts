// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video focus crop admission (frames-split design §5.5 "受理", "计划形状", "配置", §7.11; test plan §68.1 F02, F11 and §68.2
 * FI08, FI09, FI11, FI12).
 *
 * A focus crop is admitted through the planned-run entry as tool `video.focus-crop`: its draft names the framed video node as
 * `source`, its only output is the panel node with a `frame` recipe carrying `crop`, it is checked against the selected
 * version like every fresh admission, it is platform-funded (quote 0, no hold, `chargeTo: "platform"` frozen in the plan) and
 * its task type is image. A replay of the same press is not a conflict. A new crop does not check the panel node for running
 * executions, so two crops on one panel run side by side; and the retry check that does look at output nodes counts only
 * executions that write their output node's content, so a running crop never blocks the retry of the panel node's own failed
 * result.
 *
 * Only the external presentation read is controlled, as in `execution-admission.integration.test.ts`. The platform-funded
 * set (`PLATFORM_FUNDED` and `miniToolChargeTo` in `packages/shared/src/mini-tools/platform-funded.ts`) is replaced in the
 * `@breatic/shared/mini-tools` entry admission imports, so FI12 can swap in a different set after admission.
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, db, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import type * as shared from "@breatic/shared";
import { t } from "@breatic/shared";
import type * as miniTools from "@breatic/shared/mini-tools";
import type { MiniToolPlannedRequest } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import { acceptMiniToolExecution, quoteMiniToolExecution, type AcceptedMiniToolExecution } from "@domain/index.js";

/** A hold that takes nothing: the cases below that are about holding pass their own. */
const NO_HOLD = async (): Promise<void> => undefined;
import { resetModelCatalog } from "@domain/model-catalog/model-catalog.js";
import { seedStudioFixture } from "../../../../server/src/__tests__/integration/studio-credit-fixtures.js";
import { presentedSource } from "../../../../server/src/__tests__/integration/presentation-fixtures.js";

const FUNDED: readonly string[] = ["video.extract-frames", "video.focus-crop"];
const outside = vi.hoisted(() => ({
  snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn(),
  funded: new Set<string>(),
}));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));
vi.mock("@breatic/shared/mini-tools", async (original) => ({
  ...await original<typeof miniTools>(),
  get PLATFORM_FUNDED(): ReadonlySet<string> { return outside.funded; },
  miniToolChargeTo: (subject: string): "platform" | "user" => (outside.funded.has(subject) ? "platform" : "user"),
}));

// A crop inside the selected version's 960x540 display (frames-split §5.5 admission row).
const CROP = { x: 240, y: 135, width: 480, height: 270 };
type FocusBody = Record<string, unknown> & { tool: "video.focus-crop"; project_id: string; space_id: string; run_id: string; outputs: Array<{ nodeId: string }>; presentation_ref: { source: { toolInputId: string; planSha256: string } } };
interface Fixture { userId: string; projectId: string; studioId: string; panelNodeId: string; body: FocusBody }
type FrozenCrop = AcceptedMiniToolExecution & { chargeTo?: string; credits: number; outputs: Array<{ outputIndex: number; nodeId: string; recipe: unknown }> };

let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;

beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", STRIPE_SECRET_KEY: "sk_test_unused_focus", STRIPE_WEBHOOK_SECRET: "whsec_unused_focus", UPLOAD_BASE_URL: "https://assets.example.test" });
  resetModelCatalog(); loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "video-focus-crop-admission", max: 4 });
  const storage = await getStorageAdapter();
  publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => {
  outside.funded = new Set(FUNDED);
  outside.snapshots.clear(); outside.bodies.clear();
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = outside.bodies.get(url);
    if (body === undefined) throw new Error(`Admission fetched an unstored URL: ${url}`);
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => { await pg.end(); initCore(process.env); resetModelCatalog(); vi.unstubAllGlobals(); });

/**
 * A registered video whose selected version is presented, an editor, and a focus-crop press on a panel node.
 * @param panelNodeId - The panel node; a fresh one when omitted.
 * @param target - An existing Project and Space to press in.
 * @returns The fixture.
 * @throws {Error} On fixture SQL failure.
 */
async function seed(panelNodeId: string = crypto.randomUUID(), target?: Pick<Fixture, "userId" | "projectId" | "studioId"> & { spaceId: string; sourceNodeId: string; sourceURL: string; ref: FocusBody["presentation_ref"] }): Promise<Fixture & { spaceId: string; sourceNodeId: string; sourceURL: string; ref: FocusBody["presentation_ref"] }> {
  let base = target;
  if (base === undefined) {
    const studio = await seedStudioFixture(pg, "focus-crop");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${studio.projectId},${studio.userId},'editor')`;
    const sourceAssetId = crypto.randomUUID(); const sourceKey = `video/focus-crop-fixture/${sourceAssetId}.mp4`; const hash = crypto.randomBytes(32).toString("hex");
    const sourceURL = publicUrl(sourceKey);
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceAssetId},${studio.studioId},${hash},${sourceKey},${sourceURL},4096,'video/mp4','video','upload',${studio.userId},960,540,5.055)`;
    const presented = await presentedSource(hash, sourceKey, publicUrl);
    outside.snapshots.set(sourceKey, presented.snapshot);
    base = { userId: studio.userId, projectId: studio.projectId, studioId: studio.studioId, spaceId: crypto.randomUUID(), sourceNodeId: crypto.randomUUID(), sourceURL, ref: presented.presentationRef };
  }
  const body: FocusBody = {
    tool: "video.focus-crop", project_id: base.projectId, space_id: base.spaceId, run_id: crypto.randomUUID(),
    draft: { version: 1, draftId: crypto.randomUUID(), revision: crypto.randomUUID(),
      source: { nodeId: base.sourceNodeId, canonicalURL: base.sourceURL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } },
      inputs: [], params: { frameIndex: 42, crop: CROP, sourceName: "Clip 7" } },
    analysis_refs: [], presentation_ref: structuredClone(base.ref),
    outputs: [{ outputIndex: 0, nodeId: panelNodeId, recipe: { kind: "frame", frameIndex: 42, crop: CROP } } as unknown as { nodeId: string }],
  };
  return { ...base, panelNodeId, body };
}

/**
 * The stored task, read apart from the service.
 * @param taskId - The task.
 * @returns Its row, or null.
 * @throws {Error} On SQL failure.
 */
async function readTask(taskId: string): Promise<{ task_type: string; status: string; params: { miniToolExecution: FrozenCrop } } | null> {
  const [row] = await pg<{ task_type: string; status: string; params: { miniToolExecution: FrozenCrop } }[]>`SELECT task_type,status,params FROM tasks WHERE id=${taskId}`;
  return row ?? null;
}

/**
 * A start callback that records the accepted plan.
 * @returns The spy.
 */
function recorder(): ReturnType<typeof vi.fn<(accepted: AcceptedMiniToolExecution) => Promise<"pending">>> {
  return vi.fn(async (_accepted: AcceptedMiniToolExecution): Promise<"pending"> => "pending");
}

/**
 * Seed a pending or running planned execution row reserving the given output node.
 * @param f - Where.
 * @param tool - Its tool.
 * @param nodeId - The output node it writes.
 * @returns Its id.
 * @throws {Error} On SQL failure.
 */
async function reserve(f: Fixture & { spaceId: string }, tool: string, nodeId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${id},${f.userId},${f.projectId},${f.spaceId},${tool === "video.split" ? "video" : "image"},'append','mini_tool','running',${tool},
      ${pg.json({ miniToolExecution: { tool, outputs: [{ outputIndex: 0, nodeId }] } })},${pg.json({})})`;
  return id;
}

/**
 * The retry check's answer for one output node.
 * @param f - Where.
 * @param nodeId - The node.
 * @returns Whether a running execution reserves it.
 * @throws {Error} On SQL failure.
 */
async function reserved(f: Fixture & { spaceId: string }, nodeId: string): Promise<boolean> {
  return db.transaction(async (tx) => domain.taskRepo.hasActiveMiniToolExecutionNodes(f.projectId, f.spaceId, [nodeId], tx));
}

describe("video focus crop admission (design §5.5 受理, 计划形状, 配置; §7.11)", () => {
  it("F02 admits the crop on the selected version, freezes the panel node as its only output and holds nothing", async () => {
    const f = await seed(); const start = recorder();
    const admitted = await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, start, NO_HOLD);
    expect(admitted).toEqual({ taskId: f.body.run_id, status: "pending" });
    expect(start).toHaveBeenCalledTimes(1);
    const task = await readTask(f.body.run_id);
    expect(task?.task_type).toBe("image");
    const plan = task!.params.miniToolExecution;
    expect(plan).toMatchObject({ tool: "video.focus-crop", targetNodeIds: [f.panelNodeId], credits: 0, chargeTo: "platform",
      outputs: [{ outputIndex: 0, nodeId: f.panelNodeId, recipe: { kind: "frame", frameIndex: 42, crop: CROP } }] });
    expect([...await pg`SELECT id FROM credit_holds WHERE reference_id=${f.body.run_id}`]).toEqual([]);
  });

  it("F02 a replay of the same press returns the admitted run without a conflict or a second start", async () => {
    const f = await seed(); const start = recorder();
    const first = await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, start, NO_HOLD);
    const again = await acceptMiniToolExecution(structuredClone(f.body) as unknown as MiniToolPlannedRequest, f.userId, start, NO_HOLD);
    expect(again).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("F02 refuses a press naming a version that is not the selected one, saying the video was updated, with no task", async () => {
    const f = await seed();
    const stale = structuredClone(f.body); stale.presentation_ref = { source: { toolInputId: "0".repeat(64), planSha256: f.body.presentation_ref.source.planSha256 } };
    await expect(acceptMiniToolExecution(stale as unknown as MiniToolPlannedRequest, f.userId, recorder(), NO_HOLD)).rejects.toThrow(t("server.mini_tool.presentationChanged"));
    expect(await readTask(stale.run_id)).toBeNull();
    // The same press on the selected version is admitted, so the refusal above is the version check and not the tool.
    expect(await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, recorder(), NO_HOLD)).toEqual({ taskId: f.body.run_id, status: "pending" });
  });

  it("FI08 two crops on one panel node are both admitted and run side by side", async () => {
    const f = await seed();
    const second = await seed(f.panelNodeId, f);
    expect(await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, recorder(), NO_HOLD)).toEqual({ taskId: f.body.run_id, status: "pending" });
    expect(await acceptMiniToolExecution(second.body as unknown as MiniToolPlannedRequest, f.userId, recorder(), NO_HOLD)).toEqual({ taskId: second.body.run_id, status: "pending" });
    const plans = [(await readTask(f.body.run_id))!.params.miniToolExecution, (await readTask(second.body.run_id))!.params.miniToolExecution];
    expect(plans.map((plan) => plan.outputs[0]!.nodeId)).toEqual([f.panelNodeId, f.panelNodeId]);
  });

  it("FI11 the crop quotes 0 and freezes chargeTo platform", async () => {
    const f = await seed();
    expect(await quoteMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId)).toEqual({ credits: 0 });
    await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, recorder(), NO_HOLD);
    expect((await readTask(f.body.run_id))!.params.miniToolExecution).toMatchObject({ credits: 0, chargeTo: "platform" });
  });

  it("FI12 changing the platform-funded set after admission leaves the admitted run's price and payer as frozen", async () => {
    const f = await seed();
    await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, recorder(), NO_HOLD);
    const frozen = (await readTask(f.body.run_id))!.params.miniToolExecution;
    expect(frozen).toMatchObject({ credits: 0, chargeTo: "platform" });
    outside.funded = new Set(FUNDED.filter((subject) => subject !== "video.focus-crop"));
    expect(await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, recorder(), NO_HOLD)).toEqual({ taskId: f.body.run_id, status: "pending" });
    expect((await readTask(f.body.run_id))!.params.miniToolExecution).toEqual(frozen);
    expect([...await pg`SELECT id FROM credit_holds WHERE reference_id=${f.body.run_id}`]).toEqual([]);
    // The replaced set reaches admission: a fresh crop is now user-paid and quoted above 0, so the frozen run above is
    // unchanged because of the freeze and not because the replacement missed.
    const fresh = await seed(crypto.randomUUID(), f);
    expect((await quoteMiniToolExecution(fresh.body as unknown as MiniToolPlannedRequest, f.userId)).credits).toBeGreaterThan(0);
  });
});

describe("the retry check counts only executions that write their output node's content (design §5.5 计划形状, §7.11)", () => {
  it("F11 a running focus crop does not reserve its panel node", async () => {
    const f = await seed();
    await reserve(f, "video.focus-crop", f.panelNodeId);
    expect(await reserved(f, f.panelNodeId)).toBe(false);
  });

  it("FI09 a crop running on another tool's failed result does not block its retry, while two content writers still conflict", async () => {
    const f = await seed();
    // The panel node is a frame extract-frames failed to write; a crop is running on it.
    await reserve(f, "video.focus-crop", f.panelNodeId);
    expect(await reserved(f, f.panelNodeId)).toBe(false);
    // Another execution writing that node's content still reserves it.
    await reserve(f, "video.extract-frames", f.panelNodeId);
    expect(await reserved(f, f.panelNodeId)).toBe(true);
  });
});

// inner#1968 design 3.10 U9: a run that spends credits holds them under its task's id in the transaction that claims its
// task row, so a refusal (the balance or a monthly spend limit) rolls back and leaves no task row, no pin and nothing started.
describe("the planned run holds its credits with its task row's claim (inner#1968 design 3.10)", () => {
  it("M1-01 a user-paid run holds its quote under its run id in the transaction that claims its task row", async () => {
    outside.funded = new Set(FUNDED.filter((subject) => subject !== "video.focus-crop"));
    const f = await seed(); const start = recorder();
    const seen: Array<{ taskId: string; credits: number; rowOutside: unknown }> = [];
    const hold = vi.fn(async (taskId: string, credits: number, tx: unknown): Promise<void> => {
      expect(tx).toBeDefined();
      // The claim has not committed: another connection does not see the row yet.
      seen.push({ taskId, credits, rowOutside: await readTask(taskId) });
    });
    await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, start, hold);
    const frozen = (await readTask(f.body.run_id))!.params.miniToolExecution;
    expect(frozen.credits).toBeGreaterThan(0);
    expect(seen).toEqual([{ taskId: f.body.run_id, credits: frozen.credits, rowOutside: null }]);
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!);
  });

  it("M1-02 a refused hold writes no task row and no pin and starts nothing", async () => {
    outside.funded = new Set(FUNDED.filter((subject) => subject !== "video.focus-crop"));
    const f = await seed(); const start = recorder();
    const refusal = new Error("fixture_spend_cap_reached");
    await expect(acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, start, async () => { throw refusal; })).rejects.toBe(refusal);
    expect(start).not.toHaveBeenCalled();
    expect(await readTask(f.body.run_id)).toBeNull();
    expect([...await pg`SELECT id FROM presentation_pins WHERE holder_id=${f.body.run_id}`]).toEqual([]);
  });

  it("M1-03 a platform-funded run holds nothing", async () => {
    const f = await seed(); const hold = vi.fn(async (): Promise<void> => undefined);
    await acceptMiniToolExecution(f.body as unknown as MiniToolPlannedRequest, f.userId, recorder(), hold);
    expect(hold).not.toHaveBeenCalled();
  });
});
