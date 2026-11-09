// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The immutable web-animation source version and the call-level usage identity (inner#1711 design §3.4, §3.5).
 *
 * `webAnimationSourceRepo` (domain) records at most one source per execution: the worker may settle the same terminal
 * report more than once, and every attempt must land on the one row the first wrote. `insertUsageRecord` writes a
 * call's `cost_identity`, so a second settlement of the same call adds no row. Real database: the unique constraints
 * are the thing under test.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { initCore, loadLocales, timelineExecutionRepo } from "@breatic/core";
import { createUsageRecorder, webAnimationSourceRepo } from "@breatic/domain";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "timeline-web-sources-test-driver" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Accept one execution in a fresh Project.
 * @returns The execution, its Project and actor.
 * @throws {Error} When a fixture write fails.
 */
async function seedExecution(): Promise<{ executionId: string; projectId: string; userId: string }> {
  const userId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified) VALUES (${userId}, ${`web-src-${userId}@example.test`}, true)`;
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${userId}, ${studioId}, 'personal', 'Web source studio')`;
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug) VALUES (${projectId}, ${studioId}, ${userId}, 'Web source test', ${`ws-${projectId}`})`;
  const row = await timelineExecutionRepo.insert({
    projectId,
    spaceId: randomUUID(),
    actorUserId: userId,
    kind: "web_animation_create",
    engine: "deepseek",
    actionId: randomUUID(),
    input: { prompt: "A red square", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } },
    inputHash: "sha256:input",
    deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
  });
  if (row === null) throw new Error("Fixture execution conflicted");
  return { executionId: row.id, projectId, userId };
}

/**
 * A source version as the worker records it from a validated Manifest and the Worker's report.
 * @param executionId - The execution that produced it.
 * @param projectId - Its Project, which names the object keys.
 * @param variant - A byte that tells two different reports apart.
 * @returns The insert input.
 */
function sourceFor(executionId: string, projectId: string, variant = "a"): webAnimationSourceRepo.NewWebAnimationSource {
  return {
    executionId,
    packageKey: `web-animation/${projectId}/${executionId}/index.html`,
    manifestKey: `web-animation/${projectId}/${executionId}/manifest.json`,
    packageSha256: variant.repeat(64),
    packageBytes: 612_345,
    manifestSha256: "b".repeat(64),
    runtimeVersion: "@hyperframes/core@0.8.186",
    fontSetVersion: 1,
    width: 1920,
    height: 1080,
    fpsNum: 24,
    fpsDen: 1,
    durationFrames: 96,
  };
}

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe("timeline_web_animation_sources", () => {
  it("stores every column of a source version and reads it back by id", async () => {
    const { executionId, projectId } = await seedExecution();
    const inserted = await webAnimationSourceRepo.insert(sourceFor(executionId, projectId));
    expect(inserted).toEqual({ id: expect.any(String), ...sourceFor(executionId, projectId), createdAt: expect.stringMatching(ISO_MICROS) });
    expect(await webAnimationSourceRepo.findById(inserted.id)).toEqual(inserted);
    const [stored] = await sql<{ package_bytes: string; fps_num: number; fps_den: number; duration_frames: number; deleted_at: Date | null }[]>`
      SELECT package_bytes::text AS package_bytes, fps_num, fps_den, duration_frames, deleted_at
      FROM timeline_web_animation_sources WHERE id = ${inserted.id}
    `;
    expect(stored).toEqual({ package_bytes: "612345", fps_num: 24, fps_den: 1, duration_frames: 96, deleted_at: null });
  });

  it("keeps the first source when an execution's report is settled again, and stores one row", async () => {
    const { executionId, projectId } = await seedExecution();
    const first = await webAnimationSourceRepo.insert(sourceFor(executionId, projectId, "a"));
    const second = await webAnimationSourceRepo.insert(sourceFor(executionId, projectId, "c"));
    expect(second).toEqual(first);
    const rows = await sql<{ id: string; package_sha256: string }[]>`
      SELECT id, package_sha256 FROM timeline_web_animation_sources WHERE execution_id = ${executionId}
    `;
    expect(rows).toEqual([{ id: first.id, package_sha256: "a".repeat(64) }]);
  });

  it("refuses a second row for one execution at the database", async () => {
    const { executionId, projectId } = await seedExecution();
    await webAnimationSourceRepo.insert(sourceFor(executionId, projectId));
    const insertAgain = (): Promise<unknown> => sql`
      INSERT INTO timeline_web_animation_sources
        (execution_id, package_key, manifest_key, package_sha256, package_bytes, manifest_sha256, runtime_version,
         font_set_version, width, height, fps_num, fps_den, duration_frames)
      VALUES (${executionId}, 'web-animation/x/index.html', 'web-animation/x/manifest.json', ${"d".repeat(64)}, 1,
              ${"e".repeat(64)}, '@hyperframes/core@0.8.186', 1, 1080, 1920, 24, 1, 96)
    `;
    await expect(insertAgain()).rejects.toMatchObject({ code: "23505" });
  });

  it("reads nothing for an unknown id or a soft-deleted row", async () => {
    const { executionId, projectId } = await seedExecution();
    const inserted = await webAnimationSourceRepo.insert(sourceFor(executionId, projectId));
    expect(await webAnimationSourceRepo.findById(randomUUID())).toBeUndefined();
    await sql`UPDATE timeline_web_animation_sources SET deleted_at = now() WHERE id = ${inserted.id}`;
    expect(await webAnimationSourceRepo.findById(inserted.id)).toBeUndefined();
  });
});

describe("agent_usage_records.cost_identity", () => {
  it("is written from the call, and a second settlement of the same call adds no row", async () => {
    const { executionId, projectId, userId } = await seedExecution();
    const operationKey = `timeline:${executionId}`;
    const settleOnce = async (): Promise<number> => {
      const recorder = createUsageRecorder({
        operationKey,
        feature: "timeline_web_animation",
        actorUserId: userId,
        projectId,
        multiplier: 1,
        onMissingCost: () => {},
      });
      recorder.recordModelCall({
        source: "model",
        model: "deepseek/deepseek-v4.1-flash-1017",
        provider: "openrouter",
        usage: {
          inputTokens: 1_200,
          inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 200 },
          outputTokens: 300,
          outputTokenDetails: { reasoningTokens: 100 },
        },
        providerMetadata: { openrouter: { usage: { cost: 0.0125 } } },
        generationId: "gen-1",
        costIdentity: `timeline:${executionId}:1`,
      });
      return recorder.settle();
    };
    await settleOnce();
    await settleOnce();
    const rows = await sql<{ cost_identity: string | null; cost_usd: string; cost_source: string; credits: string; feature: string }[]>`
      SELECT cost_identity, cost_usd::float8::text AS cost_usd, cost_source, credits::float8::text AS credits, feature
      FROM agent_usage_records WHERE operation_key = ${operationKey}
    `;
    expect(rows).toEqual([
      { cost_identity: `timeline:${executionId}:1`, cost_usd: "0.0125", cost_source: "provider", credits: "1.25", feature: "timeline_web_animation" },
    ]);
  });
});
