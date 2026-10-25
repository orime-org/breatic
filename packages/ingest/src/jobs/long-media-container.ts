// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { readLongMediaJobRequest, type LongMediaJobRequest } from "@breatic/shared";

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
}

/** The committed lifecycle snapshot and requested effects. */
export interface LongMediaTransitionResult {
  snapshot: LongMediaJobSnapshot;
  effects: LongMediaJobEffect[];
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
