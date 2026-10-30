// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Bounded recurring exact-key executor in the signed internal listener's process.
 */
import { randomUUID } from "node:crypto";
import { db, env, logger, maintenanceRepo as repo, type ReclaimRun, type ReclaimItemResult } from "@breatic/core";
import { storageReclaimRepo } from "@breatic/domain";
import { closeMaintenanceStorage, getMaintenanceDependencies, maintenanceAvailability, maintenanceConfig, type MaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";
import { qualify } from "@server/modules/maintenance/qualification.js";

/**
 * One leased item; old results can never replace newer current facts.
 */
interface Claim {
  op: repo.MaintenanceOperation;
  object: repo.MaintenanceObject;
  run: ReclaimRun;
  version: number;
  wasUnknown: boolean;
}

/**
 * Claim one exact item after locking immutable operation identity.
 * @param op - Due approval.
 * @param deps - Runtime clock/limits.
 * @returns A current lease or null when no new work is eligible.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
async function claim(op: repo.MaintenanceOperation, deps: MaintenanceDependencies): Promise<Claim | null> {
  return db.transaction(async (tx) => {
    const current = await repo.lockOperation(op.id, tx);
    if (!current || current.decision.decision !== "accepted")
      return null;
    const now = deps.now();
    const object = await repo.findClaimableObject(current.id, now, tx);
    if (!object)
      return null;
    const objects = await repo.listObjects(op.id, tx);
    const first = await repo.firstRun(op.id, tx);
    const latestRun = await repo.latestRun(op.id, tx);
    let run = first && first.finishedAt === null ? first : latestRun;
    if (!run || run.finishedAt !== null) {
      run = {
        id: randomUUID(), number: (latestRun?.number ?? 0) + 1, state: "running", startedAt: now.toISOString(), finishedAt: null, items: objects.map(o => ({
          ...o.latest, state: "queued", reason: null
        }))
      };
      await repo.addRun(op.id, run, tx);
    }
    const latest = object;
    const version = latest.leaseVersion + 1;
    await repo.updateObject(object.id, {
      leaseVersion: version, leaseUntil: new Date(now.getTime() + deps.config.leaseSeconds * 1000)
    }, tx);
    run = {
      ...run, state: "running", items: run.items.map(i => i.id === object.scope.id ? {
        ...i, state: "running", leaseVersion: version
      } : i)
    };
    await repo.saveRun(run, tx);
    return {
      op: current, object: latest, run, version, wasUnknown: latest.inFlight
    };
  });
}

/**
 * Archive the attempt and update current facts only for the current lease version.
 * @param claimValue - Lease holder.
 * @param result - Attempt outcome.
 * @param observed - New authoritative physical fact, if any.
 * @param uncertain - Whether an old DELETE may still finish.
 * @param deps - Runtime clock/limits.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
async function finish(claimValue: Claim, result: ReclaimItemResult, observed: "missing" | "present" | null, uncertain: boolean, deps: MaintenanceDependencies): Promise<void> {
  await db.transaction(async (tx) => {
    const op = await repo.lockOperation(claimValue.op.id, tx);
    if (!op)
      return;
    await repo.lockKey(claimValue.object.storageKey, tx);
    const object = (await repo.findObject(claimValue.object.storageKey, tx))!;
    await repo.addAttempt({
      operationId: op.id, objectId: object.id, runId: claimValue.run.id, leaseVersion: claimValue.version, result
    }, tx);
    if (object.leaseVersion !== claimValue.version)
      return;
    const now = deps.now();
    const latest: ReclaimItemResult = observed ? {
      ...result, state: observed, checkedAt: result.checkedAt ?? now.toISOString()
    } : object.latest.checkedAt !== null ? {
      ...object.latest, reason: result.reason, leaseVersion: claimValue.version
    } : {
      ...result
    };
    await repo.updateObject(object.id, {
      latest, inFlight: uncertain, leaseUntil: uncertain ? new Date(now.getTime() + deps.config.leaseSeconds * 1000) : null
    }, tx);
    if (observed === "missing")
      await storageReclaimRepo.markReclaimed(object.scope.id, now, tx);
    const run = await repo.findRun(op.id, claimValue.run.id, tx);
    if (!run)
      return;
    const items = run.items.map(i => i.id === result.id ? result : i);
    const ended = items.every(i => i.state !== "queued" && i.state !== "running" && i.state !== "unknown");
    const missing = items.filter(i => i.state === "missing").length;
    const failed = items.every(i => i.state === "failed");
    await repo.saveRun({
      ...run, items, state: ended ? (missing === items.length ? "completed" : failed ? "failed" : "partial") : "running", finishedAt: ended ? now.toISOString() : null
    }, tx);
    if (ended)
      await repo.updateOperation(op.id, {
        nextCheckAt: new Date(now.getTime() + deps.config.checkIntervalSeconds * 1000)
      }, tx);
  });
}

/**
 * Recognize an unbounded or interrupted DELETE without guessing it failed.
 * @param error - Storage exception.
 * @returns Whether the physical call's completion is unknown.
 */
function unknownDelete(error: unknown): boolean {
  return (typeof error === "object" && error !== null && "uncertain" in error && error.uncertain === true) || error instanceof Error && ["AbortError", "TimeoutError", "RequestTimeout", "NetworkingError"].includes(error.name);
}

/**
 * Execute direct HEAD/DELETE under product admission, outside SQL transactions.
 * @param c - Exact current claim.
 * @param deps - Physical operations and deterministic clock.
 * @throws {Error} On an infrastructure failure that prevents durable progress or result persistence.
 */
async function execute(c: Claim, deps: MaintenanceDependencies): Promise<void> {
  let observed: "missing" | "present" | null = null;
  let deleting = false;
  let physicalCall=false;
  /**
   * Distinguish direct storage failures from SQL or persistence failures.
   * @param key - Exact object key.
   * @returns Direct physical observation.
   * @throws {Error} When the physical HEAD fails.
   */
  async function head(key:string):Promise<"missing"|"present">{physicalCall=true;const fact=await deps.storage.head(key);physicalCall=false;return fact;}
  let uncertain = c.wasUnknown;
  let result: ReclaimItemResult = {
    id: c.object.scope.id, storageKey: c.object.storageKey, state: "deferred", reason: null, checkedAt: null, leaseVersion: c.version
  };
  try {
    // A takeover first re-reads the previous physical call, even while paused.
    if (c.wasUnknown) {
      observed = await head(c.object.storageKey);
      result = {
        ...result, checkedAt: deps.now().toISOString()
      };
      if (observed === "missing") {
        result = {
          ...result, state: "missing", checkedAt: deps.now().toISOString()
        };
        uncertain = false;
        await finish(c, result, observed, uncertain, deps);
        return;
      }
      if (c.op.state === "paused") {
        result = {
          ...result, state: "unknown", reason: "delete_unknown", checkedAt: deps.now().toISOString()
        };
        await finish(c, result, observed, true, deps);
        return;
      }
    }
    const rows = await storageReclaimRepo.findCandidates([c.object.scope.id]);
    const candidate = rows[0];
    if (!candidate || candidate.storageKey !== c.object.storageKey || candidate.keptStorageKey !== c.object.scope.keptStorageKey) {
      result.reason = "preview_mismatch";
      await finish(c, result, null, uncertain, deps);
      return;
    }
    let reason = await qualify(candidate, deps);
    if (reason) {
      result = {
        ...result, state: reason === "live_reference" ? "conflict" : "deferred", reason
      };
      await finish(c, result, null, uncertain, deps);
      return;
    }
    if (await head(candidate.keptStorageKey) !== "present") {
      result.reason = "kept_missing";
      await finish(c, result, null, uncertain, deps);
      return;
    }
    // Lock order is operation then exact key; registration only takes the key lock.
    reason = await db.transaction(async (tx) => {
      const op = await repo.lockOperation(c.op.id, tx);
      if (!op || op.state === "paused")
        return "maintenance_paused";
      await repo.lockKey(candidate.storageKey, tx);
      const object = (await repo.findObject(candidate.storageKey, tx))!;
      if (object.leaseVersion !== c.version)
        return "lease_replaced";
      const refused = await qualify(candidate, deps, tx);
      if (refused)
        return refused;
      await repo.updateObject(object.id, {
        retiredAt: object.retiredAt ?? deps.now(), inFlight: true
      }, tx);
      return null;
    });
    if (reason) {
      result = {
        ...result, state: reason === "live_reference" ? "conflict" : "deferred", reason
      };
      await finish(c, result, null, uncertain, deps);
      return;
    }
    if(!c.wasUnknown){
      observed = await head(candidate.storageKey);
      result = {...result, checkedAt:deps.now().toISOString()};
    }
    if (observed === "present") {
      const current = await repo.findOperation(c.op.key);
      const object = await repo.findObject(candidate.storageKey);
      if (current?.state === "paused" || object?.leaseVersion !== c.version) {
        result = {
          ...result, state: c.wasUnknown ? "unknown" : "deferred", reason: current?.state === "paused" ? "maintenance_paused" : "lease_replaced", checkedAt: deps.now().toISOString()
        };
        await finish(c, result, observed, c.wasUnknown, deps);
        return;
      }
      deleting = true;
      physicalCall=true;
      await deps.storage.delete(candidate.storageKey);
      physicalCall=false;
      deleting = false;
      uncertain = false;
      observed = await head(candidate.storageKey);
      result = {
        ...result, checkedAt: deps.now().toISOString()
      };
    }
    else
      uncertain = false;
    if(observed===null)throw new Error("maintenance_observation_missing");
    result = {
      ...result, state: observed, reason: observed === "present" ? "object_present_after_delete" : null, checkedAt: deps.now().toISOString()
    };
    await finish(c, result, observed, uncertain, deps);
  }
  catch (error) {
    if(!physicalCall)throw error;
    uncertain = deleting && unknownDelete(error) || uncertain;
    result = {
      ...result, state: uncertain ? "unknown" : "failed", reason: uncertain ? "delete_unknown" : "storage_error"
    };
    await finish(c, result, observed, uncertain, deps);
    logger.error({
      err: error, operationKey: c.op.key, storageKey: c.object.storageKey, leaseVersion: c.version
    }, "maintenance_attempt_failed");
  }
}

/**
 * Run bounded work across the entire approved set, including already absent keys.
 * @param dependencies - Explicit integration fixture or production runtime.
 * @param isStopped - Prevent new claims once the server begins draining.
 * @returns Once at most batchSize claims have settled.
 * @throws {Error} On an infrastructure failure that prevents durable progress or result persistence.
 */
export async function runMaintenanceLoopOnce(dependencies?: MaintenanceDependencies,isStopped:()=>boolean=()=>false): Promise<void> {
  if (!dependencies && !maintenanceAvailability().available)
    return;
  const deps = dependencies ?? getMaintenanceDependencies();
  if (!deps.config.enabled)
    return;
  let remaining=deps.config.batchSize;
  const concurrency=Math.max(1,Math.min(deps.config.concurrency??1,deps.config.batchSize));
  for(const op of await repo.listDue(deps.now(),deps.config.batchSize)){
    while(remaining>0&&!isStopped()){
      const wave:Claim[]=[];
      while(wave.length<concurrency&&remaining>0&&!isStopped()){
        const work=await claim(op,deps);
        if(!work)break;
        wave.push(work);
        remaining--;
      }
      if(wave.length===0)break;
      // Drain every reserved slot before another wave or shutdown can begin.
      const results=await Promise.allSettled(wave.map(work=>execute(work,deps)));
      const failure=results.find(result=>result.status==="rejected");
      if(failure?.status==="rejected")throw failure.reason;
    }
    if(remaining===0||isStopped())break;
  }
}

/**
 * Graceful maintenance loop lifecycle.
 */
export interface MaintenanceLoop {
  stop(): Promise<void>;
}

/**
 * Start only beside the signed internal API; errors leave a future tick scheduled.
 * @returns Graceful stop handle.
 */
export function startMaintenanceLoop(): MaintenanceLoop {
  if (!env.INTERNAL_API_ENABLED)
    return {
      stop: async () => {
      }
    };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  /**
   * Schedule the next tick only after the current bounded batch settles.
   */
  const tick = (): void => {
    if (stopped)
      return;
    running = runMaintenanceLoopOnce(undefined,()=>stopped).catch(err => logger.error({
      err
    }, "maintenance_loop_failed")).finally(() => {
      running = null;
      if (!stopped)
        timer = setTimeout(tick, maintenanceConfig().loopIntervalSeconds * 1000);
    });
  };
  tick();
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer)
        clearTimeout(timer);
      await running;
      closeMaintenanceStorage();
    }
  };
}
