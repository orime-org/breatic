// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import * as Y from "yjs";
import { createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import type { ProjectMediaBackfillRecord, ProjectMediaBackfillRow, ProjectMediaBackfillSummary } from "@breatic/core";
import { CANVAS_NODES_KEY, canvasSpaceDocName } from "@breatic/shared";

interface Scope { ownerId: string; studioId: string; projectId: string }
interface Asset { id: string; fileUrl: string }
interface Reference { id: string; asset_id: string; display_name: string | null; created_at: string; updated_at: string }
interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
interface ProvenanceFixture {
  scope: Scope;
  first: Asset;
  second: Asset;
  grantId: string;
  historyIds: string[];
  activityIds: string[];
  documentName: string;
}

const ROOT = resolve(import.meta.dirname, "../../../..");
const COMMAND = resolve(ROOT, "scripts/backfill-project-media.ts");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const TSCONFIG = resolve(ROOT, "packages/collab/tsconfig.json");
const SOURCES = ["consumed_grants", "node_history", "media_activities", "generation_assets", "space_documents"];
let sql: ReturnType<typeof createPgClient>;
let yjsSql: ReturnType<typeof createPgClient>;
let directory = "";
const children = new Set<ChildProcess>();
const owned = {
  users: [] as string[], studios: [] as string[], projects: [] as string[], assets: [] as string[],
  grants: [] as string[], history: [] as string[], activities: [] as string[], tasks: [] as string[], documents: [] as string[],
};

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-backfill-command-business-test", max: 4, prepare: false });
  yjsSql = createPgClient(inject("YJS_DATABASE_URL"), { name: "timeline-backfill-command-yjs-test", max: 4, prepare: false });
});

beforeEach(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "timeline-project-media-command-"));
});

afterEach(async () => {
  try {
    for (const child of children) stopChild(child);
    if (owned.documents.length > 0) await yjsSql`UPDATE yjs_documents SET deleted_at = now() WHERE name = ANY(${owned.documents}::text[])`;
    if (owned.grants.length > 0) await sql`DELETE FROM upload_grants WHERE id = ANY(${owned.grants}::uuid[])`;
    if (owned.history.length > 0) await sql`UPDATE node_history SET deleted_at = now() WHERE id = ANY(${owned.history}::uuid[])`;
    if (owned.activities.length > 0) await sql`UPDATE project_activities SET deleted_at = now() WHERE id = ANY(${owned.activities}::uuid[])`;
    if (owned.projects.length > 0) {
      await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    }
    if (owned.assets.length > 0) await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ANY(${owned.assets}::uuid[])`;
    if (owned.tasks.length > 0) await sql`UPDATE tasks SET deleted_at = now() WHERE id = ANY(${owned.tasks}::uuid[])`;
    if (owned.studios.length > 0) await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  } finally {
    for (const values of Object.values(owned)) values.length = 0;
    children.clear();
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await Promise.all([sql.end({ timeout: 1 }), yjsSql.end({ timeout: 1 })]);
});

/**
 * Stop only the process group created by this test's CLI invocation.
 * @param child - The recorded child process.
 * @throws {Error} When process termination fails for a reason other than exit.
 */
function stopChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

/**
 * Carry injected testcontainer connections into a real maintenance process.
 * @returns Application configuration with explicit isolated database URLs.
 * @throws {Error} When the suite supplies a non-local database target.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const database = inject("DATABASE_URL");
  const yjsDatabase = inject("YJS_DATABASE_URL");
  for (const value of [database, yjsDatabase]) {
    expect(["localhost", "127.0.0.1", "[::1]", "::1"]).toContain(new URL(value).hostname);
  }
  return {
    ...process.env,
    DATABASE_URL: database, YJS_DATABASE_URL: yjsDatabase,
    REDIS_URL: inject("REDIS_URL"), REDIS_QUEUE_URL: inject("REDIS_QUEUE_URL"),
    REDIS_STREAM_URL: inject("REDIS_STREAM_URL"), REDIS_COLLAB_URL: inject("REDIS_COLLAB_URL"),
  };
}

/**
 * Run the installed tsx entry against the actual maintenance script.
 * @param args - Explicit operator arguments.
 * @param minimal - Run help from the private temporary directory with minimal configuration.
 * @returns The real process result and diagnostic streams.
 * @throws {Error} When the child cannot start.
 */
async function command(args: readonly string[], minimal = false): Promise<CommandResult> {
  const child = spawn(process.execPath, [TSX, "--tsconfig", TSCONFIG, COMMAND, ...args], {
    cwd: minimal ? directory : ROOT,
    env: minimal ? { PATH: process.env.PATH, TMPDIR: directory } : childEnvironment(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return new Promise<CommandResult>((done, fail) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
    }, 45_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => { stdout += data; });
    child.stderr?.on("data", (data: string) => { stderr += data; });
    child.once("error", (error) => {
      clearTimeout(timer);
      children.delete(child);
      fail(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      done({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Check a command using its captured diagnostics as assertion context.
 * @param result - The real process result.
 * @throws {Error} When the command failed or retained a live process.
 */
function expectSuccess(result: CommandResult): void {
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  expect(result.timedOut, diagnostic).toBe(false);
  expect(result.signal, diagnostic).toBe(null);
  expect(result.code, diagnostic).toBe(0);
}

/**
 * Check an explicit refusal after the command has terminated normally.
 * @param result - The real process result.
 * @throws {Error} When the process succeeded or had to be killed.
 */
function expectFailure(result: CommandResult): void {
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  expect(result.timedOut, diagnostic).toBe(false);
  expect(result.signal, diagnostic).toBe(null);
  expect(result.code, diagnostic).not.toBe(0);
  expect(result.code, diagnostic).not.toBe(null);
}

/**
 * Read the durable JSONL using the declared maintenance record contract.
 * @param path - This case's private output file.
 * @returns Individually parsed records in emitted order.
 * @throws {Error} When the report is absent, truncated or malformed.
 */
async function records(path: string): Promise<ProjectMediaBackfillRecord[]> {
  const content = await readFile(path, "utf8");
  if (content === "") return [];
  expect(content.endsWith("\n")).toBe(true);
  return content.slice(0, -1).split("\n").map((line) => {
    const value = JSON.parse(line) as ProjectMediaBackfillRecord;
    expect(["candidate", "source_complete"]).toContain(value.type);
    expect(["initial", "verification"]).toContain(value.pass);
    expect(SOURCES).toContain(value.source);
    return value;
  });
}

/**
 * Select candidate records using the report's discriminant.
 * @param values - The actual emitted records.
 * @returns Candidate rows with their original source identities.
 * @throws {never} Never.
 */
function candidates(values: readonly ProjectMediaBackfillRecord[]): ProjectMediaBackfillRow[] {
  return values.filter((value): value is ProjectMediaBackfillRow => value.type === "candidate");
}

/**
 * Select completed-source summaries using the report's discriminant.
 * @param values - The actual emitted records.
 * @returns Totals for each emitted source and pass.
 * @throws {never} Never.
 */
function summaries(values: readonly ProjectMediaBackfillRecord[]): ProjectMediaBackfillSummary[] {
  return values.filter((value): value is ProjectMediaBackfillSummary => value.type === "source_complete");
}

/**
 * Compare each summary with the records actually emitted for its source/pass.
 * @param values - This invocation's complete JSONL.
 * @throws {Error} When a counter describes a different population.
 */
function expectSummaryCounts(values: readonly ProjectMediaBackfillRecord[]): void {
  for (const summary of summaries(values)) {
    const rows = candidates(values).filter((row) => row.pass === summary.pass && row.source === summary.source);
    expect(summary.candidates).toBe(rows.length);
    expect(summary.resolvedAssets).toBe(rows.reduce((count, row) => count + new Set(row.resolved.map((item) => item.assetId)).size, 0));
    expect(summary.existingAssets).toBe(rows.reduce((count, row) => count + row.existingAssetIds.length, 0));
    expect(summary.insertedAssets).toBe(rows.reduce((count, row) => count + row.insertedAssetIds.length, 0));
    expect(summary.unavailableReferences).toBe(rows.reduce((count, row) => count + row.unavailable.length, 0));
    expect(summary.reasons).toEqual(rows.reduce<Partial<Record<NonNullable<ProjectMediaBackfillRow["reason"]>, number>>>((counts, row) => {
      if (row.reason !== null) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
      return counts;
    }, {}));
  }
}

/**
 * Seed a live Project with no historical asset associations.
 * @returns Its owning identity.
 * @throws {Error} When the fixture database write fails.
 */
async function seedScope(): Promise<Scope> {
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified)
    VALUES (${ownerId}, ${`timeline-command-${ownerId}@example.com`}, true)`;
  owned.users.push(ownerId);
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Timeline command test')`;
  owned.studios.push(studioId);
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${projectId}, ${studioId}, ${ownerId}, 'Timeline command test', ${`command-${projectId}`})`;
  owned.projects.push(projectId);
  return { ownerId, studioId, projectId };
}

/**
 * Register an existing canonical asset without creating a Project reference.
 * @param scope - The actual owning scope.
 * @param taskId - The generation provenance retained by the first ledger row.
 * @returns Its canonical asset identity and address.
 * @throws {Error} When fixture creation fails.
 */
async function seedAsset(scope: Scope, taskId: string | null): Promise<Asset> {
  const id = randomUUID();
  const key = `backfill-command/${id}.mp4`;
  const adapter = await getStorageAdapter();
  const fileUrl = adapter.publicUrl(key);
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id,
     generation_task_id, width, height, duration_seconds)
    VALUES (${id}, ${scope.studioId}, ${createHash("sha256").update(id).digest("hex")}, ${key}, ${fileUrl},
      8192, 'video/mp4', 'video', 'upload', ${scope.ownerId}, ${taskId}, 1280, 720, 2)`;
  owned.assets.push(id);
  return { id, fileUrl };
}

/**
 * Seed an originally consumed grant using its fixed registered identity.
 * @param scope - The Project and Studio stored with the credential.
 * @param media - The registered ledger identity.
 * @param id - Its immutable source cursor.
 * @throws {Error} When the fixture write fails.
 */
async function seedGrant(scope: Scope, media: Asset, id: string): Promise<void> {
  await sql`INSERT INTO upload_grants
    (id, user_id, studio_id, storage_key, declared_size, expires_at, consumed_at, project_id, asset_id, filename)
    VALUES (${id}, ${scope.ownerId}, ${scope.studioId}, ${`command-grant/${id}`}, 8192,
      '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', ${scope.projectId}, ${media.id}, 'Historical A.mp4')`;
  owned.grants.push(id);
}

/**
 * Seed all five provenance sources, with one asset appearing only in Yjs.
 * @returns Source identities for real command assertions.
 * @throws {Error} When fixture setup fails.
 */
async function seedProvenance(): Promise<ProvenanceFixture> {
  const scope = await seedScope();
  const taskId = randomUUID();
  await sql`INSERT INTO tasks (id, user_id, project_id, space_id, task_type, mode, status)
    VALUES (${taskId}, ${scope.ownerId}, ${scope.projectId}, ${randomUUID()}, 'video', 'append', 'completed')`;
  owned.tasks.push(taskId);
  const first = await seedAsset(scope, taskId);
  const second = await seedAsset(scope, null);
  const grantId = randomUUID();
  await seedGrant(scope, first, grantId);
  const historyIds: string[] = [];
  const activityPrefix = randomUUID().slice(0, 24);
  const activityIds = [`${activityPrefix}000000000001`, `${activityPrefix}000000000002`];
  for (const [index, activityId] of activityIds.entries()) {
    const historyId = randomUUID();
    await sql`INSERT INTO node_history (id, project_id, node_id, user_id, entry_type, status, content, mime_type)
      VALUES (${historyId}, ${scope.projectId}, ${randomUUID()}, ${scope.ownerId}, 'upload', 'success', ${first.fileUrl}, 'video/mp4')`;
    owned.history.push(historyId);
    historyIds.push(historyId);
    const type = index === 0 ? "asset:uploaded" : "generation:succeeded";
    const payload = { fileUrl: first.fileUrl, kind: "video", ...(index === 1 ? { source: "task" } : {}) };
    await sql`INSERT INTO project_activities (id, project_id, type, payload)
      VALUES (${activityId}, ${scope.projectId}, ${type}, ${sql.json(payload)})`;
    owned.activities.push(activityId);
  }
  const documentName = canvasSpaceDocName(scope.projectId, randomUUID());
  const document = new Y.Doc();
  try {
    const node = new Y.Map<unknown>();
    document.getMap(CANVAS_NODES_KEY).set("historical-video", node);
    node.set("id", "historical-video");
    node.set("type", "video");
    const data = new Y.Map<unknown>();
    node.set("data", data);
    data.set("content", second.fileUrl);
    const bytes = Buffer.from(Y.encodeStateAsUpdate(document));
    await yjsSql`INSERT INTO yjs_documents (name, data) VALUES (${documentName}, ${bytes})`;
    owned.documents.push(documentName);
  } finally {
    document.destroy();
  }
  return { scope, first, second, grantId, historyIds, activityIds, documentName };
}

/**
 * Read only this fixture's durable live relationships.
 * @param projectId - The Project under test.
 * @returns The stable relation facts.
 * @throws {Error} When the inspection query fails.
 */
async function references(projectId: string): Promise<Reference[]> {
  return sql<Reference[]>`SELECT id, asset_id, display_name, created_at::text AS created_at, updated_at::text AS updated_at
    FROM project_asset_refs WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY asset_id`;
}

/**
 * Capture the exact persisted Space bytes and temporal fields.
 * @param name - The fixture content row.
 * @returns Its original storage facts.
 * @throws {Error} When the database read fails.
 */
async function snapshot(name: string): Promise<{ bytes: string; created: string; updated: string | null }[]> {
  return yjsSql`SELECT encode(data, 'hex') AS bytes, created_at::text AS created, updated_at::text AS updated
    FROM yjs_documents WHERE name = ${name}`;
}

/**
 * Fail canonical acceptance at the first owned grant with a real SQL error.
 * @param projectId - The isolated Project.
 * @param run - The actual CLI invocation.
 * @throws {Error} When fixture setup, the operation or cleanup fails.
 */
async function withAssociationFailure(projectId: string, run: () => Promise<void>): Promise<void> {
  const name = `timeline_command_fault_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN
    IF NEW.project_id = '${projectId}'::uuid THEN RAISE EXCEPTION 'injected CLI media acceptance failure'; END IF;
    RETURN NEW; END $$ LANGUAGE plpgsql`);
  try {
    await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON project_asset_refs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { await run(); } finally { await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON project_asset_refs`); }
  } finally {
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

describe("Project media backfill maintenance command", () => {
  it("shows help from a non-repository cwd with minimal child configuration", async () => {
    const result = await command(["--help"], true);
    expectSuccess(result);
    expect(result.stdout).toMatch(/usage/i);
    expect(result.stdout).toContain("--output");
    expect(result.stdout).toContain("--apply");
    expect(result.stdout).toContain("--resume-source");
  });

  it("reports five real sources without writes and applies exactly the two canonical fixture assets", async () => {
    const fixture = await seedProvenance();
    const originalBytes = await snapshot(fixture.documentName);
    const reportPath = resolve(directory, "report.jsonl");
    expectSuccess(await command(["--output", reportPath]));
    const reported = await records(reportPath);
    expect(await references(fixture.scope.projectId)).toEqual([]);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect(summaries(reported).map((row) => `${row.pass}:${row.source}`)).toEqual([
      ...SOURCES.map((source) => `initial:${source}`), ...SOURCES.map((source) => `verification:${source}`),
    ]);
    const ownReport = candidates(reported).filter((row) => row.projectId === fixture.scope.projectId);
    expect([...new Set(ownReport.map((row) => row.source))].sort()).toEqual([...SOURCES].sort());
    expect([...new Set(ownReport.flatMap((row) => row.resolved.map((entry) => entry.assetId)))].sort()).toEqual([fixture.first.id, fixture.second.id].sort());
    expect(candidates(reported).every((row) => row.mode === "report" && row.insertedAssetIds.length === 0)).toBe(true);
    expect(summaries(reported).every((row) => row.mode === "report")).toBe(true);
    expectSummaryCounts(reported);
    const ownHistory = ownReport.filter((row) => row.pass === "initial" && row.source === "node_history");
    expect(ownHistory.map((row) => row.rowId).sort()).toEqual([...fixture.historyIds].sort());
    expect(ownHistory.reduce((sum, row) => sum + new Set(row.resolved.map((entry) => entry.assetId)).size, 0)).toBe(2);

    const applyPath = resolve(directory, "apply.jsonl");
    expectSuccess(await command(["--apply", "--output", applyPath]));
    const applied = await records(applyPath);
    const ownApply = candidates(applied).filter((row) => row.projectId === fixture.scope.projectId);
    expect(ownApply.flatMap((row) => row.insertedAssetIds).sort()).toEqual([fixture.first.id, fixture.second.id].sort());
    const persisted = await references(fixture.scope.projectId);
    expect(persisted.map((row) => row.asset_id)).toEqual([fixture.first.id, fixture.second.id].sort());
    expect(persisted.find((row) => row.asset_id === fixture.first.id)?.display_name).toBe("Historical A.mp4");
    expectSummaryCounts(applied);

    const repeatPath = resolve(directory, "repeat.jsonl");
    expectSuccess(await command(["--apply", "--output", repeatPath]));
    const repeated = await records(repeatPath);
    expect(candidates(repeated).flatMap((row) => row.insertedAssetIds)).toEqual([]);
    expect(await references(fixture.scope.projectId)).toEqual(persisted);
    expect(await snapshot(fixture.documentName)).toEqual(originalBytes);
    expectSummaryCounts(repeated);
  });

  it("resumes the selected verification source after the supplied activity cursor", async () => {
    const fixture = await seedProvenance();
    const output = resolve(directory, "resume.jsonl");
    expectSuccess(await command([
      "--output", output, "--resume-pass", "verification", "--resume-source", "media_activities", "--resume-cursor", fixture.activityIds[0]!,
    ]));
    const values = await records(output);
    expect(summaries(values).map((row) => `${row.pass}:${row.source}`)).toEqual([
      "verification:media_activities", "verification:generation_assets", "verification:space_documents",
    ]);
    const own = candidates(values).filter((row) => row.projectId === fixture.scope.projectId);
    expect(own.filter((row) => row.source === "media_activities").map((row) => row.rowId)).toEqual([fixture.activityIds[1]]);
    expect(own.every((row) => row.pass === "verification")).toBe(true);
    expect(own.some((row) => row.source === "consumed_grants" || row.source === "node_history")).toBe(false);
    expect(await references(fixture.scope.projectId)).toEqual([]);
    expectSummaryCounts(values);
  });

  it("refuses an existing output file while retaining its contents and all fixture relationships", async () => {
    const fixture = await seedProvenance();
    const output = resolve(directory, "existing.jsonl");
    const content = "existing private report bytes\n";
    await writeFile(output, content, { mode: 0o640 });
    const originalMode = (await stat(output)).mode;
    const result = await command(["--apply", "--output", output]);
    expectFailure(result);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/exist/i);
    expect(await readFile(output, "utf8")).toBe(content);
    expect((await stat(output)).mode).toBe(originalMode);
    expect(await references(fixture.scope.projectId)).toEqual([]);
  });

  it.each(["unknown_flag", "invalid_extension", "partial_resume"] as const)("rejects %s before creating output", async (condition) => {
    const fixture = await seedProvenance();
    const output = resolve(directory, condition === "invalid_extension" ? "invalid.txt" : "invalid.jsonl");
    const args = ["--apply", "--output", output];
    if (condition === "unknown_flag") args.push("--unknown-option");
    if (condition === "partial_resume") args.push("--resume-pass", "initial");
    const result = await command(args);
    expectFailure(result);
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    if (condition === "unknown_flag") expect(diagnostic).toContain("--unknown-option");
    if (condition === "invalid_extension") expect(diagnostic).toMatch(/--output|\.jsonl/i);
    if (condition === "partial_resume") expect(diagnostic).toMatch(/resume/i);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await references(fixture.scope.projectId)).toEqual([]);
  });

  it("refuses an unknown resume source before accepting a canonical asset", async () => {
    const fixture = await seedProvenance();
    const output = resolve(directory, "unknown-source.jsonl");
    const result = await command([
      "--apply", "--output", output, "--resume-pass", "initial", "--resume-source", "unknown_source", "--resume-cursor", fixture.grantId,
    ]);
    expectFailure(result);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/resume/i);
    expect(await references(fixture.scope.projectId)).toEqual([]);
  });

  it("stops at a failed canonical SQL write without emitting a success checkpoint beyond it", async () => {
    const scope = await seedScope();
    const first = await seedAsset(scope, null);
    const second = await seedAsset(scope, null);
    const prefix = randomUUID().slice(0, 24);
    const firstGrant = `${prefix}000000000001`;
    const secondGrant = `${prefix}000000000002`;
    await seedGrant(scope, first, firstGrant);
    await seedGrant(scope, second, secondGrant);
    const output = resolve(directory, "failure.jsonl");
    await withAssociationFailure(scope.projectId, async () => {
      const result = await command(["--apply", "--output", output]);
      expectFailure(result);
      expect(`${result.stdout}\n${result.stderr}`).toContain("injected CLI media acceptance failure");
    });
    const values = await records(output);
    expect(candidates(values).filter((row) => row.projectId === scope.projectId)).toEqual([]);
    expect(candidates(values).some((row) => row.rowId === firstGrant || row.rowId === secondGrant)).toBe(false);
    expect(summaries(values).some((row) => row.source === "consumed_grants")).toBe(false);
    expect(await references(scope.projectId)).toEqual([]);
  });
});
