// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Signed operations API: immutable decisions and durable, versioned maintenance.
 */
import { db, createQueue, defaultJobOpts, maintenanceRepo as repo, type ReclaimScope, type ReclaimDecision, type ReclaimControlDecision, type ReclaimOperationView, type MaintenanceState, type ReclaimRun } from "@breatic/core";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";
import { storageReclaimRepo } from "@breatic/domain";
import { maintenanceAvailability, maintenanceConfig, maintenanceNow, getMaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";
import { checkKeptHead } from "@server/modules/maintenance/kept-head.js";
import { qualify } from "@server/modules/maintenance/qualification.js";

/**
 * Finite internal API reply.
 */
export interface MaintenanceAnswer<T> {
  status: 200 | 202 | 404 | 409;
  body: T | {
    code: string;
  };
}
let taskQueue: ReturnType<typeof createQueue> | null = null;

/**
 * Read all physical BullMQ categories independently, including paused and prioritized.
 * @returns Fresh queue counts and the actual job failure retention.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function queue(): Promise<MaintenanceAnswer<unknown>> {
  taskQueue ??= createQueue("tasks");
  const counts = await taskQueue.getJobCounts("wait", "paused", "prioritized", "active", "delayed", "failed", "waiting-children");
  const retention = defaultJobOpts().removeOnFail;
  return {
    status: 200, body: {
      queue: "tasks", sampledAt: maintenanceNow().toISOString(), counts: {
        waiting: counts.wait ?? 0, paused: counts.paused ?? 0, prioritized: counts.prioritized ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0, waitingChildren: counts["waiting-children"] ?? 0
      }, retention: {
        failedAgeSeconds: retention.age, failedCount: retention.count
      }
    }
  };
}

/**
 * Show actual runtime capability independently of each owner's maintenance state.
 * @param op - Durable operation.
 * @returns Mutable switch read model.
 */
function state(op: repo.MaintenanceOperation): MaintenanceState {
  return {
    state: op.state === "paused" ? "paused" : "enabled", version: op.version, changedBy: op.changedBy, changedAt: op.changedAt.toISOString(), executor: maintenanceAvailability()
  };
}

/**
 * Page explicit queue rows and their permanent approval association.
 * @param pageSize - Validated page size.
 * @param cursor - Optional immutable UUID cursor.
 * @returns Bounded candidate page.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function candidates(pageSize: number, cursor?: string): Promise<MaintenanceAnswer<unknown>> {
  const rows = await storageReclaimRepo.listCandidates(pageSize + 1, cursor);
  const visible = rows.slice(0, pageSize);
  const items = await Promise.all(visible.map(async (r) => {
    const obj = await repo.findObject(r.storageKey);
    const op = obj ? await repo.findOperationById(obj.operationId) : null;
    return {
      id: r.id, storageKey: r.storageKey, keptStorageKey: r.keptStorageKey, createdAt: r.createdAt.toISOString(), source: r.source, operationKey: op?.key ?? null
    };
  }));
  return {
    status: 200, body: {
      items, nextCursor: rows.length > pageSize ? visible.at(-1)!.id : null, executor: maintenanceAvailability()
    }
  };
}

/**
 * Bind a preview to actor, exact identities and an expiry; never guesses legacy origins.
 * @param ids - Validated distinct candidate UUIDs.
 * @param requestedBy - Signed actor.
 * @returns Eligible and explicitly deferred candidates with a durable preview identity.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function preview(ids: string[], requestedBy: string): Promise<MaintenanceAnswer<unknown>> {
  const rows = await storageReclaimRepo.findCandidates(ids);
  const now = maintenanceNow();
  if (rows.length !== ids.length)
    return {
      status: 404, body: {
        code: "not_found"
      }
    };
  const items = [];
  const scopes: ReclaimScope[] = [];
  for (const id of ids) {
    const row = rows.find(r => r.id === id);
    if (!row) {
      items.push({
        id, storageKey: "", keptStorageKey: "", eligible: false, reason: "not_found"
      });
      continue;
    }
    const scope = {
      id, storageKey: row.storageKey, keptStorageKey: row.keptStorageKey
    };
    let reason = await qualify(row, {
      config: maintenanceConfig(), now: maintenanceNow
    });
    if (!reason && await repo.findObject(row.storageKey))
      reason = "already_approved";
    if (!reason) {
      if (!maintenanceAvailability().configured)
        reason = "executor_unavailable";
      else {
        reason = await checkKeptHead(getMaintenanceDependencies().storage, {
          stage: "preview", requestedBy, operationKey: null, previewId: null,
          candidateIds: [row.id], storageKeys: [row.storageKey], keptStorageKey: row.keptStorageKey,
        });
      }
    }
    items.push({
      ...scope, eligible: reason === null, reason
    });
    if (reason === null)
      scopes.push(scope);
  }
  const record = await repo.createPreview({
    requestedBy, items: scopes, expiresAt: new Date(now.getTime() + maintenanceConfig().previewTtlSeconds * 1000)
  });
  return {
    status: 200, body: {
      previewId: record.id, expiresAt: record.expiresAt.toISOString(), items
    }
  };
}

/**
 * Signed original owner request.
 */
export interface MaintenanceSubmission {
  key: string;
  hash: string;
  requestedBy: string;
  previewId: string;
  items: ReclaimScope[];
}

/**
 * Compare a fixed set with the project's canonical request fingerprint.
 * @param left - Persisted preview scope.
 * @param right - Submitted exact scope.
 * @returns Whether identities and keys match independent of object field order.
 */
function sameScope(left: ReclaimScope[], right: ReclaimScope[]): boolean {
  return fingerprint("POST", "maintenance-scope", "", [...left].sort((a, b) => a.id.localeCompare(b.id))) === fingerprint("POST", "maintenance-scope", "", [...right].sort((a, b) => a.id.localeCompare(b.id)));
}

/**
 * Accept an exact preview once; persist business refusal as the same immutable W.
 * @param input - Signed, fingerprinted submission.
 * @returns Immutable acceptance or refusal.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function submit(input: MaintenanceSubmission): Promise<MaintenanceAnswer<ReclaimDecision>> {
  // Replays do not call storage, and physical reads never hold registration locks.
  const replay = await repo.findOperation(input.key);
  if (replay)
    return replay.fingerprint === input.hash ? {
      status: replay.decision.decision === "accepted" ? 202 : 200, body: replay.decision
    } : {
      status: 409, body: {
        code: "idempotency_conflict"
      }
    };
  const checkedPreview = await repo.findPreview(input.previewId);
  let physicalReason: string | null = null;
  if (checkedPreview && checkedPreview.requestedBy === input.requestedBy && sameScope(checkedPreview.items, input.items) && checkedPreview.expiresAt > maintenanceNow()) {
    if (!maintenanceAvailability().configured)
      physicalReason = "executor_unavailable";
    else {
      const storage = getMaintenanceDependencies().storage;
      const keptKeys = [...new Set(checkedPreview.items.map(item => item.keptStorageKey))];
      for (let offset = 0; offset < keptKeys.length; offset += 4) {
        const results = await Promise.all(keptKeys.slice(offset, offset + 4).map(async (key) => {
          const candidates = checkedPreview.items.filter(item => item.keptStorageKey === key);
          return checkKeptHead(storage, {
            stage: "submit", requestedBy: input.requestedBy, operationKey: input.key, previewId: input.previewId,
            candidateIds: candidates.map(item => item.id), storageKeys: candidates.map(item => item.storageKey), keptStorageKey: key,
          });
        }));
        physicalReason = results.find(result => result !== null) ?? null;
        if (physicalReason)
          break;
      }
    }
  }
  return db.transaction(async (tx) => {
    await repo.lockKey("operation:" + input.key, tx);
    const old = await repo.findOperation(input.key, tx);
    if (old)
      return old.fingerprint === input.hash ? {
        status: old.decision.decision === "accepted" ? 202 : 200, body: old.decision
      } : {
        status: 409, body: {
          code: "idempotency_conflict"
        }
      };
    const now = maintenanceNow();
    const snapshot = await repo.findPreview(input.previewId, tx);
    let reason: string | null = null;
    if (!snapshot || snapshot.requestedBy !== input.requestedBy || !sameScope(snapshot.items, input.items))
      reason = "preview_mismatch";
    else if (snapshot.expiresAt <= now)
      reason = "preview_expired";
    const sorted = [...input.items].sort((a, b) => a.storageKey.localeCompare(b.storageKey));
    for (const item of sorted)
      await repo.lockKey(item.storageKey, tx);
    const rows = await storageReclaimRepo.findCandidates(input.items.map(i => i.id), tx);
    if (reason === "preview_mismatch" && snapshot?.requestedBy === input.requestedBy && input.items.length > 0) {
      const exact = input.items.every(item => rows.some(row => row.id === item.id && row.storageKey === item.storageKey && row.keptStorageKey === item.keptStorageKey));
      if (exact) {
        const associations = await Promise.all(input.items.map(item => repo.findObject(item.storageKey, tx)));
        if (associations.every(Boolean))
          reason = "already_approved";
      }
    }
    for (const item of input.items) {
      if (reason)
        break;
      const row = rows.find(r => r.id === item.id);
      if (!row || row.storageKey !== item.storageKey || row.keptStorageKey !== item.keptStorageKey) {
        reason = "preview_mismatch";
        break;
      }
      if (await repo.findObject(item.storageKey, tx)) {
        reason = "already_approved";
        break;
      }
      reason = await qualify(row, {
        config: maintenanceConfig(), now: maintenanceNow
      }, tx);
      if (!reason)
        reason = physicalReason;
    }
    const decision: ReclaimDecision = {
      key: input.key, decision: reason ? "refused" : "accepted", reason, requestedBy: input.requestedBy, decidedAt: now.toISOString()
    };
    const op = await repo.insertOperation({
      key: input.key, fingerprint: input.hash, decision, scope: reason ? [] : input.items, state: "enabled", version: 1, changedBy: input.requestedBy, changedAt: now, nextCheckAt: reason ? new Date("9999-01-01") : now
    }, tx);
    if (!reason)
      for (const item of [...new Map([...input.items].reverse().map(item => [item.storageKey, item])).values()])
        await repo.addObject(op.id, item, tx);
    return {
      status: reason ? 200 : 202, body: decision
    };
  });
}

/**
 * Read original W and all separate execution facts.
 * @param key - Original operation key.
 * @param runsPageSize - Bounded history page size.
 * @param runsCursor - Optional cursor belonging to this operation.
 * @returns Complete view or a successful not-found observation.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function operation(key: string, runsPageSize = 20, runsCursor?: string): Promise<MaintenanceAnswer<ReclaimOperationView>> {
  const op = await repo.findOperation(key);
  if (!op)
    return {
      status: 404, body: {
        code: "not_found"
      }
    };
  if (op.decision.decision === "refused")
    return {
      status: 200, body: {
        decision: op.decision, operation: null
      }
    };
  const cursor = runsCursor ? await repo.findRun(op.id, runsCursor) : null;
  if (runsCursor && !cursor)
    return {
      status: 409, body: {
        code: "invalid_cursor"
      }
    };
  const page = await repo.listRunPage(op.id, runsPageSize + 1, cursor?.number);
  const runs = page.slice(0, runsPageSize);
  const firstRun = await repo.firstRun(op.id);
  const objects = await repo.listObjects(op.id);
  return {
    status: 200, body: {
      decision: op.decision, operation: {
        scope: op.scope, firstRun, maintenance: state(op), runs, latest: objects.map(o => o.latest), runsPage: {
          nextCursor: page.length > runsPageSize ? runs.at(-1)!.id : null
        }
      }
    }
  };
}

/**
 * Signed CAS change with a separate idempotency identity.
 */
export interface MaintenanceControlRequest {
  key: string;
  operationKey: string;
  hash: string;
  requestedBy: string;
  action: "pause" | "resume";
  expectedVersion: number;
  firstRunResume?: boolean;
}

/**
 * Save an independently idempotent owner switch or first-run retry request.
 * @param input - Signed CAS control with independent key.
 * @returns Immutable control receipt; retry never rewrites actor or original W.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function control(input: MaintenanceControlRequest): Promise<MaintenanceAnswer<ReclaimControlDecision>> {
  return db.transaction(async (tx) => {
    await repo.lockKey("control:" + input.key, tx);
    const old = await repo.findControl(input.key, tx);
    if (old)
      return old.fingerprint === input.hash ? {
        status: 200, body: old.decision
      } : {
        status: 409, body: {
          code: "idempotency_conflict"
        }
      };
    const found = await repo.findOperation(input.operationKey, tx);
    if (!found || found.decision.decision !== "accepted")
      return {
        status: 404, body: {
          code: "not_found"
        }
      };
    const op = (await repo.lockOperation(found.id, tx))!;
    const now = maintenanceNow();
    let reason: string | null = op.version !== input.expectedVersion ? "version_conflict" : null;
    let first: ReclaimRun | null = null;
    if (input.firstRunResume && !reason) {
      first = await repo.firstRun(op.id, tx);
      if (!first || !["partial", "failed"].includes(first.state))
        reason = "first_run_not_resumable";
    }
    const nextState = input.action === "pause" ? "paused" : "enabled";
    const changed = op.state !== nextState;
    const version = reason || !changed ? op.version : op.version + 1;
    if (!reason) {
      await repo.updateOperation(op.id, {
        state: nextState, version, changedBy: changed ? input.requestedBy : op.changedBy, changedAt: changed ? now : op.changedAt, nextCheckAt: now
      }, tx);
      if (first) {
        first = {
          ...first, state: "running", finishedAt: null, items: first.items.map(i => i.state === "missing" ? i : {
            ...i, state: "queued", reason: null
          })
        };
        await repo.saveRun(first, tx);
      }
    }
    const decision: ReclaimControlDecision = {
      key: input.key, operationKey: op.key, decision: reason ? "refused" : "saved", action: input.action, state: reason ? (op.state === "paused" ? "paused" : "enabled") : nextState, version, requestedBy: input.requestedBy, decidedAt: now.toISOString(), reason
    };
    await repo.addControl({
      key: input.key, fingerprint: input.hash, kind: input.firstRunResume ? "first_run_resume" : "control", operationId: op.id, decision
    }, tx);
    return {
      status: 200, body: decision
    };
  });
}

/**
 * Look up a control receipt while separately reading the latest owner switch.
 * @param key - Independent control key.
 * @returns Receipt and latest switch, or successful not-found observation.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function controlResult(key: string): Promise<MaintenanceAnswer<unknown>> {
  const saved = await repo.findControl(key);
  if (!saved)
    return {
      status: 404, body: {
        code: "not_found"
      }
    };
  const op = (await repo.findOperation(saved.decision.operationKey))!;
  return {
    status: 200, body: {
      decision: saved.decision, maintenance: state(op)
    }
  };
}
