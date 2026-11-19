// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Remove-background durable admission (S6e E3b, inner#1306 test plan §90; design §5.3 remove-bg and model-input rows,
 * §7.11, §5.4 作业身份; frames-split §7.11). The request names its tool input; admission freezes the selected version
 * on the frame grid, `params.video` as the prepared reference `<taskId>:prep:0`, the standard-4 preparation (price,
 * limits and grid chunk windows) and the payer, and quotes the model (the grid's display duration) plus max(preparation
 * precheck, planned preparation work) at the frozen standard-4 price. The golden fingerprints were recomputed
 * independently with Python's canonical JSON/SHA-256 (ECMAScript number text).
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import { ConflictError, ForbiddenError, NotFoundError, createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import * as shared from "@breatic/shared";
import { miniToolExecutionRecordSchema, type MiniToolPlannedRequest } from "@breatic/shared/mini-tools";
import { acceptMiniToolExecution, type AcceptedMiniToolExecution } from "@domain/index.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { estimateModelCredits, MIN_TASK_CREDIT_COST, resetModelCatalog } from "@domain/model-catalog/model-catalog.js";
import { seedStudioFixture } from "../../../../server/src/__tests__/integration/studio-credit-fixtures.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";
import { presentedSource, type PresentedSource } from "../../../../server/src/__tests__/integration/presentation-fixtures.js";

const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), reads: [] as string[], ingest: vi.fn(), config: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof core>();
  return { ...actual, getMiniToolsConfig: (...args: unknown[]) => outside.config(...args) ?? actual.getMiniToolsConfig() };
});

interface Fixture {
  body: Extract<MiniToolPlannedRequest, { tool: "video.remove-bg" }>;
  userId: string;
  otherEditorId: string;
  viewerId: string;
  sourceStudioId: string;
  targetStudioId: string;
  sourceAssetId: string;
  sourceKey: string;
  sourceHash: string;
  presented: PresentedSource;
}
interface StoredTask {
  id: string;
  user_id: string;
  project_id: string;
  space_id: string;
  task_type: string;
  source: string;
  mode: string;
  status: string;
  model: string | null;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// inner#1306: the independent admission oracle supplies these request literals.
const GOLDEN_BODY: Extract<MiniToolPlannedRequest, { tool: "video.remove-bg" }> = {
  tool: "video.remove-bg",
  project_id: "10000000-0000-4000-8000-000000000001",
  space_id: "20000000-0000-4000-8000-000000000001",
  run_id: "50000000-0000-4000-8000-000000000001",
  draft: {
    version: 1,
    draftId: "60000000-0000-4000-8000-000000000001",
    revision: "70000000-0000-4000-8000-000000000001",
    source: {
      nodeId: "30000000-0000-4000-8000-000000000001",
      canonicalURL: "https://assets.example.test/video/source.mp4",
      mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" },
    },
    inputs: [],
    params: {},
  },
  analysis_refs: [],
  outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "remove-bg" } }],
  // The golden source's grid tool input (presentation-fixtures.ts with hash "a" x 64 at video/source.mp4).
  presentation_ref: { source: { toolInputId: "6d11edc6ff23f7252db3a5d7410aa1bc6fd09eb0a82d4e9416708a6e5a56f20d", planSha256: "f8d213d4c5ed6a79e8161cc7acf54c558ab53ea5f18cebc3baedb18f95a4d955" } },
};
// The complete server-plan projection was hashed independently with Python's JSON/SHA-256.
const GOLDEN_PLAN: AcceptedMiniToolExecution = {
  schemaVersion: 1,
  tool: "video.remove-bg",
  taskId: GOLDEN_BODY.run_id,
  projectId: GOLDEN_BODY.project_id,
  spaceId: GOLDEN_BODY.space_id,
  targetNodeIds: ["40000000-0000-4000-8000-000000000001"],
  binding: {
    assetId: "80000000-0000-4000-8000-000000000001",
    contentHash: "a".repeat(64),
    canonicalURL: "https://assets.example.test/video/source.mp4",
    kind: "video",
    mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" },
  },
  sourceKey: "video/source.mp4",
  draft: GOLDEN_BODY.draft,
  analysisRefs: [],
  outputs: GOLDEN_BODY.outputs,
  model: "bria-fibo-video-background-remover",
  provider: { provider: "wavespeed", model_id: "bria/fibo/video-background-remover" },
  body: {
    // E3-8: the provider input is the prepared model input, resolved by the worker after its preparation steps.
    video: { kind: "prepared", inputId: "source", job: "50000000-0000-4000-8000-000000000001:prep:0" },
    background_color: "Transparent",
    output_container_and_codec: "webm_vp9",
    preserve_audio: true,
  },
  // The selected version and its reference are the golden source's (presentation-fixtures.ts), set by `goldenPlan`.
  preparation: {
    containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
    prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, chunks: [{ start: 0, end: 1011 }],
    // §3.2 item 1: the preparation's retry cap is frozen at admission (encoding.chunk_retries).
    chunkRetries: 3,
    // §91 D3b-5: the model input's encode parameters, frozen at admission from presentation.crf/preset like the carrier's.
    encode: { crf: 18, preset: "medium" },
  },
  // Model 30 for 5.055 s of display + standard-4 preparation at its 300 s floor (0.03342 USD, the 5-credit minimum).
  credits: 35,
  chargeTo: "user",
  // The frozen model part of the quote (display.duration), so a retry that reruns only generate can hold it alone.
  modelCredits: 30,
  requestFingerprint: "91f5eef27ba46d6f47d72ab8878e296659fe7c0509b75eaea4a5fff359b78f86",
  // Both fingerprints were recomputed independently in Python (sorted keys, compact JSON, ECMAScript number text, SHA-256)
  // over the golden request and the plan with the golden source's grid version (frames-split §7.11).
  planFingerprint: "45ea65fbb8cb54f21c6367499bf09b0f20a3537d66d1a76efc5ce6f505e3fee1",
} as unknown as AcceptedMiniToolExecution;

let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;

/** Configure only fixture values; the key is never sent to an upstream. @throws {Error} If test configuration is invalid. */
function configure(key = "unused-by-admission-integration"): void {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: key, UPLOAD_BASE_URL: "https://assets.example.test" });
  resetModelCatalog();
}

beforeAll(async () => {
  configure();
  loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "execution-admission-fixtures", max: 6 });
  const storage = await getStorageAdapter();
  publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => {
  configure();
  outside.config.mockReset().mockReturnValue(undefined);
  outside.snapshots.clear(); outside.bodies.clear(); outside.reads.length = 0;
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    outside.reads.push(url);
    const body = outside.bodies.get(url);
    if (body === undefined) throw new Error(`Admission fetched an unstored URL: ${url}`);
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => { await pg.end(); initCore(process.env); resetModelCatalog(); vi.unstubAllGlobals(); });

/** Insert a real project member without synthesizing authorization answers. @throws {Error} On fixture SQL failure. */
async function member(projectId: string, role: "editor" | "viewer"): Promise<string> {
  const [user] = await pg<{ id: string }[]>`INSERT INTO users (email,email_verified)
    VALUES (${`planned-admission-${crypto.randomUUID()}@example.test`},true) RETURNING id`;
  if (!user) throw new Error("Fixture account was not inserted");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${projectId},${user.id},${role})`;
  return user.id;
}

/** Register a real cross-Studio video and target Project for this single run. @throws {Error} On fixture SQL failure. */
async function seed(golden = false): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "exec-target");
  const source = await seedStudioFixture(pg, "exec-source");
  let projectId = target.projectId;
  if (golden) {
    projectId = GOLDEN_BODY.project_id;
    await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name)
      VALUES (${projectId},${target.studioId},${target.userId},${`admission-golden-${crypto.randomUUID()}`},'Admission golden')`;
  }
  const userId = await member(projectId, "editor");
  const otherEditorId = await member(projectId, "editor");
  const viewerId = await member(projectId, "viewer");
  const sourceAssetId = golden ? GOLDEN_PLAN.binding.assetId : crypto.randomUUID();
  const sourceKey = golden ? "video/source.mp4" : `video/admission-fixture/${sourceAssetId}.mp4`;
  const sourceHash = golden ? "a".repeat(64) : crypto.randomBytes(32).toString("hex");
  const sourceURL = publicUrl(sourceKey);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceAssetId},${source.studioId},${sourceHash},${sourceKey},${sourceURL},4096,'video/mp4','video','upload',${source.userId},960,540,5.055)`;
  const body = structuredClone(GOLDEN_BODY);
  if (!golden) {
    body.project_id = projectId;
    body.space_id = crypto.randomUUID();
    body.run_id = crypto.randomUUID();
    body.draft.draftId = crypto.randomUUID();
    body.draft.revision = crypto.randomUUID();
    body.draft.source.nodeId = crypto.randomUUID();
    body.draft.source.canonicalURL = sourceURL;
    body.outputs[0]!.nodeId = crypto.randomUUID();
  }
  const presented = await presentedSource(sourceHash, sourceKey, publicUrl);
  outside.snapshots.set(sourceKey, presented.snapshot);
  body.presentation_ref = presented.presentationRef;
  return { body, userId, otherEditorId, viewerId, sourceStudioId: source.studioId, targetStudioId: target.studioId, sourceAssetId, sourceKey, sourceHash, presented };
}

/**
 * The golden plan with the golden source's selected version (frames-split §7.11): the plan freezes the version the
 * snapshot selects, its reference and its versionId.
 * @param f - The golden fixture.
 * @returns The plan.
 */
function goldenPlan(f: Fixture): AcceptedMiniToolExecution {
  return { ...GOLDEN_PLAN, presentationRef: f.presented.presentationRef, presentations: { source: f.presented.bundle }, versionIds: { source: f.presented.versionId } };
}

/** Read the task independently of the admission service and its repository mapper. @throws {Error} On fixture SQL failure. */
async function readTask(taskId: string): Promise<StoredTask | null> {
  const [row] = await pg<StoredTask[]>`SELECT id,user_id,project_id,space_id,task_type,source,mode,status,model,params,result,
    created_at::text,updated_at::text FROM tasks WHERE id=${taskId}`;
  return row ?? null;
}

/** The domain callback does not create real node rows, holds or queue jobs. @throws {Error} On unexpected callback execution. */
function startRecorder(): ReturnType<typeof vi.fn<(accepted: AcceptedMiniToolExecution) => Promise<"pending">>> {
  return vi.fn(async (_accepted: AcceptedMiniToolExecution): Promise<"pending"> => "pending");
}

describe("planned execution durable admission", () => {
  it("A03 freezes the independently specified complete cross-Studio plan before the sole start callback", async () => {
    const f = await seed(true);
    expect(f.sourceStudioId).not.toBe(f.targetStudioId);
    const captured: AcceptedMiniToolExecution[] = [];
    const start = vi.fn(async (accepted: AcceptedMiniToolExecution): Promise<"pending"> => {
      captured.push(structuredClone(accepted));
      const task = await readTask(accepted.taskId);
      expect(task?.params).toEqual({ miniToolExecution: goldenPlan(f) });
      return "pending";
    });
    expect(await acceptMiniToolExecution(f.body, f.userId, start)).toEqual({ taskId: GOLDEN_BODY.run_id, status: "pending" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([goldenPlan(f)]);
    const task = await readTask(f.body.run_id);
    expect(task).toMatchObject({ id: f.body.run_id, user_id: f.userId, project_id: f.body.project_id, space_id: f.body.space_id,
      task_type: "video", source: "mini_tool", mode: "append", status: "pending", model: "bria-fibo-video-background-remover", params: { miniToolExecution: goldenPlan(f) } });
    const [destination] = await pg<{ target_studio: string; source_studio: string }[]>`SELECT p.studio_id AS target_studio,a.studio_id AS source_studio
      FROM projects p CROSS JOIN studio_assets a WHERE p.id=${f.body.project_id} AND a.id=${f.sourceAssetId}`;
    expect(destination).toEqual({ target_studio: f.targetStudioId, source_studio: f.sourceStudioId });
    const [effects] = await pg<{ rows: number; holds: number }[]>`SELECT
      (SELECT count(*)::int FROM node_tasks WHERE task_id=${f.body.run_id}) AS rows,
      (SELECT count(*)::int FROM credit_holds WHERE reference_id=${f.body.run_id}) AS holds`;
    expect(effects).toEqual({ rows: 0, holds: 0 });
  });

  it("A08 replays canonical identity before source resolution, repricing or another callback", async () => {
    const f = await seed(); const start = startRecorder();
    const initial = await acceptMiniToolExecution(f.body, f.userId, start);
    const before = await readTask(f.body.run_id);
    await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.sourceAssetId}`;
    configure("");
    const reordered: MiniToolPlannedRequest = {
      outputs: structuredClone(f.body.outputs), analysis_refs: [],
      draft: { params: {}, inputs: [], source: structuredClone(f.body.draft.source), revision: f.body.draft.revision, draftId: f.body.draft.draftId, version: 1 },
      run_id: f.body.run_id, space_id: f.body.space_id, project_id: f.body.project_id, tool: "video.remove-bg",
      presentation_ref: structuredClone(f.body.presentation_ref),
    };
    expect(await acceptMiniToolExecution(reordered, f.userId, start)).toEqual(initial);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it.each(["revision", "source", "target", "space"] as const)("A09 rejects an existing run's changed %s without rewriting its winner", async (field) => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start); const before = await readTask(f.body.run_id);
    const changed = structuredClone(f.body);
    if (field === "revision") changed.draft.revision = crypto.randomUUID();
    else if (field === "source") changed.draft.source.canonicalURL = "https://foreign.example.test/changed.mp4";
    else if (field === "target") changed.outputs[0]!.nodeId = crypto.randomUUID();
    else changed.space_id = crypto.randomUUID();
    await expect(acceptMiniToolExecution(changed, f.userId, start)).rejects.toBeInstanceOf(ConflictError);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it("A09 checks actor identity even when another editor has real access to the same Project", async () => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start); const before = await readTask(f.body.run_id);
    await expect(acceptMiniToolExecution(f.body, f.otherEditorId, start)).rejects.toBeInstanceOf(ConflictError);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it("A09 refuses a second authorized Project claiming the same run id", async () => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start); const before = await readTask(f.body.run_id);
    const other = await seedStudioFixture(pg, "exec-other");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${other.projectId},${f.userId},'editor')`;
    await expect(acceptMiniToolExecution({ ...f.body, project_id: other.projectId }, f.userId, start)).rejects.toBeInstanceOf(ConflictError);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it("A10 snapshots the complete press before its first await and replays its original revision", async () => {
    const f = await seed(); const original = structuredClone(f.body); const start = startRecorder();
    const accepting = acceptMiniToolExecution(f.body, f.userId, start);
    f.body.draft.revision = crypto.randomUUID();
    f.body.draft.source.canonicalURL = "https://foreign.example.test/later-edit.mp4";
    f.body.outputs[0]!.nodeId = crypto.randomUUID();
    const initial = await accepting;
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0].draft).toEqual(original.draft);
    expect(start.mock.calls[0]?.[0].outputs).toEqual(original.outputs);
    const before = await readTask(original.run_id);
    expect(await acceptMiniToolExecution(original, f.userId, start)).toEqual(initial);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(original.run_id)).toEqual(before);
  });

  it("A11 admits a self-consistent revision UUID without inventing a latest-Yjs test", async () => {
    const f = await seed(); f.body.draft.revision = "00000000-0000-4000-8000-000000000001";
    const start = startRecorder();
    expect(await acceptMiniToolExecution(f.body, f.userId, start)).toEqual({ taskId: f.body.run_id, status: "pending" });
    expect(start.mock.calls.map(([accepted]) => accepted.draft.revision)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("A12 observes two real contenders at the task INSERT before selecting one durable starter", async () => {
    const f = await seed(); const start = startRecorder();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const owner = pg.begin(async (tx) => { await tx`LOCK TABLE tasks IN SHARE MODE`; entered(); await gate; });
    await ready;
    const first = acceptMiniToolExecution(f.body, f.userId, start);
    const second = acceptMiniToolExecution(structuredClone(f.body), f.userId, start);
    void first.catch(() => undefined); void second.catch(() => undefined);
    try {
      await waitUntilBlockedOn(pg, ["insert into", "tasks"], 2);
      release(); await owner;
      expect(await Promise.all([first, second])).toEqual([
        { taskId: f.body.run_id, status: "pending" }, { taskId: f.body.run_id, status: "pending" },
      ]);
      expect(start).toHaveBeenCalledTimes(1);
      const [count] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM tasks WHERE id=${f.body.run_id}`;
      expect(count).toEqual({ count: 1 });
    } finally { release(); await owner; await Promise.allSettled([first, second]); }
  });

  it.each([
    { name: "analysis", source: "mini_tool", taskType: "mini_tool_analysis", params: { analysis: { fixture: true } } },
    { name: "ordinary generation", source: "task", taskType: "video", params: { fixture: "generation" } },
    { name: "legacy mini-tool", source: "mini_tool", taskType: "video", params: { fixture: "legacy" } },
  ])("A13 preserves a PK occupied by $name", async ({ source, taskType, params }) => {
    const f = await seed(); const start = startRecorder();
    await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params)
      VALUES (${f.body.run_id},${f.userId},${f.body.project_id},${f.body.space_id},${taskType},'append',${source},'pending',${pg.json(params)})`;
    const before = await readTask(f.body.run_id);
    await expect(acceptMiniToolExecution(f.body, f.userId, start)).rejects.toBeInstanceOf(ConflictError);
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it("A14 refuses an unavailable real catalog before creating or starting a task", async () => {
    const f = await seed(); const start = startRecorder(); configure("");
    await expect(acceptMiniToolExecution(f.body, f.userId, start)).rejects.toMatchObject({ statusCode: 503 });
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toBeNull();
  });

  it.each(["missing membership", "missing Project", "deleted Project"] as const)("requires current project authority for %s", async (kind) => {
    const f = await seed(); const start = startRecorder();
    if (kind === "missing membership") await pg`UPDATE project_members SET deleted_at=clock_timestamp() WHERE project_id=${f.body.project_id} AND user_id=${f.userId}`;
    else if (kind === "missing Project") f.body.project_id = crypto.randomUUID();
    else await pg`UPDATE projects SET deleted_at=clock_timestamp() WHERE id=${f.body.project_id}`;
    await expect(acceptMiniToolExecution(f.body, f.userId, start)).rejects.toBeInstanceOf(NotFoundError);
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toBeNull();
  });

  it("refuses a real viewer before claiming the run", async () => {
    const f = await seed(); const start = startRecorder();
    await expect(acceptMiniToolExecution(f.body, f.viewerId, start)).rejects.toBeInstanceOf(ForbiddenError);
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toBeNull();
  });

  it("keeps persisted user identity and source binding independent from client media claims", async () => {
    const f = await seed(); const start = startRecorder();
    f.body.draft.source.mediaInfo = { width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" };
    await acceptMiniToolExecution(f.body, f.userId, start);
    const accepted = start.mock.calls[0]?.[0];
    expect(accepted?.binding).toEqual({ assetId: f.sourceAssetId, contentHash: f.sourceHash, canonicalURL: f.body.draft.source.canonicalURL,
      kind: "video", mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } });
    expect(accepted?.credits).toBe(35);
    expect(accepted?.draft.source.mediaInfo).toEqual({ width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" });
  });
});

/**
 * Record that a run finished its model-input preparation: its prepared pin, as the preparation's registration writes it
 * (design §7.15 prepared row). A removal retry reuses only such a preparation (frames-split retry row).
 * @param runId - The run that prepared.
 * @param toolInputId - Its source's tool input.
 * @param sourceKey - Its source's storage key.
 * @returns Nothing.
 * @throws {Error} On fixture SQL failure.
 */
async function seedPrepared(runId: string, toolInputId: string, sourceKey: string): Promise<void> {
  const preparedKey = `${sourceKey}.${runId}:prep:0:a1`;
  const [pin] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id,prepared_key)
    VALUES ('prepared',${runId},${toolInputId},${preparedKey}) RETURNING id`;
  await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${pin!.id},${preparedKey})`;
}

/** Credits for some standard-4 seconds under the shipped configuration: the one container quote rule (E3-5). @throws {Error} On invalid prices. */
function std4Credits(seconds: number): number {
  const config = core.getMiniToolsConfig();
  return Math.max(shared.ceilToCreditCent(creditsForUsd(containerCostUsd({ wallMs: seconds * 1000, cpuUsec: null }, config.classes.MiniToolContainerStd4!, config.prices), 1)), MIN_TASK_CREDIT_COST);
}

describe("remove-bg model-input preparation at admission (inner#1306 §90 E3b; design §5.3, §5.4, §7.11)", () => {
  it("RB-A01 freezes params.video as the prepared reference of this run's first preparation", async () => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start);
    const accepted = start.mock.calls[0]![0] as unknown as { body: { video: unknown }; presentationRef: unknown; preparation: { chunks: unknown } };
    expect(accepted.body.video).toEqual({ kind: "prepared", inputId: "source", job: `${f.body.run_id}:prep:0` });
    expect(accepted.presentationRef).toEqual(f.body.presentation_ref);
    expect(accepted.preparation.chunks).toEqual([{ start: 0, end: 1011 }]);
    // §3.2 item 1: the preparation's retry cap is frozen with it.
    expect(accepted.preparation).toMatchObject({ chunkRetries: core.getMiniToolsConfig().encoding.chunk_retries });
  });

  // §91 D3b-5 (design §5.3 model-input row, §5.4 「编码参数完全一致」): the model input's crf and preset are frozen at
  // admission from the presentation encode settings, so every preparation chunk of the run encodes alike whatever the
  // configuration says later.
  it("RB-A03 freezes the model input's encode parameters from the presentation settings", async () => {
    const f = await seed(); const start = startRecorder();
    const { presentation } = core.getMiniToolsConfig();
    await acceptMiniToolExecution(f.body, f.userId, start);
    const accepted = start.mock.calls[0]![0] as unknown as { preparation: { encode?: unknown } };
    expect(accepted.preparation.encode).toEqual({ crf: presentation.crf, preset: presentation.preset });
  });

  it("RB-A02 quotes the model from the display duration plus the preparation at max(precheck, planned work)", async () => {
    const f = await seed(); const start = startRecorder();
    const actual = structuredClone(core.getMiniToolsConfig());
    actual.executions["video.remove-bg"].preparation.precheck_seconds = 100000;
    outside.config.mockReturnValue(actual);
    await acceptMiniToolExecution(f.body, f.userId, start);
    const model = await estimateModelCredits("bria-fibo-video-background-remover", { params: {}, durations: { video: [5.055] }, sources: ["video"] });
    const accepted = start.mock.calls[0]![0] as unknown as { credits: number; modelCredits: number };
    expect(accepted.modelCredits).toBe(model!.credits);
    // A fresh run's quote is the frozen model part plus the preparation part.
    expect(accepted.credits).toBe(accepted.modelCredits + std4Credits(100000));
  });

  // frames-split §7.11: the press is admitted only on the selected version it names.
  it.each(["ref toolInputId", "ref planSha256", "nothing selected"])("RB-A03 refuses when %s, before claiming the run", async (bad) => {
    const f = await seed(); const start = startRecorder();
    const snapshot = outside.snapshots.get(f.sourceKey) as { presentation: unknown };
    if (bad === "ref toolInputId") f.body.presentation_ref.source.toolInputId = "b".repeat(64);
    else if (bad === "ref planSha256") f.body.presentation_ref.source.planSha256 = "b".repeat(64);
    else snapshot.presentation = null;
    await expect(acceptMiniToolExecution(f.body, f.userId, start)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toBeNull();
  });

  it("RB-R01 a failed-output retry reuses the frozen params.video reference and preparation without reading the current version or re-preparing", async () => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start);
    const original = start.mock.calls[0]![0] as unknown as { body: { video: unknown }; preparation: unknown; presentationRef: unknown; presentations: unknown; planFingerprint: string; binding: unknown; outputs: unknown[]; sourceKey: string };
    await seedPrepared(f.body.run_id, f.body.presentation_ref.source.toolInputId, original.sourceKey);
    const record = miniToolExecutionRecordSchema.parse({ schemaVersion: 1, runId: f.body.run_id, status: "failed", planFingerprint: original.planFingerprint,
      resultVersion: 1, sourceBindings: [original.binding], outputs: (original.outputs as Record<string, unknown>[]).map((output) => ({ ...output, late: false,
        result: { status: "failed", error: { code: "provider_failed" } } })), usage: [], billingState: "idle", error: { code: "provider_failed" } });
    await pg`UPDATE tasks SET status='failed',result=${pg.json({ miniToolExecution: JSON.parse(JSON.stringify(record)) })},completed_at=clock_timestamp() WHERE id=${f.body.run_id}`;
    outside.ingest.mockClear(); outside.reads.length = 0;
    const retry = { tool: "video.remove-bg", project_id: f.body.project_id, space_id: f.body.space_id, run_id: crypto.randomUUID(), retry: { runId: f.body.run_id, outputIndexes: [0] } };
    await acceptMiniToolExecution(retry as never, f.otherEditorId, start);
    const accepted = start.mock.calls[1]![0] as unknown as typeof original;
    expect(accepted.body.video).toEqual(original.body.video);
    expect(accepted.preparation).toEqual(original.preparation);
    expect(accepted.presentationRef).toEqual(original.presentationRef);
    expect(accepted.presentations).toEqual(original.presentations);
    expect(outside.ingest).not.toHaveBeenCalled(); expect(outside.reads).toEqual([]);
  });

  it("RB-R02 a failed-output retry reruns only generate: its quote is the frozen model part alone, without the preparation it does not rerun", async () => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start);
    const original = start.mock.calls[0]![0] as unknown as { planFingerprint: string; binding: unknown; outputs: unknown[]; sourceKey: string };
    await seedPrepared(f.body.run_id, f.body.presentation_ref.source.toolInputId, original.sourceKey);
    const record = miniToolExecutionRecordSchema.parse({ schemaVersion: 1, runId: f.body.run_id, status: "failed", planFingerprint: original.planFingerprint,
      resultVersion: 1, sourceBindings: [original.binding], outputs: (original.outputs as Record<string, unknown>[]).map((output) => ({ ...output, late: false,
        result: { status: "failed", error: { code: "provider_failed" } } })), usage: [], billingState: "idle", error: { code: "provider_failed" } });
    await pg`UPDATE tasks SET status='failed',result=${pg.json({ miniToolExecution: JSON.parse(JSON.stringify(record)) })},completed_at=clock_timestamp() WHERE id=${f.body.run_id}`;
    const retry = { tool: "video.remove-bg", project_id: f.body.project_id, space_id: f.body.space_id, run_id: crypto.randomUUID(), retry: { runId: f.body.run_id, outputIndexes: [0] } };
    await acceptMiniToolExecution(retry as never, f.userId, start);
    const model = await estimateModelCredits("bria-fibo-video-background-remover", { params: {}, durations: { video: [5.055] }, sources: ["video"] });
    expect(start.mock.calls[0]![0].credits).toBe(model!.credits + std4Credits(300));
    expect(start.mock.calls[1]![0].credits).toBe(model!.credits);
  });
});

