// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/** One precise reclaim candidate with a recoverable canonical upload result. */
export interface MaintenanceWorld {
  userId: string;
  studioId: string;
  assetId: string;
  grantId: string;
  id: string;
  contentHash: string;
  storageKey: string;
  keptStorageKey: string;
}

/** Create a correctly shaped immutable backoffice request key. */
export function requestKey(): string { return `bo-${randomUUID()}`; }

/** Create an upload and reclaim row using columns already present on main. */
export async function maintenanceWorld(sql: Sql, source = "upload"): Promise<MaintenanceWorld> {
  const suffix = randomUUID();
  const [user] = await sql<{ id: string }[]>`INSERT INTO users(email,email_verified) VALUES(${`${suffix}@maintenance.test`},true) RETURNING id`;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`INSERT INTO studios(created_by_user_id,slug,type,name) VALUES(${userId},${`m-${suffix}`},'team','Maintenance fixture') RETURNING id`;
  const studioId = studio!.id;
  const contentHash = randomBytes(32).toString("hex");
  const storageKey = `uploads/${suffix}.png`;
  const keptStorageKey = `uploads/${randomUUID()}.png`;
  const [asset] = await sql<{ id: string }[]>`INSERT INTO studio_assets(studio_id,produced_by_user_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source)
    VALUES(${studioId},${userId},${contentHash},${keptStorageKey},${`https://cdn.example.test/${keptStorageKey}`},128,'image/png','image',${source}) RETURNING id`;
  const assetId = asset!.id;
  const [grant] = await sql<{ id: string }[]>`INSERT INTO upload_grants(user_id,studio_id,storage_key,declared_size,consumed_at,asset_id,expires_at,created_at)
    VALUES(${userId},${studioId},${storageKey},128,now()-interval '2 days',${assetId},now()-interval '1 day',now()-interval '2 days') RETURNING id`;
  const [candidate] = await sql<{ id: string }[]>`INSERT INTO storage_reclaim_queue(storage_key,content_hash,studio_id,kept_storage_key,source,created_at)
    VALUES(${storageKey},${contentHash},${studioId},${keptStorageKey},${source},now()-interval '2 days') RETURNING id`;
  return { userId, studioId, assetId, grantId: grant!.id, id: candidate!.id, contentHash, storageKey, keptStorageKey };
}

/** Return only the exact identity approved by an operator. */
export function scopeOf(world: MaintenanceWorld): { id: string; storageKey: string; keptStorageKey: string } {
  return { id: world.id, storageKey: world.storageKey, keptStorageKey: world.keptStorageKey };
}

/** A controllable storage port; its facts do not represent remote R2 evidence. */
export class MaintenanceStorage {
  readonly objects = new Set<string>();
  readonly heads: string[] = [];
  readonly deletes: string[] = [];
  headFailure: Error | null = null;
  deleteFailure: Error | null = null;
  beforeHead: ((key: string) => Promise<void>) | null = null;
  beforeDelete: ((key: string) => Promise<void>) | null = null;

  /** Return the current physical fact exposed by this dependency port. */
  async head(key: string): Promise<"present" | "missing"> {
    this.heads.push(key);
    await this.beforeHead?.(key);
    if (this.headFailure) throw this.headFailure;
    return this.objects.has(key) ? "present" : "missing";
  }

  /** Remove exactly one key, retaining call evidence for safety assertions. */
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    await this.beforeDelete?.(key);
    if (this.deleteFailure) throw this.deleteFailure;
    this.objects.delete(key);
  }

  /** Make both the approved duplicate and its canonical keeper available. */
  seed(world: MaintenanceWorld): void {
    this.objects.add(world.storageKey);
    this.objects.add(world.keptStorageKey);
  }
}

/** A bounded explicit gate for an observed asynchronous interleaving. */
export function gate(): { entered: Promise<void>; released: Promise<void>; enter: () => void; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, released, enter, release };
}

/** Archive measured first/last page plans without assuming a small fixture uses an index. */
export async function recordMaintenancePaginationPlans(sql: Sql, operationKey: string): Promise<void> {
  const [operation] = await sql<{ id: string }[]>`SELECT id FROM storage_reclaim_operations WHERE key=${operationKey}`;
  const [tail] = await sql<{ id: string }[]>`SELECT id FROM storage_reclaim_queue ORDER BY id DESC OFFSET 7 LIMIT 1`;
  const [firstCandidate] = await sql<{ id: string }[]>`SELECT id FROM storage_reclaim_queue ORDER BY id LIMIT 1`;
  const firstRuns = await sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT snapshot FROM storage_reclaim_runs WHERE operation_id=${operation!.id} AND deleted_at IS NULL ORDER BY number DESC LIMIT 8`;
  const lastRuns = await sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT snapshot FROM storage_reclaim_runs WHERE operation_id=${operation!.id} AND deleted_at IS NULL AND number<8 ORDER BY number DESC LIMIT 8`;
  const firstCandidates = await sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,storage_key FROM storage_reclaim_queue ORDER BY id LIMIT 8`;
  const lastCandidates = await sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,storage_key FROM storage_reclaim_queue WHERE id>${tail?.id ?? firstCandidate!.id} ORDER BY id LIMIT 8`;
  const result = { fixtureRuns: 25, runPageLimit: 8, lastRunBeforeNumber: 8, plans: { firstRuns, lastRuns, firstCandidates, lastCandidates } };
  await writeFile(join(tmpdir(), "jobs30-maintenance-pagination-plans.json"), `${JSON.stringify(result, null, 2)}\n`);
}
