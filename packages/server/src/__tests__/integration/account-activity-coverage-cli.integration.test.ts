// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Post-implementation acceptance of the real maintenance process, not a TDD red claim. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { MONOREPO_ROOT } from "@breatic/core";

const executeFile = promisify(execFile);
const VERSION = 18_932_201;
const OPERATOR = `cli-acceptance-${randomUUID()}`;
let workspace: string;
let sql: ReturnType<typeof postgres>;

interface CliRun { code: number; signal: string | null; stdout: string; stderr: string; before: number; after: number; }
interface Interval { id: string; version: number; started_at: string; ended_at: string | null; }

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  workspace = await mkdtemp(join(tmpdir(), "channel148-real-cli-"));
  await mkdir(join(workspace, "scripts"));
  await mkdir(join(workspace, "packages", "core"), { recursive: true });
  // Byte-for-byte production scripts, with root discovery confined to an owned
  // temporary workspace that contains no .env. The actual built core is used.
  for (const name of ["activity-coverage.ts", "activity-coverage-options.ts", "load-env.ts"]) {
    await copyFile(join(MONOREPO_ROOT, "scripts", name), join(workspace, "scripts", name));
  }
  await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(join(MONOREPO_ROOT, "packages", "core", "dist"), join(workspace, "packages", "core", "dist"), "dir");
});
afterAll(async () => {
  if (sql) {
    await sql`DELETE FROM account_activity_coverage WHERE version IN (${VERSION},${VERSION + 1})`;
    await sql.end({ timeout: 1 });
  }
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/**
 * Spawn the shipped CLI against the actual container-provided database.
 * @param args - Operator arguments, never a client-supplied clock.
 * @returns Natural process exit, complete captured logs and its wall-clock bounds.
 * @throws {Error} When spawning itself fails without an observable child result.
 */
async function cli(args: string[]): Promise<CliRun> {
  const before = Date.now();
  const command = ["--import", resolve(MONOREPO_ROOT, "node_modules/tsx/dist/esm/index.mjs"), join(workspace, "scripts", "activity-coverage.ts"), ...args];
  const options = { cwd: workspace, timeout: 20_000, encoding: "utf8" as const, env: {
    ...process.env, ENV: "staging", NO_COLOR: "1", DATABASE_URL: inject("DATABASE_URL"), YJS_DATABASE_URL: inject("YJS_DATABASE_URL"),
    REDIS_URL: inject("REDIS_URL"), REDIS_QUEUE_URL: inject("REDIS_QUEUE_URL"), REDIS_STREAM_URL: inject("REDIS_STREAM_URL"), REDIS_COLLAB_URL: inject("REDIS_COLLAB_URL"),
  } };
  try {
    const result = await executeFile(process.execPath, command, options);
    return { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr, before, after: Date.now() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = error as Error & { code?: number | string; signal?: string | null; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, signal: failure.signal ?? null,
      stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", before, after: Date.now() };
  }
}

/**
 * Read the fixture-owned version's original persisted UTC instants.
 * @returns Its intervals in chronological order.
 * @throws {Error} When the real database cannot answer.
 */
async function intervals(): Promise<Interval[]> {
  return sql`SELECT id,version,started_at::text,ended_at::text FROM account_activity_coverage WHERE version=${VERSION} ORDER BY started_at,id`;
}

/**
 * Read structured operator/result logs emitted by the actual child process.
 * @param run - Complete child output.
 * @returns Its parsed JSON log records.
 * @throws {Error} When a purported JSON record is malformed.
 */
function logs(run: CliRun): Array<Record<string, unknown>> {
  return run.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Pin a clean resource exit and the real start/completion operator audit.
 * @param run - The completed actual process.
 * @param action - The admitted operation.
 * @returns Nothing.
 * @throws {Error} When exit, timing or structured audit assertions fail.
 */
function completed(run: CliRun, action: "open" | "close"): void {
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(run.signal).toBe(null);
  expect(run.after - run.before).toBeLessThan(20_000);
  expect(logs(run)).toEqual(expect.arrayContaining([
    expect.objectContaining({ msg: "Activity coverage operation started", operator: OPERATOR, version: VERSION, action }),
    expect.objectContaining({ msg: "Activity coverage operation completed", operator: OPERATOR, version: VERSION, action }),
  ]));
}

describe("P22 actual coverage CLI process acceptance", () => {
  it("leaves coverage closed until an operator opens it and retains a real close/reopen gap", async () => {
    expect(await intervals()).toEqual([]);
    const help = await cli(["--help"]);
    expect(help.code, help.stdout + help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(await intervals()).toEqual([]);

    const args = ["--version", String(VERSION), "--operator", OPERATOR];
    const open = await cli(["open", ...args]);
    completed(open, "open");
    const [first] = await intervals();
    expect(first?.ended_at).toBe(null);
    expect(Date.parse(first!.started_at)).toBeGreaterThanOrEqual(open.before);
    expect(Date.parse(first!.started_at)).toBeLessThanOrEqual(open.after);

    const duplicate = await cli(["open", ...args]);
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.signal).toBe(null);
    expect(logs(duplicate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ msg: "Activity coverage operation started", operator: OPERATOR, version: VERSION, action: "open" }),
      expect.objectContaining({ msg: "Activity coverage operation failed", ctx: expect.objectContaining({ operator: OPERATOR, version: VERSION, action: "open" }), err: expect.objectContaining({ message: expect.any(String) }) }),
    ]));
    expect(await intervals()).toEqual([first]);

    const close = await cli(["close", ...args]);
    completed(close, "close");
    const [closed] = await intervals();
    expect(closed).toMatchObject({ id: first!.id, started_at: first!.started_at });
    expect(Date.parse(closed!.ended_at!)).toBeGreaterThanOrEqual(close.before);
    expect(Date.parse(closed!.ended_at!)).toBeLessThanOrEqual(close.after);

    const reopen = await cli(["open", ...args]);
    completed(reopen, "open");
    const rows = await intervals();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(closed);
    expect(rows[1]?.id).not.toBe(first!.id);
    expect(rows[1]?.ended_at).toBe(null);
    expect(Date.parse(rows[1]!.started_at)).toBeGreaterThan(Date.parse(closed!.ended_at!));
    expect(Date.parse(rows[1]!.started_at)).toBeGreaterThanOrEqual(reopen.before);
    expect(Date.parse(rows[1]!.started_at)).toBeLessThanOrEqual(reopen.after);
  });
});
