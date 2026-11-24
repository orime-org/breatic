// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Planned execution durable admission (inner#1306 test plan §90; frames-split §5.4, §5.5, §7.11), on frame extraction.
 * The request names its tool input; admission freezes the selected version on the frame grid, the frames layout, the
 * standard-4 policy and the payer (the platform pays for frame extraction, so it quotes 0).
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type * as core from "@breatic/core";
import { ConflictError, ForbiddenError, NotFoundError, createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import type * as shared from "@breatic/shared";
import type { MiniToolPlannedRequest } from "@breatic/shared/mini-tools";
import { acceptMiniToolExecution, miniToolExecutionService, type AcceptedMiniToolExecution } from "@domain/index.js";

/** These cases are about admission, not credits: every run here is platform-funded and holds nothing. */
const NO_HOLD = async (): Promise<void> => undefined;
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
  body: Extract<MiniToolPlannedRequest, { tool: "video.extract-frames" }>;
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
const GOLDEN_BODY: Extract<MiniToolPlannedRequest, { tool: "video.extract-frames" }> = {
  tool: "video.extract-frames",
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
    params: { mode: "first", frameIndex: 0 },
  },
  analysis_refs: [],
  outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "frame", frameIndex: 0 } }],
  // The golden source's grid tool input (presentation-fixtures.ts with hash "a" x 64 at video/source.mp4).
  presentation_ref: { source: { toolInputId: "6d11edc6ff23f7252db3a5d7410aa1bc6fd09eb0a82d4e9416708a6e5a56f20d", planSha256: "f8d213d4c5ed6a79e8161cc7acf54c558ab53ea5f18cebc3baedb18f95a4d955" } },
};
const GOLDEN_ASSET = "80000000-0000-4000-8000-000000000001";

let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;

/** Configure only fixture values. @throws {Error} If test configuration is invalid. */
function configure(): void {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", UPLOAD_BASE_URL: "https://assets.example.test" });
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
afterAll(async () => { await pg.end(); initCore(process.env); vi.unstubAllGlobals(); });

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
  const sourceAssetId = golden ? GOLDEN_ASSET : crypto.randomUUID();
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
  it("A03 freezes the complete cross-Studio frames plan before the sole start callback", async () => {
    const f = await seed(true);
    expect(f.sourceStudioId).not.toBe(f.targetStudioId);
    const captured: AcceptedMiniToolExecution[] = [];
    const start = vi.fn(async (accepted: AcceptedMiniToolExecution): Promise<"pending"> => {
      captured.push(structuredClone(accepted));
      const task = await readTask(accepted.taskId);
      expect(task?.params).toEqual({ miniToolExecution: JSON.parse(JSON.stringify(accepted)) });
      return "pending";
    });
    expect(await acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD)).toEqual({ taskId: GOLDEN_BODY.run_id, status: "pending" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(captured[0]).toMatchObject({ tool: "video.extract-frames", taskId: GOLDEN_BODY.run_id, model: "video.extract-frames", chargeTo: "platform", credits: 0,
      sourceKey: "video/source.mp4", outputs: GOLDEN_BODY.outputs, draft: GOLDEN_BODY.draft, layout: { batches: [[0]], encodes: [] },
      presentationRef: f.presented.presentationRef, presentations: { source: f.presented.bundle }, versionIds: { source: f.presented.versionId } });
    const task = await readTask(f.body.run_id);
    expect(task).toMatchObject({ id: f.body.run_id, user_id: f.userId, project_id: f.body.project_id, space_id: f.body.space_id,
      task_type: "image", source: "mini_tool", mode: "append", status: "pending", model: "video.extract-frames" });
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
    const initial = await acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD);
    const before = await readTask(f.body.run_id);
    await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.sourceAssetId}`;
    const reordered: MiniToolPlannedRequest = {
      outputs: structuredClone(f.body.outputs), analysis_refs: [],
      draft: { params: { frameIndex: 0, mode: "first" }, inputs: [], source: structuredClone(f.body.draft.source), revision: f.body.draft.revision, draftId: f.body.draft.draftId, version: 1 },
      run_id: f.body.run_id, space_id: f.body.space_id, project_id: f.body.project_id, tool: "video.extract-frames",
      presentation_ref: structuredClone(f.body.presentation_ref),
    };
    expect(await acceptMiniToolExecution(reordered, f.userId, start, NO_HOLD)).toEqual(initial);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it.each(["revision", "source", "target", "space"] as const)("A09 rejects an existing run's changed %s without rewriting its winner", async (field) => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD); const before = await readTask(f.body.run_id);
    const changed = structuredClone(f.body);
    if (field === "revision") changed.draft.revision = crypto.randomUUID();
    else if (field === "source") changed.draft.source.canonicalURL = "https://foreign.example.test/changed.mp4";
    else if (field === "target") changed.outputs[0]!.nodeId = crypto.randomUUID();
    else changed.space_id = crypto.randomUUID();
    await expect(acceptMiniToolExecution(changed, f.userId, start, NO_HOLD)).rejects.toBeInstanceOf(ConflictError);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it("A09 checks actor identity even when another editor has real access to the same Project", async () => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD); const before = await readTask(f.body.run_id);
    await expect(acceptMiniToolExecution(f.body, f.otherEditorId, start, NO_HOLD)).rejects.toBeInstanceOf(ConflictError);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it("A09 refuses a second authorized Project claiming the same run id", async () => {
    const f = await seed(); const start = startRecorder();
    await acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD); const before = await readTask(f.body.run_id);
    const other = await seedStudioFixture(pg, "exec-other");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${other.projectId},${f.userId},'editor')`;
    await expect(acceptMiniToolExecution({ ...f.body, project_id: other.projectId }, f.userId, start, NO_HOLD)).rejects.toBeInstanceOf(ConflictError);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(f.body.run_id)).toEqual(before);
  });

  it("A10 snapshots the complete press before its first await and replays its original revision", async () => {
    const f = await seed(); const original = structuredClone(f.body); const start = startRecorder();
    const accepting = acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD);
    f.body.draft.revision = crypto.randomUUID();
    f.body.draft.source.canonicalURL = "https://foreign.example.test/later-edit.mp4";
    f.body.outputs[0]!.nodeId = crypto.randomUUID();
    const initial = await accepting;
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0].draft).toEqual(original.draft);
    expect(start.mock.calls[0]?.[0].outputs).toEqual(original.outputs);
    const before = await readTask(original.run_id);
    expect(await acceptMiniToolExecution(original, f.userId, start, NO_HOLD)).toEqual(initial);
    expect(start).toHaveBeenCalledTimes(1); expect(await readTask(original.run_id)).toEqual(before);
  });

  it("A11 admits a self-consistent revision UUID without inventing a latest-Yjs test", async () => {
    const f = await seed(); f.body.draft.revision = "00000000-0000-4000-8000-000000000001";
    const start = startRecorder();
    expect(await acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD)).toEqual({ taskId: f.body.run_id, status: "pending" });
    expect(start.mock.calls.map(([accepted]) => accepted.draft.revision)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("A12 observes two real contenders at the task INSERT before selecting one durable starter", async () => {
    const f = await seed(); const start = startRecorder();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const owner = pg.begin(async (tx) => { await tx`LOCK TABLE tasks IN SHARE MODE`; entered(); await gate; });
    await ready;
    const first = acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD);
    const second = acceptMiniToolExecution(structuredClone(f.body), f.userId, start, NO_HOLD);
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
    await expect(acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD)).rejects.toBeInstanceOf(ConflictError);
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toEqual(before);
  });


  it.each(["missing membership", "missing Project", "deleted Project"] as const)("requires current project authority for %s", async (kind) => {
    const f = await seed(); const start = startRecorder();
    if (kind === "missing membership") await pg`UPDATE project_members SET deleted_at=clock_timestamp() WHERE project_id=${f.body.project_id} AND user_id=${f.userId}`;
    else if (kind === "missing Project") f.body.project_id = crypto.randomUUID();
    else await pg`UPDATE projects SET deleted_at=clock_timestamp() WHERE id=${f.body.project_id}`;
    await expect(acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD)).rejects.toBeInstanceOf(NotFoundError);
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toBeNull();
  });

  it("refuses a real viewer before claiming the run", async () => {
    const f = await seed(); const start = startRecorder();
    await expect(acceptMiniToolExecution(f.body, f.viewerId, start, NO_HOLD)).rejects.toBeInstanceOf(ForbiddenError);
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toBeNull();
  });

  it("keeps persisted user identity and source binding independent from client media claims", async () => {
    const f = await seed(); const start = startRecorder();
    f.body.draft.source.mediaInfo = { width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" };
    await acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD);
    const accepted = start.mock.calls[0]?.[0];
    expect(accepted?.binding).toEqual({ assetId: f.sourceAssetId, contentHash: f.sourceHash, canonicalURL: f.body.draft.source.canonicalURL,
      kind: "video", mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } });
    expect(accepted?.credits).toBe(0);
    expect(accepted?.draft.source.mediaInfo).toEqual({ width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" });
  });
});

// inner#1968 design 3.9: the running-task gate starts a run (pending -> running) and a queued cancel ends it
// (pending -> cancelled) on the task row alone; the run's public record follows the task's status.
describe("the planned run's record follows its task through the running-task gate (inner#1968 design 3.9)", () => {
  it.each(["running", "cancelled"] as const)("M2-06 a run the gate moves to %s reads with that status", async (status) => {
    const f = await seed(); await acceptMiniToolExecution(f.body, f.userId, startRecorder(), NO_HOLD);
    await pg`UPDATE tasks SET status=${status},started_at=CASE WHEN ${status}='running' THEN clock_timestamp() END WHERE id=${f.body.run_id}`;
    expect((await miniToolExecutionService.getMiniToolExecution(f.body.project_id, f.body.run_id, f.userId)).status).toBe(status);
  });

  it("M2-07 the first pickup of a run the gate started runs it", async () => {
    const f = await seed(); await acceptMiniToolExecution(f.body, f.userId, startRecorder(), NO_HOLD);
    await pg`UPDATE tasks SET status='running',started_at=clock_timestamp() WHERE id=${f.body.run_id}`;
    expect((await miniToolExecutionService.startMiniToolExecution(f.body.run_id, "queue-job")).record.status).toBe("running");
  });
});

describe("planned admission on the selected version (frames-split §7.11)", () => {
  // frames-split §7.11: the press is admitted only on the selected version it names.
  it.each(["ref toolInputId", "ref planSha256", "nothing selected"])("refuses when %s, before claiming the run", async (bad) => {
    const f = await seed(); const start = startRecorder();
    const snapshot = outside.snapshots.get(f.sourceKey) as { presentation: unknown };
    if (bad === "ref toolInputId") f.body.presentation_ref.source.toolInputId = "b".repeat(64);
    else if (bad === "ref planSha256") f.body.presentation_ref.source.planSha256 = "b".repeat(64);
    else snapshot.presentation = null;
    await expect(acceptMiniToolExecution(f.body, f.userId, start, NO_HOLD)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled(); expect(await readTask(f.body.run_id)).toBeNull();
  });
});
