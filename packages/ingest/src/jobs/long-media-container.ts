// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import type { StopParams } from "@cloudflare/containers";
import {
  acceptLongMediaProbeReport,
  LONG_MEDIA_REPORT_HOST,
  serveLongMediaSource,
} from "@ingest/jobs/long-media-routes.js";
import { mediaObjectUrl, MEDIA_OBJECT_HOST } from "@ingest/media-object-route.js";
import { LONG_MEDIA_PROBE_PATH, PROBE_PORT } from "@ingest/probe-answer.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import {
  readLongMediaJobRequest,
  readLongMediaProbeReport,
  type LongMediaJobRequest,
  type LongMediaProbeReport,
} from "@breatic/shared";
import type { LongMediaSegmentPlan, LongMediaSegmentStatus, LongMediaSegmentEvent } from "@ingest/jobs/long-media-segment.js";
import { transitionLongMediaSegment } from "@ingest/jobs/long-media-segment.js";
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
  revision: number;
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

/** One persisted logical media leaf. */
interface LongMediaSegmentRow extends Record<string, SqlStorageValue> {
  segment_id: string;
  media_input_id: string;
  descriptor_json: string;
  core_start_us: string;
  core_end_us: string;
  decode_start_us: string;
  decode_end_us: string;
  status: string;
  version: number;
}

/** Result of attempting to commit current-attempt source probe facts. */
export type LongMediaProbeApplyResult =
  | { kind: "accepted" | "replayed"; report: LongMediaProbeReport; lifecycle: LongMediaTransitionResult }
  | { kind: "stale" | "conflict" | "not-probing" };

/** Result of a fenced probe failure report. */
export type LongMediaProbeFailureApplyResult =
  | { kind: "accepted"; lifecycle: LongMediaTransitionResult }
  | { kind: "stale" | "not-probing" };

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

const SEGMENT_TABLES = `
  CREATE TABLE IF NOT EXISTS long_media_segment_plans (
    job_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS long_media_segments (
    job_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    media_input_id TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,
    core_start_us TEXT NOT NULL,
    core_end_us TEXT NOT NULL,
    decode_start_us TEXT NOT NULL,
    decode_end_us TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (job_id, segment_id)
  )
`;

/** A Durable Object holding one long media job and its Container. */
export class LongMediaContainer extends Container<LongMediaEnv> {
  private readonly jobStore: LongMediaJobStore;

  defaultPort = PROBE_PORT;

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
   * Acknowledge a lifecycle action after its platform effect completes.
   * @param revision - The revision that requested the action.
   * @param effect - The completed effect.
   * @returns Whether the effect was pending.
   */
  acknowledgeEffect(revision: number, effect: LongMediaJobEffect): boolean {
    return this.jobStore.acknowledgeEffect(revision, effect);
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
   * Acknowledge a Container action after its platform effect completes.
   * @param epoch - The attempt epoch.
   * @param attemptId - The attempt identity.
   * @param effect - The completed effect.
   * @returns Whether the effect was pending.
   */
  acknowledgeAttemptEffect(epoch: number, attemptId: string, effect: LongMediaAttemptEffect): boolean {
    return this.jobStore.acknowledgeAttemptEffect(epoch, attemptId, effect);
  }

  /**
   * Persist the first source-time plan after checking its complete probe coverage.
   * @param segments - The proposed required-input leaves.
   * @param expectedRevision - The manifest revision the planner observed.
   * @returns The accepted plan revision or a stale/invalid result.
   */
  seedSegmentPlan(segments: readonly LongMediaSegmentPlan[], expectedRevision: number): LongMediaSegmentPlanResult {
    return this.jobStore.seedSegmentPlan(segments, expectedRevision);
  }

  /**
   * Read the durable segment leaves in stable source order.
   * @returns The persisted plan and each leaf's current lifecycle state.
   */
  readSegments(): LongMediaSegmentSnapshot[] {
    return this.jobStore.readSegments();
  }

  /**
   * Compare-and-set one segment lifecycle event by its expected revision.
   * @param segmentId - The durable segment id.
   * @param expectedVersion - The version the event was based on.
   * @param event - The validated event to apply.
   * @returns The new state or a stale/invalid result.
   */
  applySegmentEvent(
    segmentId: string,
    expectedVersion: number,
    event: LongMediaSegmentEvent,
  ): LongMediaSegmentEventResult {
    return this.jobStore.applySegmentEvent(segmentId, expectedVersion, event);
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
  async applyProbeReport(attemptId: string, epoch: number, report: unknown, now: number): Promise<LongMediaProbeApplyResult> {
    const result = this.jobStore.applyProbeReport(attemptId, epoch, report, now);
    if (result.kind === "accepted" && result.lifecycle.effects.includes("stopContainer")) {
      await this.destroy();
    }
    return result;
  }

  /**
   * Persist a failed probe and stop the Container for that attempt.
   * @param attemptId - The producing attempt identity.
   * @param epoch - The attempt epoch.
   * @param now - The event time in epoch milliseconds.
   * @returns The fenced failure result.
   */
  async applyProbeFailure(attemptId: string, epoch: number, now: number): Promise<LongMediaProbeFailureApplyResult> {
    const result = this.jobStore.applyProbeFailure(attemptId, epoch, now);
    if (result.kind === "accepted" && result.lifecycle.effects.includes("stopContainer")) {
      await this.destroy();
    }
    return result;
  }

  /**
   * Start the current durable job's source probe in its Cloudflare Container.
   * @returns The latest job summary, or null when no job exists.
   * @throws {Error} When the source, Container or probe request cannot be started.
   */
  async startProbe(): Promise<LongMediaJobSnapshot | null> {
    let snapshot = this.jobStore.report();
    const request = this.jobStore.request();
    if (snapshot === null || request === null) return null;
    let startRevision: number | null = null;
    if (snapshot.phase === "accepted") {
      startRevision = this.jobStore.transition({ type: "start" }, Date.now())?.snapshot.version ?? null;
      snapshot = this.jobStore.report();
    }
    if (snapshot === null || snapshot.phase !== "probing") return snapshot;
    const now = Date.now();
    const started = this.jobStore.startAttempt(crypto.randomUUID(), now);
    if (started === null) return this.jobStore.report();

    try {
      await this.setOutboundByHosts({
        [MEDIA_OBJECT_HOST]: {
          method: "serveLongMediaSource",
          params: { key: request.source.key, sizeBytes: request.source.sizeBytes },
        },
        [LONG_MEDIA_REPORT_HOST]: {
          method: "acceptLongMediaProbeReport",
          params: {
            attemptId: started.state.attemptId,
            epoch: started.state.epoch,
            sourceFingerprint: request.source.sha256,
            profileVersion: request.profileVersion,
          },
        },
      });
      await this.start();
      this.jobStore.applyAttemptEvent({
        type: "accepted",
        attemptId: started.state.attemptId,
        epoch: started.state.epoch,
      }, Date.now());
      this.jobStore.acknowledgeAttemptEffect(started.state.epoch, started.state.attemptId, "start");
      this.jobStore.transition({ type: "containerStarted" }, Date.now());
      const response = await this.containerFetch(new Request(`http://long-media${LONG_MEDIA_PROBE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectUrl: mediaObjectUrl(request.source.key),
          reportUrl: `http://${LONG_MEDIA_REPORT_HOST}/probe-report`,
          deadlineAt: request.deadlineAt,
        }),
      }), PROBE_PORT);
      await response.body?.cancel();
      if (response.status !== 202) throw new Error(`The long media probe was answered ${response.status}`);
      if (startRevision !== null) this.jobStore.acknowledgeEffect(startRevision, "startProbe");
      return this.jobStore.report();
    } catch (err) {
      this.jobStore.applyAttemptEvent({
        type: "failure",
        attemptId: started.state.attemptId,
        epoch: started.state.epoch,
      }, Date.now());
      this.jobStore.transition({ type: "fatal" }, Date.now());
      this.jobStore.acknowledgeAttemptEffect(started.state.epoch, started.state.attemptId, "start");
      if (startRevision !== null) this.jobStore.acknowledgeEffect(startRevision, "startProbe");
      try {
        await this.destroy();
      } catch (stopError) {
        noteFailure("ingest_long_media_probe_cleanup_failed", { jobId: request.jobId }, stopError);
      }
      noteFailure("ingest_long_media_probe_container_start_failed", { jobId: request.jobId }, err);
      throw err;
    }
  }

  /**
   * Release the persisted container lease after the runtime stops.
   * @param _params - The platform's stop information.
   * @returns Nothing.
   */
  override async onStop(_params: StopParams): Promise<void> {
    const attempt = this.jobStore.latestAttempt();
    if (attempt !== null) {
      this.jobStore.applyAttemptEvent({ type: "stop" }, Date.now());
      this.jobStore.applyAttemptEvent({ type: "gone", attemptId: attempt.attemptId, epoch: attempt.epoch }, Date.now());
      this.jobStore.acknowledgeAttemptEffect(attempt.epoch, attempt.attemptId, "destroy");
    }
    for (const effect of this.jobStore.pendingEffectRecords()) {
      if (effect.effect === "stopContainer" || effect.effect === "checkContainerStopped") {
        this.jobStore.acknowledgeEffect(effect.revision, effect.effect);
      }
    }
    this.jobStore.transition({ type: "stopped" }, Date.now());
    await this.setOutboundByHosts({});
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
   * Acknowledge a lifecycle action after its platform effect completes.
   * @param revision - The revision that requested the action.
   * @param effect - The completed effect.
   * @returns Whether the effect was pending.
   */
  acknowledgeEffect(revision: number, effect: LongMediaJobEffect): boolean {
    return this.jobStore.acknowledgeEffect(revision, effect);
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
   * Acknowledge a Container action after its platform effect completes.
   * @param epoch - The attempt epoch.
   * @param attemptId - The attempt identity.
   * @param effect - The completed effect.
   * @returns Whether the effect was pending.
   */
  acknowledgeAttemptEffect(epoch: number, attemptId: string, effect: LongMediaAttemptEffect): boolean {
    return this.jobStore.acknowledgeAttemptEffect(epoch, attemptId, effect);
  }

  /**
   * Persist the first source-time plan after checking its complete probe coverage.
   * @param segments - The proposed required-input leaves.
   * @param expectedRevision - The manifest revision the planner observed.
   * @returns The accepted plan revision or a stale/invalid result.
   */
  seedSegmentPlan(segments: readonly LongMediaSegmentPlan[], expectedRevision: number): LongMediaSegmentPlanResult {
    return this.jobStore.seedSegmentPlan(segments, expectedRevision);
  }

  /**
   * Read the durable segment leaves in stable source order.
   * @returns The persisted plan and each leaf's current lifecycle state.
   */
  readSegments(): LongMediaSegmentSnapshot[] {
    return this.jobStore.readSegments();
  }

  /**
   * Compare-and-set one segment lifecycle event by its expected revision.
   * @param segmentId - The durable segment id.
   * @param expectedVersion - The version the event was based on.
   * @param event - The validated event to apply.
   * @returns The new state or a stale/invalid result.
   */
  applySegmentEvent(
    segmentId: string,
    expectedVersion: number,
    event: LongMediaSegmentEvent,
  ): LongMediaSegmentEventResult {
    return this.jobStore.applySegmentEvent(segmentId, expectedVersion, event);
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

  /**
   * Persist a probe failure in the protocol test object.
   * @param attemptId - The producing attempt identity.
   * @param epoch - The attempt epoch.
   * @param now - The event time in epoch milliseconds.
   * @returns The fenced failure result.
   */
  applyProbeFailure(attemptId: string, epoch: number, now: number): LongMediaProbeFailureApplyResult {
    return this.jobStore.applyProbeFailure(attemptId, epoch, now);
  }

  /**
   * Mark a submitted job as ready to probe without starting an image in protocol tests.
   * @returns The state transition created for the probe.
   */
  startProbe(): LongMediaTransitionResult | null {
    return this.jobStore.transition({ type: "start" }, Date.now());
  }
}

LongMediaContainer.outboundHandlers = { acceptLongMediaProbeReport, serveLongMediaSource };

/** The committed lifecycle snapshot and requested effects. */
export interface LongMediaTransitionResult {
  snapshot: LongMediaJobSnapshot;
  effects: LongMediaJobEffect[];
}

/** A lifecycle effect tied to the revision that requested it. */
export interface LongMediaJobEffectRecord {
  revision: number;
  effect: LongMediaJobEffect;
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

/** A segment leaf together with its durable transition version. */
export interface LongMediaSegmentSnapshot extends LongMediaSegmentPlan {
  status: LongMediaSegmentStatus;
  version: number;
}

/** Result of seeding the initial complete source-time plan. */
export type LongMediaSegmentPlanResult =
  | { kind: "accepted" | "replayed"; revision: number }
  | { kind: "stale" | "invalid" };

/** Result of applying an expected-version segment lifecycle event. */
export type LongMediaSegmentEventResult =
  | { kind: "accepted"; status: LongMediaSegmentStatus; version: number }
  | { kind: "stale" | "invalid" };

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
    this.ctx.storage.sql.exec(SEGMENT_TABLES);
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
   * Read and verify the immutable request held by this job.
   * @returns The request, or null when no job exists.
   * @throws {Error} When its stored identity is corrupt.
   */
  request(): LongMediaJobRequest | null {
    const row = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
    if (row === undefined) return null;
    const request = readLongMediaJobRequest(JSON.parse(row.request_json) as unknown);
    if (request.jobId !== row.job_id || request.requestDigest !== row.request_digest) {
      throw new Error("The long media job durable identity is inconsistent");
    }
    return request;
  }

  /**
   * Atomically persist the initial segment plan when it covers every measured input.
   * @param segments - The proposed plan.
   * @param expectedRevision - The manifest revision observed by the planner.
   * @returns The accepted revision or a stale/invalid result.
   */
  seedSegmentPlan(
    segments: readonly LongMediaSegmentPlan[],
    expectedRevision: number,
  ): LongMediaSegmentPlanResult {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      const jobState = job === undefined ? null : stateOf(job);
      if (job === undefined || jobState?.phase !== "planning" || Date.now() >= jobState.deadlineAt) return { kind: "stale" };
      const prior = this.ctx.storage.sql.exec<{ revision: number } & Record<string, SqlStorageValue>>(
        "SELECT revision FROM long_media_segment_plans WHERE job_id = ?",
        job.job_id,
      ).toArray()[0];
      if (prior !== undefined) {
        const rows = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
          "SELECT * FROM long_media_segments WHERE job_id = ? ORDER BY media_input_id, core_start_us",
          job.job_id,
        ).toArray();
        return sameSegmentPlan(rows, segments) ? { kind: "replayed", revision: prior.revision } : { kind: "stale" };
      }
      if (expectedRevision !== 0) return { kind: "stale" };
      const probe = this.ctx.storage.sql.exec<LongMediaProbeRow>(
        "SELECT * FROM long_media_probe_facts WHERE job_id = ?",
        job.job_id,
      ).toArray()[0];
      if (probe === undefined) return { kind: "invalid" };
      const report = readLongMediaProbeReport(JSON.parse(probe.report_json) as unknown);
      const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
      if (!isCompleteLongMediaPlan(segments, report, request.limitsSnapshot.maxActiveLeaves)) return { kind: "invalid" };

      this.ctx.storage.sql.exec("INSERT INTO long_media_segment_plans (job_id, revision) VALUES (?, 1)", job.job_id);
      for (const segment of segments) {
        this.ctx.storage.sql.exec(
          `INSERT INTO long_media_segments (
            job_id, segment_id, media_input_id, descriptor_json, core_start_us, core_end_us,
            decode_start_us, decode_end_us, status, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 0)`,
          job.job_id,
          segment.id,
          segment.mediaInputId,
          JSON.stringify(segment.descriptor),
          segment.core.startUs,
          segment.core.endUs,
          segment.decode.startUs,
          segment.decode.endUs,
        );
      }
      return { kind: "accepted", revision: 1 };
    });
  }

  /**
   * Read planned leaves in stable source order.
   * @returns The plan with current states.
   */
  readSegments(): LongMediaSegmentSnapshot[] {
    const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT job_id FROM long_media_jobs LIMIT 1").toArray()[0];
    if (job === undefined) return [];
    const rows = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
      "SELECT * FROM long_media_segments WHERE job_id = ? ORDER BY media_input_id, core_start_us",
      job.job_id,
    ).toArray();
    return rows.map((row) => ({
      id: row.segment_id,
      mediaInputId: row.media_input_id,
      descriptor: JSON.parse(row.descriptor_json) as Record<string, unknown>,
      core: { startUs: row.core_start_us, endUs: row.core_end_us },
      decode: { startUs: row.decode_start_us, endUs: row.decode_end_us },
      status: readLongMediaSegmentStatus(row.status),
      version: row.version,
    }));
  }

  /**
   * Compare-and-set one segment event inside a Durable Object transaction.
   * @param segmentId - The durable segment identity.
   * @param expectedVersion - The version the caller observed.
   * @param event - The lifecycle event.
   * @returns The committed state or a stale/invalid result.
   */
  applySegmentEvent(
    segmentId: string,
    expectedVersion: number,
    event: LongMediaSegmentEvent,
  ): LongMediaSegmentEventResult {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      const row = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        "SELECT * FROM long_media_segments WHERE job_id = ? AND segment_id = ?",
        job?.job_id ?? "",
        segmentId,
      ).toArray()[0];
      if (job === undefined || row === undefined || row.version !== expectedVersion) return { kind: "stale" };
      const jobState = stateOf(job);
      if ((jobState.phase !== "planning" && jobState.phase !== "running") || Date.now() >= jobState.deadlineAt) {
        return { kind: "stale" };
      }
      const current = readLongMediaSegmentStatus(row.status);
      const next = transitionLongMediaSegment(current, event);
      if (next === current) return { kind: "invalid" };
      this.ctx.storage.sql.exec(
        "UPDATE long_media_segments SET status = ?, version = version + 1 WHERE job_id = ? AND segment_id = ? AND version = ?",
        next,
        job.job_id,
        segmentId,
        expectedVersion,
      );
      return { kind: "accepted", status: next, version: expectedVersion + 1 };
    });
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
   * Read pending lifecycle effects with their durable revisions.
   * @returns Pending effects in revision order.
   */
  pendingEffectRecords(): LongMediaJobEffectRecord[] {
    const rows = this.ctx.storage.sql
      .exec<LongMediaEffectRow>("SELECT revision, effect FROM long_media_effects WHERE status = 'pending' ORDER BY revision, effect")
      .toArray();
    return rows.map((row) => ({ revision: row.revision, effect: readEffect(row.effect) }));
  }

  /**
   * Acknowledge one lifecycle side effect after the platform action completes.
   * @param revision - The exact job revision that emitted the effect.
   * @param effect - The action that completed.
   * @returns Whether a pending effect was acknowledged.
   */
  acknowledgeEffect(revision: number, effect: LongMediaJobEffect): boolean {
    const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT job_id FROM long_media_jobs LIMIT 1").toArray()[0];
    if (job === undefined) return false;
    const row = this.ctx.storage.sql.exec<LongMediaEffectRow>(
      "SELECT revision, effect FROM long_media_effects WHERE job_id = ? AND revision = ? AND effect = ? AND status = 'pending'",
      job.job_id,
      revision,
      effect,
    ).toArray()[0];
    if (row === undefined) return false;
    this.ctx.storage.sql.exec(
      "UPDATE long_media_effects SET status = 'done' WHERE job_id = ? AND revision = ? AND effect = ? AND status = 'pending'",
      job.job_id,
      revision,
      effect,
    );
    return true;
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
   * Acknowledge one platform action for its exact attempt fence.
   * @param epoch - The attempt epoch.
   * @param attemptId - The attempt identity.
   * @param effect - The action that completed.
   * @returns Whether a pending effect was acknowledged.
   */
  acknowledgeAttemptEffect(epoch: number, attemptId: string, effect: LongMediaAttemptEffect): boolean {
    const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT job_id FROM long_media_jobs LIMIT 1").toArray()[0];
    if (job === undefined) return false;
    const row = this.ctx.storage.sql.exec<LongMediaAttemptEffectRow>(
      "SELECT epoch, attempt_id, effect FROM long_media_attempt_effects WHERE job_id = ? AND epoch = ? AND attempt_id = ? AND effect = ? AND status = 'pending'",
      job.job_id,
      epoch,
      attemptId,
      effect,
    ).toArray()[0];
    if (row === undefined) return false;
    this.ctx.storage.sql.exec(
      "UPDATE long_media_attempt_effects SET status = 'done' WHERE job_id = ? AND epoch = ? AND attempt_id = ? AND effect = ? AND status = 'pending'",
      job.job_id,
      epoch,
      attemptId,
      effect,
    );
    return true;
  }

  /**
   * Read the newest attempt so a platform stop can close its fence.
   * @returns The attempt, or null when the job has never started a Container.
   */
  latestAttempt(): LongMediaAttemptState | null {
    const row = this.ctx.storage.sql
      .exec<LongMediaAttemptRow>("SELECT * FROM long_media_attempts ORDER BY epoch DESC LIMIT 1")
      .toArray()[0];
    return row === undefined ? null : attemptStateOf(row);
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

  /**
   * Atomically fence a probe failure, terminate its job and request shutdown.
   * @param attemptId - The producing attempt identity.
   * @param epoch - The attempt epoch.
   * @param now - The event time in epoch milliseconds.
   * @returns The fenced failure result.
   */
  applyProbeFailure(attemptId: string, epoch: number, now: number): LongMediaProbeFailureApplyResult {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      const attempt = this.ctx.storage.sql
        .exec<LongMediaAttemptRow>("SELECT * FROM long_media_attempts ORDER BY epoch DESC LIMIT 1")
        .toArray()[0];
      if (job === undefined || attempt === undefined || attempt.attempt_id !== attemptId || attempt.epoch !== epoch ||
          readAttemptPhase(attempt.phase) !== "running") return { kind: "stale" };
      const current = stateOf(job);
      if (current.phase !== "probing") return { kind: "not-probing" };

      const attemptTransition = transitionLongMediaAttempt(attemptStateOf(attempt), { type: "failure", attemptId, epoch });
      if (attemptTransition.state.phase !== attempt.phase) {
        this.ctx.storage.sql.exec(
          "UPDATE long_media_attempts SET phase = ?, updated_at = ? WHERE job_id = ? AND epoch = ? AND attempt_id = ?",
          attemptTransition.state.phase,
          now,
          job.job_id,
          epoch,
          attemptId,
        );
      }
      for (const effect of attemptTransition.effects) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO long_media_attempt_effects (job_id, epoch, attempt_id, effect, status) VALUES (?, ?, ?, ?, 'pending')",
          job.job_id,
          epoch,
          attemptId,
          effect,
        );
      }

      const lifecycle = transitionLongMediaJob(current, { type: "fatal" }, now);
      persistLifecycle(this.ctx, job, lifecycle, now);
      return { kind: "accepted", lifecycle: lifecycleResult(job, lifecycle) };
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
 * Verify that planned leaves exactly and contiguously cover every probed input.
 * @param segments - The proposed segment rows.
 * @param report - The persisted probe authority.
 * @param maxActiveLeaves - The operation-wide leaf ceiling.
 * @returns Whether the plan is complete, bounded, and tied to measured descriptors.
 */
function isCompleteLongMediaPlan(
  segments: readonly LongMediaSegmentPlan[],
  report: LongMediaProbeReport,
  maxActiveLeaves: number,
): boolean {
  if (segments.length === 0 || segments.length > maxActiveLeaves) return false;
  const ids = new Set<string>();
  for (const segment of segments) {
    if (segment.id.length === 0 || ids.has(segment.id)) return false;
    ids.add(segment.id);
    if (!/^(0|-?[1-9]\d*)$/.test(segment.core.startUs) || !/^(0|-?[1-9]\d*)$/.test(segment.core.endUs) ||
        !/^(0|-?[1-9]\d*)$/.test(segment.decode.startUs) || !/^(0|-?[1-9]\d*)$/.test(segment.decode.endUs)) return false;
    const coreStart = BigInt(segment.core.startUs);
    const coreEnd = BigInt(segment.core.endUs);
    if (BigInt(segment.decode.startUs) > coreStart || coreStart >= coreEnd || coreEnd > BigInt(segment.decode.endUs)) return false;
  }

  return report.mediaInputs.every((input) => {
    const leaves = segments.filter((segment) => segment.mediaInputId === input.mediaInputId)
      .toSorted((left, right) => BigInt(left.core.startUs) < BigInt(right.core.startUs) ? -1 : 1);
    if (leaves.length === 0) return false;
    let cursor = BigInt(input.sourceRange.startUs);
    for (const leaf of leaves) {
      if (JSON.stringify(leaf.descriptor) !== JSON.stringify(input.descriptor) || BigInt(leaf.core.startUs) !== cursor ||
          BigInt(leaf.decode.startUs) < BigInt(input.sourceRange.startUs) ||
          BigInt(leaf.decode.endUs) > BigInt(input.sourceRange.endUs)) return false;
      cursor = BigInt(leaf.core.endUs);
    }
    return cursor === BigInt(input.sourceRange.endUs);
  }) && segments.every((segment) => report.mediaInputs.some((input) => input.mediaInputId === segment.mediaInputId));
}

/**
 * Compare a durable plan with the exact request being replayed.
 * @param rows - The persisted leaves.
 * @param segments - The replayed plan.
 * @returns Whether both plans contain the same ordered leaf facts.
 */
function sameSegmentPlan(rows: readonly LongMediaSegmentRow[], segments: readonly LongMediaSegmentPlan[]): boolean {
  if (rows.length !== segments.length) return false;
  return rows.every((row, index) => {
    const segment = segments[index];
    return segment !== undefined && row.segment_id === segment.id && row.media_input_id === segment.mediaInputId &&
      row.descriptor_json === JSON.stringify(segment.descriptor) && row.core_start_us === segment.core.startUs &&
      row.core_end_us === segment.core.endUs && row.decode_start_us === segment.decode.startUs &&
      row.decode_end_us === segment.decode.endUs;
  });
}

/**
 * Read a persisted segment lifecycle state.
 * @param value - The SQL value.
 * @returns The recognized lifecycle state.
 * @throws {Error} When the durable value is unknown.
 */
function readLongMediaSegmentStatus(value: string): LongMediaSegmentStatus {
  if (value === "planned" || value === "encoding" || value === "oversize" || value === "stored" || value === "ready" ||
      value === "superseded" || value === "paused" || value === "failed") return value;
  throw new Error("The long media segment state is invalid");
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
