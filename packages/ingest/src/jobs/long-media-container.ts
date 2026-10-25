// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { acceptLongMediaProbeReport } from "@ingest/jobs/long-media-routes.js";
import {
  readLongMediaJobRequest,
  readLongMediaProbeReport,
  type LongMediaJobRequest,
  type LongMediaProbeReport,
} from "@breatic/shared";
import {
  transitionLongMediaAttempt,
  type LongMediaAttemptEffect,
  type LongMediaAttemptEvent,
  type LongMediaAttemptState,
} from "@ingest/jobs/long-media-attempt.js";

import {
  transitionLongMediaJob,
  type LongMediaJobEvent,
  type LongMediaJobEffect,
  type LongMediaJobPhase,
  type LongMediaJobState,
} from "@ingest/jobs/long-media-transition.js";

/** The container bindings needed by one long media Durable Object. */
export interface LongMediaEnv {
  BUCKET: R2Bucket;
  LONG_MEDIA: DurableObjectNamespace<LongMediaContainer>;
}

/** State storage accepted by both the container DO and its workerd protocol test DO. */
type LongMediaState = ConstructorParameters<typeof Container<LongMediaEnv>>[0];

/** The durable summary returned to the Node worker. */
export interface LongMediaJobSnapshot {
  jobId: string;
  operationId: string;
  sourceIndex: number;
  phase: LongMediaJobPhase;
  version: number;
  deadlineAt: number;
  terminalIntent: LongMediaJobState["terminalIntent"];
}

/** Result of accepting or replaying one durable job identity. */
export type LongMediaJobSubmitResult =
  | { kind: "accepted" | "replayed"; snapshot: LongMediaJobSnapshot }
  | { kind: "conflict" }
  | { kind: "expired" };

/** One row returned from the Durable Object job table. */
interface LongMediaJobRow extends Record<string, SqlStorageValue> {
  job_id: string;
  operation_id: string;
  source_index: number;
  request_digest: string;
  request_json: string;
  phase: string;
  version: number;
  deadline_at: number;
  terminal_intent: string | null;
  active_container: number;
}

/** One recoverable side effect still waiting to be performed. */
interface LongMediaEffectRow extends Record<string, SqlStorageValue> {
  effect: string;
}

/** One persisted Container attempt. */
interface LongMediaAttemptRow extends Record<string, SqlStorageValue> {
  job_id: string;
  epoch: number;
  attempt_id: string;
  phase: string;
}

/** One unacknowledged action for a specific attempt. */
interface LongMediaAttemptEffectRow extends Record<string, SqlStorageValue> {
  epoch: number;
  attempt_id: string;
  effect: string;
}

/** A persisted authoritative probe report for one immutable job source. */
interface LongMediaProbeRow extends Record<string, SqlStorageValue> {
  job_id: string;
  epoch: number;
  attempt_id: string;
  report_json: string;
}

/** Result of attempting to commit current-attempt source probe facts. */
export type LongMediaProbeApplyResult =
  | { kind: "accepted" | "replayed"; report: LongMediaProbeReport; lifecycle: LongMediaTransitionResult }
  | { kind: "stale" | "conflict" | "not-probing" };

const JOB_TABLE = `
  CREATE TABLE IF NOT EXISTS long_media_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    request_digest TEXT NOT NULL,
    request_json TEXT NOT NULL,
    phase TEXT NOT NULL,
    version INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    terminal_intent TEXT,
    active_container INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

const EFFECT_TABLE = `
  CREATE TABLE IF NOT EXISTS long_media_effects (
    job_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    effect TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (job_id, revision, effect)
  )
`;

const ATTEMPT_TABLES = `
  CREATE TABLE IF NOT EXISTS long_media_attempts (
    job_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, epoch),
    UNIQUE (job_id, attempt_id)
  );
  CREATE TABLE IF NOT EXISTS long_media_attempt_effects (
    job_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    attempt_id TEXT NOT NULL,
    effect TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (job_id, epoch, effect)
  )
`;

const PROBE_TABLE = `
  CREATE TABLE IF NOT EXISTS long_media_probe_facts (
    job_id TEXT PRIMARY KEY NOT NULL,
    epoch INTEGER NOT NULL,
    attempt_id TEXT NOT NULL,
    report_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

/** A Durable Object holding one long media job and its Container. */
export class LongMediaContainer extends Container<LongMediaEnv> {
  private readonly jobStore: LongMediaJobStore;

  defaultPort = 8787;

  enableInternet = false;

  interceptHttps = true;

  /**
   * Initialize the durable job header table.
   * @param ctx - The Durable Object state.
   * @param env - The bound R2 resources.
   */
  constructor(ctx: LongMediaState, env: LongMediaEnv) {
    super(ctx, env);
    this.jobStore = new LongMediaJobStore(ctx);
  }

  /**
   * Create or replay a job whose identity is bound to its immutable digest.
   * @param request - The validated job request.
   * @returns The durable job summary and whether this was a replay.
   * @throws {Error} When the stored request identity is corrupt.
   */
  submit(request: LongMediaJobRequest): LongMediaJobSubmitResult {
    return this.jobStore.submit(request);
  }

  /**
   * Read this Worker's Durable Object job summary.
   * @returns The durable summary or null if the job has not been submitted.
   * @throws {Error} When its stored state is invalid.
   */
  report(): LongMediaJobSnapshot | null {
    return this.jobStore.report();
  }

  /**
   * Apply one lifecycle event to this durable job.
   * @param event - The lifecycle event.
   * @param now - The event's epoch milliseconds.
   * @returns The committed state and effects, or null if no job exists.
   * @throws {RangeError} When the lifecycle revision cannot advance safely.
   */
  transition(event: LongMediaJobEvent, now: number): LongMediaTransitionResult | null {
    return this.jobStore.transition(event, now);
  }

  /**
   * List effect records that have not been acknowledged.
   * @returns Pending effects in insertion order.
   */
  pendingEffects(): LongMediaJobEffect[] {
    return this.jobStore.pendingEffects();
  }

  /**
   * Start a new durable Container attempt when the job is live and idle.
   * @param attemptId - Stable id allocated by the caller for this attempt.
   * @param now - The allocation time in epoch milliseconds.
   * @returns The queued attempt and start effect, or null when the job cannot run.
   */
  startAttempt(attemptId: string, now: number): LongMediaAttemptTransitionResult | null {
    return this.jobStore.startAttempt(attemptId, now);
  }

  /**
   * Apply a durable event to the current Container attempt.
   * @param event - The incoming attempt event.
   * @param now - The event time in epoch milliseconds.
   * @returns The committed attempt and effects, or null when there is no attempt.
   */
  applyAttemptEvent(event: LongMediaAttemptEvent, now: number): LongMediaAttemptTransitionResult | null {
    return this.jobStore.applyAttemptEvent(event, now);
  }

  /**
   * List unacknowledged Container actions for the current job.
   * @returns Pending actions in insertion order.
   */
  pendingAttemptEffects(): LongMediaAttemptEffectRecord[] {
    return this.jobStore.pendingAttemptEffects();
  }

  /**
   * Validate and atomically persist probe facts from the current Container attempt.
   * @param attemptId - The Container attempt that produced the report.
   * @param epoch - The attempt fencing epoch.
   * @param report - Untrusted decoded probe output.
   * @param now - The event time in epoch milliseconds.
   * @returns The persisted report and lifecycle transition, or the rejection reason.
   * @throws {Error} When the probe report is malformed or durable state is corrupt.
   */
  applyProbeReport(attemptId: string, epoch: number, report: unknown, now: number): LongMediaProbeApplyResult {
    return this.jobStore.applyProbeReport(attemptId, epoch, report, now);
  }
}

/** A non-container Durable Object used to exercise the protocol in workerd. */
export class LongMediaJobTestObject extends DurableObject<LongMediaEnv> {
  private readonly jobStore: LongMediaJobStore;

  /**
   * Initialize the protocol test object.
   * @param ctx - The Durable Object state.
   * @param env - The bound R2 resources.
   */
  constructor(ctx: LongMediaState, env: LongMediaEnv) {
    super(ctx, env);
    this.jobStore = new LongMediaJobStore(ctx);
  }

  /**
   * Create or replay a job whose identity is bound to its immutable digest.
   * @param request - The validated job request.
   * @returns The durable job summary and whether this was a replay.
   * @throws {Error} When the stored request identity is corrupt.
   */
  submit(request: LongMediaJobRequest): LongMediaJobSubmitResult {
    return this.jobStore.submit(request);
  }

  /**
   * Read this Worker's Durable Object job summary.
   * @returns The durable summary or null if the job has not been submitted.
   * @throws {Error} When its stored state is invalid.
   */
  report(): LongMediaJobSnapshot | null {
    return this.jobStore.report();
  }

  /**
   * Apply one lifecycle event to this durable job.
   * @param event - The lifecycle event.
   * @param now - The event's epoch milliseconds.
   * @returns The committed state and effects, or null if no job exists.
   * @throws {RangeError} When the lifecycle revision cannot advance safely.
   */
  transition(event: LongMediaJobEvent, now: number): LongMediaTransitionResult | null {
    return this.jobStore.transition(event, now);
  }

  /**
   * List effect records that have not been acknowledged.
   * @returns Pending effects in insertion order.
   */
  pendingEffects(): LongMediaJobEffect[] {
    return this.jobStore.pendingEffects();
  }

  /**
   * Start a new durable Container attempt when the job is live and idle.
   * @param attemptId - Stable id allocated by the caller for this attempt.
   * @param now - The allocation time in epoch milliseconds.
   * @returns The queued attempt and start effect, or null when the job cannot run.
   */
  startAttempt(attemptId: string, now: number): LongMediaAttemptTransitionResult | null {
    return this.jobStore.startAttempt(attemptId, now);
  }

  /**
   * Apply a durable event to the current Container attempt.
   * @param event - The incoming attempt event.
   * @param now - The event time in epoch milliseconds.
   * @returns The committed attempt and effects, or null when there is no attempt.
   */
  applyAttemptEvent(event: LongMediaAttemptEvent, now: number): LongMediaAttemptTransitionResult | null {
    return this.jobStore.applyAttemptEvent(event, now);
  }

  /**
   * List unacknowledged Container actions for the current job.
   * @returns Pending actions in insertion order.
   */
  pendingAttemptEffects(): LongMediaAttemptEffectRecord[] {
    return this.jobStore.pendingAttemptEffects();
  }

  /**
   * Validate and atomically persist probe facts from the current Container attempt.
   * @param attemptId - The Container attempt that produced the report.
   * @param epoch - The attempt fencing epoch.
   * @param report - Untrusted decoded probe output.
   * @param now - The event time in epoch milliseconds.
   * @returns The persisted report and lifecycle transition, or the rejection reason.
   * @throws {Error} When the probe report is malformed or durable state is corrupt.
   */
  applyProbeReport(attemptId: string, epoch: number, report: unknown, now: number): LongMediaProbeApplyResult {
    return this.jobStore.applyProbeReport(attemptId, epoch, report, now);
  }
}

LongMediaContainer.outboundHandlers = { acceptLongMediaProbeReport };

/** The committed lifecycle snapshot and requested effects. */
export interface LongMediaTransitionResult {
  snapshot: LongMediaJobSnapshot;
  effects: LongMediaJobEffect[];
}

/** One committed attempt state and the external actions it requested. */
export interface LongMediaAttemptTransitionResult {
  state: LongMediaAttemptState;
  effects: LongMediaAttemptEffect[];
}

/** An effect together with the attempt identity that owns it. */
export interface LongMediaAttemptEffectRecord {
  epoch: number;
  attemptId: string;
  effect: LongMediaAttemptEffect;
}

/** Durable SQL facts shared by production and workerd test DOs. */
class LongMediaJobStore {
  private readonly ctx: LongMediaState;

  /**
   * Create the job store and ensure its fact table exists.
   * @param ctx - The Durable Object state.
   */
  constructor(ctx: LongMediaState) {
    this.ctx = ctx;
    this.ctx.storage.sql.exec(JOB_TABLE);
    this.ctx.storage.sql.exec(EFFECT_TABLE);
    this.ctx.storage.sql.exec(ATTEMPT_TABLES);
    this.ctx.storage.sql.exec(PROBE_TABLE);
  }

  /**
   * Create or replay a job whose identity is bound to its immutable digest.
   * @param request - The validated job request.
   * @returns The durable job summary and whether this was a replay.
   * @throws {Error} When the stored request identity is corrupt.
   */
  submit(request: LongMediaJobRequest): LongMediaJobSubmitResult {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const held = this.ctx.storage.sql
        .exec<LongMediaJobRow>("SELECT * FROM long_media_jobs WHERE job_id = ?", request.jobId)
        .toArray()[0];
      if (held !== undefined) {
        if (held.request_digest !== request.requestDigest) {
          return { row: null, replayed: false };
        }
        return { row: held, replayed: true };
      }
      if (request.deadlineAt <= now) return { row: null, replayed: false, expired: true };

      const state: LongMediaJobState = {
        phase: "accepted",
        version: 0,
        deadlineAt: request.deadlineAt,
        terminalIntent: null,
        activeContainer: false,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO long_media_jobs (
          job_id, operation_id, source_index, request_digest, request_json,
          phase, version, deadline_at, terminal_intent, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        request.jobId,
        request.operationId,
        request.sourceIndex,
        request.requestDigest,
        JSON.stringify(request),
        state.phase,
        state.version,
        state.deadlineAt,
        state.terminalIntent,
        now,
        now,
      );
      const created = this.ctx.storage.sql
        .exec<LongMediaJobRow>("SELECT * FROM long_media_jobs WHERE job_id = ?", request.jobId)
        .one();
      return { row: created, replayed: false };
    });

    if (result.row === null) return { kind: result.expired === true ? "expired" : "conflict" };
    return { kind: result.replayed ? "replayed" : "accepted", snapshot: snapshotOf(result.row) };
  }

  /**
   * Read this Durable Object's job summary.
   * @returns The durable summary or null if the job has not been submitted.
   * @throws {Error} When its stored state is invalid.
   */
  report(): LongMediaJobSnapshot | null {
    const row = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
    return row === undefined ? null : snapshotOf(row);
  }

  /**
   * Apply one event and atomically record its requested external effects.
   * @param event - The lifecycle event.
   * @param now - The event's epoch milliseconds.
   * @returns The committed state and effects, or null when no job exists.
   * @throws {RangeError} When the lifecycle revision cannot advance safely.
   */
  transition(event: LongMediaJobEvent, now: number): LongMediaTransitionResult | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      if (row === undefined) return null;
      const current = stateOf(row);
      const next = transitionLongMediaJob(current, event, now);
      if (next.state.version !== current.version) {
        this.ctx.storage.sql.exec(
          `UPDATE long_media_jobs SET phase = ?, version = ?, terminal_intent = ?, active_container = ?, updated_at = ? WHERE job_id = ?`,
          next.state.phase,
          next.state.version,
          next.state.terminalIntent,
          next.state.activeContainer ? 1 : 0,
          now,
          row.job_id,
        );
      }
      for (const effect of next.effects) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO long_media_effects (job_id, revision, effect, status) VALUES (?, ?, ?, 'pending')",
          row.job_id,
          next.state.version,
          effect,
        );
      }
      return {
        snapshot: {
          jobId: row.job_id,
          operationId: row.operation_id,
          sourceIndex: row.source_index,
          phase: next.state.phase,
          version: next.state.version,
          deadlineAt: next.state.deadlineAt,
          terminalIntent: next.state.terminalIntent,
        },
        effects: next.effects,
      };
    });
  }

  /**
   * Read all unacknowledged external effects for this job.
   * @returns Pending effects in insertion order.
   * @throws {Error} When a persisted effect name is invalid.
   */
  pendingEffects(): LongMediaJobEffect[] {
    const rows = this.ctx.storage.sql
      .exec<LongMediaEffectRow>("SELECT effect FROM long_media_effects WHERE status = 'pending' ORDER BY revision, effect")
      .toArray();
    return rows.map((row) => readEffect(row.effect));
  }

  /**
   * Persist a new attempt and its start effect before Container startup.
   * @param attemptId - Stable id allocated for this attempt.
   * @param now - The allocation time in epoch milliseconds.
   * @returns The new attempt or null when the job is stopped, expired, or busy.
   */
  startAttempt(attemptId: string, now: number): LongMediaAttemptTransitionResult | null {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      if (job === undefined || !jobCanRun(job, now)) return null;
      const held = this.ctx.storage.sql
        .exec<LongMediaAttemptRow>("SELECT * FROM long_media_attempts ORDER BY epoch DESC LIMIT 1")
        .toArray()[0];
      if (held !== undefined && !isAttemptTerminal(readAttemptPhase(held.phase))) return null;
      const epoch = (held?.epoch ?? 0) + 1;
      const queued: LongMediaAttemptState = { attemptId, epoch, phase: "queued" };
      const transition = transitionLongMediaAttempt(queued, { type: "start" });
      this.ctx.storage.sql.exec(
        "INSERT INTO long_media_attempts (job_id, epoch, attempt_id, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        job.job_id,
        epoch,
        attemptId,
        transition.state.phase,
        now,
        now,
      );
      for (const effect of transition.effects) {
        this.ctx.storage.sql.exec(
          "INSERT INTO long_media_attempt_effects (job_id, epoch, attempt_id, effect, status) VALUES (?, ?, ?, ?, 'pending')",
          job.job_id,
          epoch,
          attemptId,
          effect,
        );
      }
      return transition;
    });
  }

  /**
   * Apply a fenced event to the newest attempt and persist its effects.
   * @param event - The incoming attempt event.
   * @param now - The event time in epoch milliseconds.
   * @returns The committed attempt and effects, or null when no attempt exists.
   */
  applyAttemptEvent(event: LongMediaAttemptEvent, now: number): LongMediaAttemptTransitionResult | null {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      const row = this.ctx.storage.sql
        .exec<LongMediaAttemptRow>("SELECT * FROM long_media_attempts ORDER BY epoch DESC LIMIT 1")
        .toArray()[0];
      if (job === undefined || row === undefined) return null;
      const current = attemptStateOf(row);
      const effectiveEvent = event.type === "restart"
        ? { ...event, jobLive: event.jobLive && jobCanRun(job, now) }
        : event;
      const transition = transitionLongMediaAttempt(current, effectiveEvent);
      if (transition.state.epoch !== current.epoch) {
        this.ctx.storage.sql.exec(
          "INSERT INTO long_media_attempts (job_id, epoch, attempt_id, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          job.job_id,
          transition.state.epoch,
          transition.state.attemptId,
          transition.state.phase,
          now,
          now,
        );
      } else if (transition.state.phase !== current.phase) {
        this.ctx.storage.sql.exec(
          "UPDATE long_media_attempts SET phase = ?, updated_at = ? WHERE job_id = ? AND epoch = ? AND attempt_id = ?",
          transition.state.phase,
          now,
          job.job_id,
          current.epoch,
          current.attemptId,
        );
      }
      for (const effect of transition.effects) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO long_media_attempt_effects (job_id, epoch, attempt_id, effect, status) VALUES (?, ?, ?, ?, 'pending')",
          job.job_id,
          transition.state.epoch,
          transition.state.attemptId,
          effect,
        );
      }
      return transition;
    });
  }

  /**
   * Read pending start and destroy actions with their fencing identity.
   * @returns Pending actions in attempt order.
   * @throws {Error} When a persisted action name is invalid.
   */
  pendingAttemptEffects(): LongMediaAttemptEffectRecord[] {
    const rows = this.ctx.storage.sql
      .exec<LongMediaAttemptEffectRow>(
        "SELECT epoch, attempt_id, effect FROM long_media_attempt_effects WHERE status = 'pending' ORDER BY epoch, effect",
      )
      .toArray();
    return rows.map((row) => ({ epoch: row.epoch, attemptId: row.attempt_id, effect: readAttemptEffect(row.effect) }));
  }

  /**
   * Validate and atomically accept current-attempt source probe facts.
   * @param attemptId - The producing attempt identity.
   * @param epoch - The producing attempt epoch.
   * @param value - The untrusted container report.
   * @param now - The event time in epoch milliseconds.
   * @returns The accepted report and lifecycle transition or a fenced rejection.
   * @throws {Error} When the report or persisted source identity is malformed.
   */
  applyProbeReport(attemptId: string, epoch: number, value: unknown, now: number): LongMediaProbeApplyResult {
    const report = readLongMediaProbeReport(value);
    const reportJson = JSON.stringify(report);
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      const attempt = this.ctx.storage.sql
        .exec<LongMediaAttemptRow>("SELECT * FROM long_media_attempts ORDER BY epoch DESC LIMIT 1")
        .toArray()[0];
      if (job === undefined || attempt === undefined || attempt.attempt_id !== attemptId || attempt.epoch !== epoch ||
          readAttemptPhase(attempt.phase) !== "running") return { kind: "stale" };

      const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
      if (report.sourceFingerprint.toLowerCase() !== request.source.sha256.toLowerCase()) return { kind: "conflict" };
      const held = this.ctx.storage.sql.exec<LongMediaProbeRow>(
        "SELECT * FROM long_media_probe_facts WHERE job_id = ?",
        job.job_id,
      ).toArray()[0];
      if (held !== undefined) {
        return held.epoch === epoch && held.attempt_id === attemptId && held.report_json === reportJson
          ? { kind: "replayed", report, lifecycle: currentLifecycle(job) }
          : { kind: "conflict" };
      }

      const current = stateOf(job);
      const transition = transitionLongMediaJob(current, { type: "probeOk" }, now);
      if (current.phase !== "probing" || transition.state.phase !== "planning" || transition.state.version === current.version) {
        return { kind: "not-probing" };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO long_media_probe_facts (job_id, epoch, attempt_id, report_json, created_at) VALUES (?, ?, ?, ?, ?)",
        job.job_id,
        epoch,
        attemptId,
        reportJson,
        now,
      );
      persistLifecycle(this.ctx, job, transition, now);
      return {
        kind: "accepted",
        report,
        lifecycle: lifecycleResult(job, transition),
      };
    });
  }
}

/**
 * Validate whether the parent job can create or restart an attempt.
 * @param row - The persisted job header.
 * @param now - The current time.
 * @returns Whether media work remains authorized.
 */
function jobCanRun(row: LongMediaJobRow, now: number): boolean {
  return now < row.deadline_at && row.terminal_intent === null && !["stopping", "done", "failed", "cancelled", "expired"].includes(row.phase);
}

/**
 * Read the typed state for a persisted attempt.
 * @param row - The persisted attempt row.
 * @returns The validated state.
 * @throws {Error} When the phase is invalid.
 */
function attemptStateOf(row: LongMediaAttemptRow): LongMediaAttemptState {
  return { attemptId: row.attempt_id, epoch: row.epoch, phase: readAttemptPhase(row.phase) };
}

/**
 * Validate a persisted attempt phase.
 * @param value - The SQL value.
 * @returns A known phase.
 * @throws {Error} When the phase is unknown.
 */
function readAttemptPhase(value: string): LongMediaAttemptState["phase"] {
  const phases: readonly LongMediaAttemptState["phase"][] = ["queued", "starting", "running", "stopping", "stopped", "lost"];
  if (!phases.includes(value as LongMediaAttemptState["phase"])) throw new Error("The long media attempt phase is invalid");
  return value as LongMediaAttemptState["phase"];
}

/**
 * Tell whether an attempt has no active Container process.
 * @param phase - The attempt phase.
 * @returns Whether another epoch may be allocated.
 */
function isAttemptTerminal(phase: LongMediaAttemptState["phase"]): boolean {
  return phase === "stopped" || phase === "lost";
}

/**
 * Validate a persisted Container action.
 * @param value - The SQL value.
 * @returns A known action.
 * @throws {Error} When the action is unknown.
 */
function readAttemptEffect(value: string): LongMediaAttemptEffect {
  if (value === "start" || value === "destroy") return value;
  throw new Error("The long media attempt effect is invalid");
}

/**
 * Validate a persisted effect name.
 * @param value - The SQL value.
 * @returns A known long media effect.
 * @throws {Error} When the effect name is unknown.
 */
function readEffect(value: string): LongMediaJobEffect {
  const effects: readonly LongMediaJobEffect[] = [
    "startProbe", "startMediaAttempt", "stopContainer", "checkContainerStopped", "revokePermits", "cancelDeadline",
  ];
  if (!effects.includes(value as LongMediaJobEffect)) throw new Error("The long media effect is invalid");
  return value as LongMediaJobEffect;
}

/**
 * Persist one lifecycle reducer result and its retryable effects.
 * @param ctx - The Durable Object state store.
 * @param row - The previous job row.
 * @param transition - The computed lifecycle transition.
 * @param now - The update time in epoch milliseconds.
 */
function persistLifecycle(
  ctx: LongMediaState,
  row: LongMediaJobRow,
  transition: ReturnType<typeof transitionLongMediaJob>,
  now: number,
): void {
  ctx.storage.sql.exec(
    "UPDATE long_media_jobs SET phase = ?, version = ?, terminal_intent = ?, active_container = ?, updated_at = ? WHERE job_id = ?",
    transition.state.phase,
    transition.state.version,
    transition.state.terminalIntent,
    transition.state.activeContainer ? 1 : 0,
    now,
    row.job_id,
  );
  for (const effect of transition.effects) {
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO long_media_effects (job_id, revision, effect, status) VALUES (?, ?, ?, 'pending')",
      row.job_id,
      transition.state.version,
      effect,
    );
  }
}

/**
 * Build the public lifecycle result for one reducer transition.
 * @param row - The prior persisted job row.
 * @param transition - The computed lifecycle transition.
 * @returns The next durable summary and requested effects.
 */
function lifecycleResult(
  row: LongMediaJobRow,
  transition: ReturnType<typeof transitionLongMediaJob>,
): LongMediaTransitionResult {
  return {
    snapshot: {
      jobId: row.job_id,
      operationId: row.operation_id,
      sourceIndex: row.source_index,
      phase: transition.state.phase,
      version: transition.state.version,
      deadlineAt: transition.state.deadlineAt,
      terminalIntent: transition.state.terminalIntent,
    },
    effects: transition.effects,
  };
}

/**
 * Read the unchanged lifecycle result for an idempotent probe replay.
 * @param row - The persisted job row.
 * @returns Its current summary without new effects.
 */
function currentLifecycle(row: LongMediaJobRow): LongMediaTransitionResult {
  return { snapshot: snapshotOf(row), effects: [] };
}

/**
 * Convert a durable job header into lifecycle reducer state.
 * @param row - The stored job row.
 * @returns The reducer state.
 * @throws {Error} When a persisted state value is invalid.
 */
function stateOf(row: LongMediaJobRow): LongMediaJobState {
  if (row.active_container !== 0 && row.active_container !== 1) {
    throw new Error("The long media active container flag is invalid");
  }
  return {
    phase: readPhase(row.phase),
    version: row.version,
    deadlineAt: row.deadline_at,
    terminalIntent: readTerminalIntent(row.terminal_intent),
    activeContainer: row.active_container === 1,
  };
}

/**
 * Convert a persisted row into its validated public summary.
 * @param row - The stored job row.
 * @returns The minimal job summary.
 * @throws {Error} When the durable phase or request record is invalid.
 */
function snapshotOf(row: LongMediaJobRow): LongMediaJobSnapshot {
  const phase = readPhase(row.phase);
  const terminalIntent = readTerminalIntent(row.terminal_intent);
  const request = readLongMediaJobRequest(JSON.parse(row.request_json));
  if (request.jobId !== row.job_id || request.requestDigest !== row.request_digest) {
    throw new Error("The long media job durable identity is inconsistent");
  }
  return {
    jobId: row.job_id,
    operationId: row.operation_id,
    sourceIndex: row.source_index,
    phase,
    version: row.version,
    deadlineAt: row.deadline_at,
    terminalIntent,
  };
}

/**
 * Read one persisted lifecycle phase.
 * @param value - The database value.
 * @returns A known phase.
 * @throws {Error} When the phase is not part of the protocol.
 */
function readPhase(value: string): LongMediaJobPhase {
  const phases: readonly LongMediaJobPhase[] = [
    "accepted", "probing", "planning", "running", "stopping", "done", "failed", "cancelled", "expired",
  ];
  if (!phases.includes(value as LongMediaJobPhase)) throw new Error("The long media job phase is invalid");
  return value as LongMediaJobPhase;
}

/**
 * Read a persisted terminal intent.
 * @param value - The database value.
 * @returns The intent, or null while the job remains live.
 * @throws {Error} When the intent is unknown.
 */
function readTerminalIntent(value: string | null): LongMediaJobState["terminalIntent"] {
  if (value === null) return null;
  if (value === "failed" || value === "cancelled" || value === "expired") return value;
  throw new Error("The long media job terminal intent is invalid");
}
