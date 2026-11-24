// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { createPgClient } from "@breatic/core";
import type { AcceptedMiniToolExecution } from "@domain/mini-tool/execution-admission.service.js";
import type { MiniToolExecutionRecord, MiniToolExecutionRegistered } from "@breatic/shared/mini-tools";
import { hashMiniToolValue } from "@breatic/shared/mini-tools";
import { seedStudioFixture } from "../../../../server/src/__tests__/integration/studio-credit-fixtures.js";
import { presentedSource } from "../../../../server/src/__tests__/integration/presentation-fixtures.js";

const OUTPUT_HASH = "147d7b46f5062b1cc7231edff71bed11071dd088c5b3434432f24e5d41037a07";
const SOURCE_URL = "https://assets.example.test/video/source.mp4";
// The frozen split plan names its tool input and the selected version on the frame grid (frames-split §7.11); the
// version is the source's (presentation-fixtures.ts), built per seed.
const SOURCE_KEY = "video/source.mp4";
const CONTAINER = {
  containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
  prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
  limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
  startSeconds: 3, encode: { crf: 18, preset: "medium" }, chunkRetries: 3,
};

const GOLDEN = {
  schemaVersion: 1, tool: "video.split", taskId: "50000000-0000-4000-8000-000000000001", projectId: "10000000-0000-4000-8000-000000000001", spaceId: "20000000-0000-4000-8000-000000000001",
  targetNodeIds: ["40000000-0000-4000-8000-000000000001"],
  binding: { assetId: "80000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), canonicalURL: SOURCE_URL, kind: "video", mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } },
  sourceKey: SOURCE_KEY,
  draft: { version: 1, draftId: "60000000-0000-4000-8000-000000000001", revision: "70000000-0000-4000-8000-000000000001", source: { nodeId: "30000000-0000-4000-8000-000000000001", canonicalURL: SOURCE_URL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } }, inputs: [], params: { cuts: [] } },
  analysisRefs: [], outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "segment", range: { start: 0, end: 96 } } }],
  model: "video.split", layout: { batches: [[0]], encodes: [] }, stageJobs: [{ stage: "encode", jobs: 1 }], outputSeconds: [20],
  container: CONTAINER, credits: 35, chargeTo: "user",
  requestFingerprint: "329f16d3751e013600fc7b50f226a6629d74425d96ef234c6e4d1f016a89e725", planFingerprint: "8f36d34692aa41e3bc7f64f2aef5eefbb1f0f8a0c0fef3119aefc6af7bc22925",
} as unknown as AcceptedMiniToolExecution;

export type FixturePg = ReturnType<typeof createPgClient>;
export interface ExecutionFixture {
  taskId: string; userId: string; viewerId: string; projectId: string; studioId: string;
  plan: AcceptedMiniToolExecution; record: MiniToolExecutionRecord; registered: MiniToolExecutionRegistered;
}
/** Seed original F, a real parent, membership and registered canonical rows, with no network or media processing.
 * @throws {Error} On a fixture SQL failure.
 */
export async function seedExecution(pg: FixturePg, status: MiniToolExecutionRecord["status"] = "pending", initialized = true): Promise<ExecutionFixture> {
  const target = await seedStudioFixture(pg, "exec-life");
  const presented = await presentedSource("a".repeat(64), SOURCE_KEY, (key) => `https://assets.example.test/${key}`);
  const plan = structuredClone(GOLDEN);
  Object.assign(plan, { presentationRef: presented.presentationRef, presentations: { source: presented.bundle }, versionIds: { source: presented.versionId } });
  plan.taskId = randomUUID(); plan.projectId = target.projectId; plan.spaceId = randomUUID();
  plan.targetNodeIds = [randomUUID()]; plan.outputs[0]!.nodeId = plan.targetNodeIds[0]!; plan.binding.assetId = randomUUID();
  plan.draft.draftId = randomUUID(); plan.draft.revision = randomUUID(); plan.draft.source.nodeId = randomUUID();
  const { requestFingerprint: _request, planFingerprint: _hash, ...projection } = plan; plan.planFingerprint = await hashMiniToolValue(projection);
  const viewerId = randomUUID();
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${viewerId},${`life-${viewerId}@example.test`},true)`;
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${plan.projectId},${target.userId},'owner'),(${plan.projectId},${viewerId},'viewer')`;
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${plan.binding.assetId},${target.studioId},${plan.binding.contentHash},${`video/source/${plan.binding.assetId}.mp4`},${plan.binding.canonicalURL},4096,'video/mp4','video','upload',${target.userId},960,540,5.055)`;
  const assetId = randomUUID(); const canonicalURL = `https://assets.example.test/video/winner/${assetId}.webm`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${plan.taskId},${target.userId},${plan.projectId},${plan.spaceId},'video','append','mini_tool',${status},${plan.model},${pg.json({ miniToolExecution: { ...plan } })},${pg.json({ preserved: { token: "original" } })})`;
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,generation_task_id,width,height,duration_seconds)
    VALUES (${assetId},${target.studioId},${OUTPUT_HASH},${`video/winner/${assetId}.webm`},${canonicalURL},1588436,'video/webm','video','ai',${target.userId},${plan.taskId},960,540,5.013)`;
  const record: MiniToolExecutionRecord = { schemaVersion: 1, runId: plan.taskId, status, planFingerprint: plan.planFingerprint, resultVersion: 0,
    sourceBindings: [structuredClone(plan.binding)], outputs: plan.outputs.map((o) => ({ ...o, result: null })), usage: [], billingState: "idle", error: null };
  if (initialized) await pg`UPDATE tasks SET result=result || ${pg.json(z.json().parse({ miniToolExecution: record }))} WHERE id=${plan.taskId}`;
  const registered: MiniToolExecutionRegistered = { status: "registered", assetId, canonicalURL, kind: "video", mimeType: "video/webm", size: 1588436, contentHash: OUTPUT_HASH, width: 960, height: 540, duration: 5.013, cover: null };
  return { taskId: plan.taskId, userId: target.userId, viewerId, projectId: plan.projectId, studioId: target.studioId, plan, record, registered };
}
/** Observe the real parent independently of production mappers.
 * @throws {Error} If the fixture parent disappeared.
 */
export async function executionSnapshot(pg: FixturePg, f: ExecutionFixture): Promise<{ status: string; params: unknown; result: Record<string, unknown>; started_at: string | null; completed_at: string | null; billed_at: string | null; billed_credits: string | null; error_message: string | null }> {
  const [row] = await pg<{ status: string; params: unknown; result: Record<string, unknown>; started_at: string | null; completed_at: string | null; billed_at: string | null; billed_credits: string | null; error_message: string | null }[]>`
    SELECT status,params,result,started_at::text,completed_at::text,billed_at::text,billed_credits::text,error_message FROM tasks WHERE id=${f.taskId}`;
  if (!row) throw new Error("Fixture parent disappeared"); return row;
}
/** Publish an independent fixture namespace to isolate a downstream owner from start's RED stub.
 * @throws {Error} On a fixture SQL failure.
 */
export async function storeExecutionFixture(pg: FixturePg, f: ExecutionFixture, record: MiniToolExecutionRecord): Promise<void> {
  await pg`UPDATE tasks SET result=result || ${pg.json(z.json().parse({ miniToolExecution: record }))} WHERE id=${f.taskId}`;
}
