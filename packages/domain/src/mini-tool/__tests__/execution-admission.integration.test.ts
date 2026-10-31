// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import type { MiniToolPlannedRequest } from "@breatic/shared/mini-tools";
import { acceptMiniToolExecution, type AcceptedMiniToolExecution } from "@domain/index.js";
import { resetModelCatalog } from "@domain/model-catalog/model-catalog.js";
import { seedStudioFixture } from "../../../../server/src/__tests__/integration/studio-credit-fixtures.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

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
    video: "https://assets.example.test/video/source.mp4",
    background_color: "Transparent",
    output_container_and_codec: "webm_vp9",
    preserve_audio: true,
  },
  credits: 30,
  requestFingerprint: "f5ed98e04016b9001c24d0d525eccd576898e5c454dc529cc0715712b1ec135e",
  planFingerprint: "e35fde7e372c275d23f9c739425de94e9df3fbca440d7576dc0476553aea2f3b",
};

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
beforeEach(() => { configure(); });
afterAll(async () => { await pg.end(); initCore(process.env); resetModelCatalog(); });

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
  return { body, userId, otherEditorId, viewerId, sourceStudioId: source.studioId, targetStudioId: target.studioId, sourceAssetId, sourceKey, sourceHash };
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
      expect(task?.params).toEqual({ miniToolExecution: GOLDEN_PLAN });
      return "pending";
    });
    expect(await acceptMiniToolExecution(f.body, f.userId, start)).toEqual({ taskId: GOLDEN_BODY.run_id, status: "pending" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([GOLDEN_PLAN]);
    const task = await readTask(f.body.run_id);
    expect(task).toMatchObject({ id: f.body.run_id, user_id: f.userId, project_id: f.body.project_id, space_id: f.body.space_id,
      task_type: "video", source: "mini_tool", mode: "append", status: "pending", model: "bria-fibo-video-background-remover", params: { miniToolExecution: GOLDEN_PLAN } });
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
    expect(accepted?.credits).toBe(30);
    expect(accepted?.draft.source.mediaInfo).toEqual({ width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" });
  });
});
