// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { readLongMediaJobRequest, type LongMediaJobRequest } from "@breatic/shared";

import type { LongMediaJobPhase, LongMediaJobState } from "@ingest/jobs/long-media-transition.js";

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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
   * @throws {LongMediaJobConflict} When the same id carries a different digest.
   * @throws {LongMediaJobExpired} When the request deadline has passed.
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
   * @throws {LongMediaJobConflict} When the same id carries a different digest.
   * @throws {LongMediaJobExpired} When the request deadline has passed.
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
  }

  /**
   * Create or replay a job whose identity is bound to its immutable digest.
   * @param request - The validated job request.
   * @returns The durable job summary and whether this was a replay.
   * @throws {LongMediaJobConflict} When the same id carries a different digest.
   * @throws {LongMediaJobExpired} When the request deadline has passed.
   */
  submit(request: LongMediaJobRequest): LongMediaJobSubmitResult {
    const now = Date.now();
    if (request.deadlineAt <= now) return { kind: "expired" };

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

    if (result.row === null) return { kind: "conflict" };
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
