// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import type { StopParams } from "@cloudflare/containers";
import {
  acceptLongMediaProbeReport,
  acceptLongMediaSegmentReport,
  LONG_MEDIA_REPORT_HOST,
  LONG_MEDIA_SEGMENT_OUTPUT_HOST,
  LONG_MEDIA_SEGMENT_REPORT_HOST,
  serveLongMediaSource,
  writeLongMediaSegment,
} from "@ingest/jobs/long-media-routes.js";
import { mediaObjectUrl, MEDIA_OBJECT_HOST } from "@ingest/media-object-route.js";
import { LONG_MEDIA_PROBE_PATH, LONG_MEDIA_SEGMENT_PATH, PROBE_PORT } from "@ingest/probe-answer.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import { hashStoredObject, sniffStoredObject } from "@ingest/stored-object.js";
import {
  computeLongMediaInputsDigest,
  readLongMediaJobRequest,
  readLongMediaProbeReport,
  readLongMediaPlanRequest,
  type LongMediaJobRequest,
  type LongMediaProbeReport,
  type LongMediaPlanRequest,
} from "@breatic/shared";
import type {
  LongMediaSegmentMeasurement,
  LongMediaSegmentPlan,
  LongMediaSegmentStatus,
  LongMediaSegmentEvent,
} from "@ingest/jobs/long-media-segment.js";
import { transitionLongMediaSegment } from "@ingest/jobs/long-media-segment.js";
import { longMediaSegmentContainerRequest } from "@ingest/jobs/long-media-segment-request.js";
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
  | { kind: "expired" }
  | { kind: "cancelled" };

/** Cancellation acknowledged before its matching submit request reached the Durable Object. */
export interface LongMediaPreSubmitCancellation {
  jobId: string;
  phase: "cancelled";
  beforeSubmit: true;
}

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

/** One durable plan mutation receipt. */
interface LongMediaPlanMutationRow extends Record<string, SqlStorageValue> {
  mutation_id: string;
  payload_digest: string;
  revision: number;
}

/** One persisted logical media leaf. */
interface LongMediaSegmentRow extends Record<string, SqlStorageValue> {
  segment_id: string;
  parent_id: string | null;
  media_input_id: string;
  descriptor_json: string;
  core_start_us: string;
  core_end_us: string;
  decode_start_us: string;
  decode_end_us: string;
  mode: string;
  candidate_id: string | null;
  grant_id: string | null;
  storage_key: string | null;
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

const CANCELLED_BEFORE_SUBMIT_TABLE = `
  CREATE TABLE IF NOT EXISTS long_media_cancelled_before_submit (
    job_id TEXT PRIMARY KEY NOT NULL,
    cancelled_at INTEGER NOT NULL
  )
`;

const PRE_SUBMIT_CANCELLATION_KEY = "longMediaPreSubmitCancellation";

interface LongMediaPreSubmitCancellationDeadline {
  jobId: string;
  deadlineAt: number;
}

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
    revision INTEGER NOT NULL,
    required_inputs_json TEXT NOT NULL DEFAULT '[]',
    required_inputs_digest TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS long_media_plan_mutations (
    job_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (job_id, mutation_id)
  );
  CREATE TABLE IF NOT EXISTS long_media_segments (
    job_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    parent_id TEXT,
    media_input_id TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,
    core_start_us TEXT NOT NULL,
    core_end_us TEXT NOT NULL,
    decode_start_us TEXT NOT NULL,
    decode_end_us TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'prepare',
    candidate_id TEXT,
    grant_id TEXT,
    storage_key TEXT,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (job_id, segment_id)
  );
  CREATE TABLE IF NOT EXISTS long_media_write_permits (
    job_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (job_id, candidate_id),
    UNIQUE (job_id, grant_id),
    UNIQUE (job_id, storage_key)
  );
  CREATE TABLE IF NOT EXISTS long_media_segment_measurements (
    job_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL,
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
   * Read the validated source probe facts needed by the Node planner.
   * @returns The report, or null until the current source probe is accepted.
   */
  probeReport(): LongMediaProbeReport | null {
    return this.jobStore.probeReport();
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
   * Cancel this durable job and stop its active Container before returning.
   * @param jobId - The immutable Durable Object identity from the route.
   * @returns The latest job state or a marker for cancellation before submit.
   * @throws {Error} When the job disappears during cancellation or its durable state is missing.
   */
  async cancel(jobId: string, deadlineAt: number): Promise<LongMediaJobSnapshot | LongMediaPreSubmitCancellation> {
    const now = Date.now();
    const transition = this.jobStore.cancel(jobId, now, deadlineAt);
    if ("beforeSubmit" in transition) {
      if (deadlineAt > now) {
        const marker = { jobId, deadlineAt };
        await this.ctx.storage.put(PRE_SUBMIT_CANCELLATION_KEY, marker);
        try {
          this.deleteSchedules("expirePreSubmitCancellation");
          await this.schedule(new Date(deadlineAt), "expirePreSubmitCancellation", marker);
        } catch (err) {
          await this.ctx.storage.setAlarm(deadlineAt);
          throw err;
        }
      }
      return transition;
    }
    if (transition.effects.includes("stopContainer")) {
      await this.destroy();
    } else if (transition.snapshot.phase === "stopping") {
      this.jobStore.transition({ type: "stopped" }, Date.now());
    }
    const snapshot = this.jobStore.report();
    if (snapshot === null) throw new Error("The cancelled long-media job is missing its durable state.");
    return snapshot;
  }

  /**
   * Remove a pre-submit cancellation after its exact deadline.
   * @param payload - The tombstoned job identity and its absolute deadline.
   * @returns Nothing after its tombstone is removed or the callback is safely rescheduled.
   */
  async expirePreSubmitCancellation(payload: { jobId: string; deadlineAt: number }): Promise<void> {
    if (Date.now() < payload.deadlineAt) {
      await this.schedule(
        new Date(Math.ceil(payload.deadlineAt / 1_000) * 1_000),
        "expirePreSubmitCancellation",
        payload,
      );
      return;
    }
    await this.schedule(new Date(Date.now() + 60_000), "expirePreSubmitCancellation", payload);
    this.jobStore.expirePreSubmitCancellation(payload.jobId);
    this.deleteSchedules("expirePreSubmitCancellation");
  }

  /**
   * Reconcile the durable cancellation deadline after Container alarm processing.
   * @param alarmProps - Cloudflare's alarm retry metadata.
   * @returns Nothing after the marker is cleaned or its alarm is restored.
   */
  override async alarm(alarmProps?: Parameters<Container<LongMediaEnv>["alarm"]>[0]): Promise<void> {
    try {
      await super.alarm(alarmProps);
    } finally {
      const marker = await this.ctx.storage.get<LongMediaPreSubmitCancellationDeadline>(PRE_SUBMIT_CANCELLATION_KEY);
      if (marker !== undefined) {
        if (Date.now() >= marker.deadlineAt) {
          this.jobStore.expirePreSubmitCancellation(marker.jobId);
          this.deleteSchedules("expirePreSubmitCancellation");
          await this.ctx.storage.delete(PRE_SUBMIT_CANCELLATION_KEY);
        } else {
          const schedules = await this.listSchedules<LongMediaPreSubmitCancellationDeadline>(
            "expirePreSubmitCancellation",
          );
          if (!schedules.some((schedule) => schedule.payload?.jobId === marker.jobId)) {
            await this.schedule(
              new Date(Math.ceil(marker.deadlineAt / 1_000) * 1_000),
              "expirePreSubmitCancellation",
              marker,
            );
          } else {
            const alarmAt = await this.ctx.storage.getAlarm();
            if (alarmAt === null || alarmAt === undefined) {
              await this.ctx.storage.setAlarm(Math.ceil(marker.deadlineAt / 1_000) * 1_000);
            }
          }
        }
      }
    }
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
   * Apply one versioned, per-input plan mutation and its exact write grants.
   * @param value - The untrusted Node plan mutation.
   * @returns The persisted revision or a replay/conflict result.
   */
  applyLongMediaPlan(value: unknown): Promise<LongMediaPlanMutationResult> {
    return this.jobStore.applyLongMediaPlan(value);
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
   * Read a pending exact-key write authorization for one running segment.
   * @param storageKey - The candidate output key named by the Container.
   * @returns Its current write permit, or null when the key is not authorized.
   */
  segmentWritePermit(storageKey: string): LongMediaSegmentWritePermit | null {
    return this.jobStore.segmentWritePermit(storageKey);
  }

  /**
   * Atomically consume one exact-key write grant before accepting output bytes.
   * @param storageKey - The Container-requested output key.
   * @returns The claimed grant, or null when absent, stale, or already claimed.
   */
  claimSegmentWritePermit(storageKey: string): LongMediaSegmentWritePermit | null {
    return this.jobStore.claimSegmentWritePermit(storageKey);
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
   * Apply a callback to one segment at its current persisted revision.
   * @param segmentId - The durable segment identity.
   * @param event - The lifecycle event.
   * @returns The committed state or stale/invalid result.
   */
  applyCurrentSegmentEvent(segmentId: string, event: LongMediaSegmentEvent): LongMediaSegmentEventResult {
    return this.jobStore.applyCurrentSegmentEvent(segmentId, event);
  }

  /**
   * Start or continue encoding every currently planned source-time segment.
   * @returns The current job snapshot, or null when its plan is not runnable.
   * @throws {Error} When the Container or any segment request cannot be started.
   */
  async startMediaSegments(): Promise<LongMediaJobSnapshot | null> {
    const transition = this.jobStore.transition({ type: "planAck", hasRunnableSegments: true }, Date.now());
    if (transition === null || transition.snapshot.phase !== "running") return this.jobStore.report();
    const job = this.jobStore.request();
    if (job === null) return null;
    const planned = this.jobStore.readSegments().some((segment) =>
      segment.storageKey !== null && (segment.status === "planned" || segment.status === "paused"));
    if (!planned) return this.jobStore.report();

    let attempt = this.jobStore.latestAttempt();
    let startedRevision: number | null = null;
    const needsContainer = attempt?.phase !== "running";
    if (attempt === null || attempt.phase === "stopped" || attempt.phase === "lost") {
      const start = this.jobStore.startAttempt(crypto.randomUUID(), Date.now());
      if (start === null) return this.jobStore.report();
      attempt = start.state;
      startedRevision = transition.snapshot.version;
    }
    if (attempt === null || attempt.phase === "stopping") return this.jobStore.report();

    try {
      await this.setOutboundByHosts({
        [MEDIA_OBJECT_HOST]: {
          method: "serveLongMediaSource",
          params: { key: job.source.key, sizeBytes: job.source.sizeBytes },
        },
        [LONG_MEDIA_SEGMENT_OUTPUT_HOST]: {
          method: "writeLongMediaSegment",
          params: { jobId: job.jobId },
        },
        [LONG_MEDIA_SEGMENT_REPORT_HOST]: {
          method: "acceptLongMediaSegmentReport",
          params: { jobId: job.jobId },
        },
      });
      if (needsContainer) {
        await this.start();
        if (attempt.phase === "starting") {
          this.jobStore.applyAttemptEvent({
            type: "accepted",
            attemptId: attempt.attemptId,
            epoch: attempt.epoch,
          }, Date.now());
          this.jobStore.acknowledgeAttemptEffect(attempt.epoch, attempt.attemptId, "start");
          this.jobStore.transition({ type: "containerStarted" }, Date.now());
        }
      }

      const runnable = this.jobStore.markPlannedSegmentsEncoding(job.limitsSnapshot.maxConcurrentSegments);
      for (const segment of runnable) {
        const request = longMediaSegmentContainerRequest(job, segment, {
          output: LONG_MEDIA_SEGMENT_OUTPUT_HOST,
          report: LONG_MEDIA_SEGMENT_REPORT_HOST,
        });
        const response = await this.containerFetch(new Request(`http://long-media${LONG_MEDIA_SEGMENT_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }), PROBE_PORT);
        await response.body?.cancel();
        if (response.status !== 202) throw new Error(`The long media segment was answered ${response.status}`);
      }
      if (startedRevision !== null) this.jobStore.acknowledgeEffect(startedRevision, "startMediaAttempt");
      return this.jobStore.report();
    } catch (err) {
      this.jobStore.applyAttemptEvent({ type: "failure", attemptId: attempt.attemptId, epoch: attempt.epoch }, Date.now());
      this.jobStore.transition({ type: "fatal" }, Date.now());
      if (startedRevision !== null) this.jobStore.acknowledgeEffect(startedRevision, "startMediaAttempt");
      try {
        await this.destroy();
      } catch (stopError) {
        noteFailure("ingest_long_media_segment_cleanup_failed", { jobId: job.jobId }, stopError);
      }
      noteFailure("ingest_long_media_segment_container_start_failed", { jobId: job.jobId }, err);
      throw err;
    }
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
    const snapshot = this.jobStore.report();
    if (snapshot !== null && (snapshot.phase === "planning" || snapshot.phase === "running") &&
      snapshot.terminalIntent === null) {
      await this.recoverInterruptedSegments(snapshot.jobId);
    }
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

  /**
   * Reconcile segment writes interrupted by a Container stop.
   * @param jobId - The live durable job identity.
   * @returns Nothing after completed objects are measured and unfinished writes are retryable.
   * @throws {Error} When R2 or durable state cannot be reconciled.
   */
  private async recoverInterruptedSegments(jobId: string): Promise<void> {
    for (const segment of this.jobStore.readSegments()) {
      if (segment.status !== "encoding" || segment.storageKey === null) continue;
      const permit = this.jobStore.prepareSegmentWriteRecovery(segment.id);
      if (permit === null) continue;
      const stored = await this.env.BUCKET.head(permit.storageKey);
      if (stored === null) {
        this.jobStore.applyCurrentSegmentEvent(segment.id, { type: "transient" });
        continue;
      }
      const contentType = await sniffStoredObject(this.env.BUCKET, permit.storageKey);
      if (!contentType.startsWith(`${permit.mediaKind}/`) || stored.size > permit.maxBytes) {
        noteFailure("ingest_long_media_segment_recovery_invalid", { jobId, segmentId: segment.id });
        this.jobStore.applyCurrentSegmentEvent(segment.id, { type: "fatal" });
        continue;
      }
      const measured = {
        sha256: await hashStoredObject(this.env.BUCKET, permit.storageKey),
        sizeBytes: stored.size,
        contentType,
      };
      this.jobStore.applyCurrentSegmentEvent(segment.id, { type: "measured", measured });
    }
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
   * Read the validated source probe facts needed by the Node planner.
   * @returns The report, or null until the current source probe is accepted.
   */
  probeReport(): LongMediaProbeReport | null {
    return this.jobStore.probeReport();
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
   * Apply one versioned, per-input plan mutation and its exact write grants.
   * @param value - The untrusted Node plan mutation.
   * @returns The persisted revision or a replay/conflict result.
   */
  applyLongMediaPlan(value: unknown): Promise<LongMediaPlanMutationResult> {
    return this.jobStore.applyLongMediaPlan(value);
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
   * Move grant-backed planned or paused segments into encoding up to the job limit.
   * @returns The segments whose output requests may be sent to the Container.
   */
  markPlannedSegmentsEncoding(): LongMediaSegmentSnapshot[] {
    const job = this.jobStore.request();
    if (job === null) return [];
    return this.jobStore.markPlannedSegmentsEncoding(job.limitsSnapshot.maxConcurrentSegments);
  }

  /**
   * Read a pending exact-key write authorization for one running segment.
   * @param storageKey - The candidate output key named by the Container.
   * @returns Its current write permit, or null when the key is not authorized.
   */
  segmentWritePermit(storageKey: string): LongMediaSegmentWritePermit | null {
    return this.jobStore.segmentWritePermit(storageKey);
  }

  /**
   * Atomically claim one pending output permit so concurrent PUTs cannot race on its R2 key.
   * @param storageKey - The exact authorized output key.
   * @returns The grant only to the caller that changed it from pending to writing.
   */
  claimSegmentWritePermit(storageKey: string): LongMediaSegmentWritePermit | null {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      if (job === undefined) return null;
      const state = stateOf(job);
      if ((state.phase !== "planning" && state.phase !== "running") || Date.now() >= state.deadlineAt) return null;
      const row = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        `SELECT segment.* FROM long_media_segments AS segment
         JOIN long_media_write_permits AS permit
           ON permit.job_id = segment.job_id AND permit.segment_id = segment.segment_id
         WHERE segment.job_id = ? AND segment.storage_key = ?
           AND segment.status = 'encoding' AND permit.status = 'pending'`,
        job.job_id, storageKey,
      ).toArray()[0];
      if (row === undefined || row.storage_key === null) return null;
      const descriptor = JSON.parse(row.descriptor_json) as Record<string, unknown>;
      if (descriptor.mediaKind !== "audio" && descriptor.mediaKind !== "video") {
        throw new Error("The persisted long media segment has an invalid media kind");
      }
      const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
      const changed = this.ctx.storage.sql.exec(
        `UPDATE long_media_write_permits SET status = 'writing'
         WHERE job_id = (SELECT job_id FROM long_media_jobs LIMIT 1)
           AND segment_id = ? AND status = 'pending'`,
        row.segment_id,
      );
      return changed.rowsWritten === 1 ? {
        segmentId: row.segment_id,
        storageKey: row.storage_key,
        expectedVersion: row.version,
        maxBytes: request.limitsSnapshot.maxSegmentBytes,
        mediaKind: descriptor.mediaKind,
      } : null;
    });
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
   * Apply a callback to one segment at its current persisted revision.
   * @param segmentId - The durable segment identity.
   * @param event - The lifecycle event.
   * @returns The committed state or stale/invalid result.
   */
  applyCurrentSegmentEvent(segmentId: string, event: LongMediaSegmentEvent): LongMediaSegmentEventResult {
    return this.jobStore.applyCurrentSegmentEvent(segmentId, event);
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
   * Cancel this protocol test job without starting a platform Container.
   * @param jobId - The immutable Durable Object identity from the route.
   * @returns The latest job state or a marker for cancellation before submit.
   * @throws {Error} When the job disappears during cancellation or its durable state is missing.
   */
  async cancel(jobId: string, deadlineAt: number): Promise<LongMediaJobSnapshot | LongMediaPreSubmitCancellation> {
    const now = Date.now();
    const transition = this.jobStore.cancel(jobId, now, deadlineAt);
    if ("beforeSubmit" in transition && deadlineAt > now) {
      await this.ctx.storage.put("cancelledBeforeSubmitJobId", jobId);
      await this.ctx.storage.put("cancelledBeforeSubmitDeadlineAt", deadlineAt);
      await this.ctx.storage.setAlarm(deadlineAt);
    }
    if ("beforeSubmit" in transition) return transition;
    if (transition.snapshot.phase === "stopping") this.jobStore.transition({ type: "stopped" }, Date.now());
    const snapshot = this.jobStore.report();
    if (snapshot === null) throw new Error("The cancelled long-media job is missing its durable state.");
    return snapshot;
  }

  /**
   * Clear the protocol test object's tombstone after its alarm deadline.
   * @returns Nothing after that marker and its stored alarm key are removed.
   */
  override async alarm(): Promise<void> {
    const jobId = await this.ctx.storage.get<string>("cancelledBeforeSubmitJobId");
    const deadlineAt = await this.ctx.storage.get<number>("cancelledBeforeSubmitDeadlineAt");
    if (jobId !== undefined && deadlineAt !== undefined && Date.now() < deadlineAt) {
      await this.ctx.storage.setAlarm(deadlineAt);
      return;
    }
    if (jobId !== undefined) this.jobStore.expirePreSubmitCancellation(jobId);
    await this.ctx.storage.delete("cancelledBeforeSubmitJobId");
    await this.ctx.storage.delete("cancelledBeforeSubmitDeadlineAt");
  }

  /**
   * Mark a submitted job as ready to probe without starting an image in protocol tests.
   * @returns The state transition created for the probe.
   */
  startProbe(): LongMediaTransitionResult | null {
    return this.jobStore.transition({ type: "start" }, Date.now());
  }

  /**
   * Exercise the durable segment-run transition without launching a platform Container.
   * @returns The updated job snapshot, or null when no complete plan is runnable.
   */
  startMediaSegments(): LongMediaJobSnapshot | null {
    const transition = this.jobStore.transition({ type: "planAck", hasRunnableSegments: true }, Date.now());
    if (transition === null || transition.snapshot.phase !== "running") return this.jobStore.report();
    this.markPlannedSegmentsEncoding();
    return this.jobStore.report();
  }
}

LongMediaContainer.outboundHandlers = {
  acceptLongMediaProbeReport,
  acceptLongMediaSegmentReport,
  serveLongMediaSource,
  writeLongMediaSegment,
};

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
  grantId: string | null;
  storageKey: string | null;
  measured: LongMediaSegmentMeasurement | null;
  status: LongMediaSegmentStatus;
  version: number;
}

/** Exact durable authorization for a Container segment output write. */
export interface LongMediaSegmentWritePermit {
  segmentId: string;
  storageKey: string;
  expectedVersion: number;
  maxBytes: number;
  mediaKind: "audio" | "video";
}

/** Result of seeding the initial complete source-time plan. */
export type LongMediaSegmentPlanResult =
  | { kind: "accepted" | "replayed"; revision: number }
  | { kind: "stale" | "invalid" };

/** Result of applying one idempotent, versioned plan mutation. */
export type LongMediaPlanMutationResult =
  | { kind: "accepted" | "replayed"; revision: number; complete: boolean }
  | { kind: "stale" | "conflict" | "invalid" };

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
    this.initialize();
  }

  /**
   * Delete one pre-submit cancellation marker after its absolute deadline.
   * @param jobId - The cancelled job identity whose late submit is no longer possible.
   * @returns Nothing after its tombstone row is removed.
   */
  expirePreSubmitCancellation(jobId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM long_media_cancelled_before_submit WHERE job_id = ?", jobId);
  }

  /**
   * Ensure the Durable Object job tables exist.
   * @returns Nothing after the schema is ready for protocol requests.
   */
  initialize(): void {
    this.ctx.storage.sql.exec(JOB_TABLE);
    this.ctx.storage.sql.exec(CANCELLED_BEFORE_SUBMIT_TABLE);
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
      const cancelled = this.ctx.storage.sql.exec(
        "SELECT job_id FROM long_media_cancelled_before_submit WHERE job_id = ?",
        request.jobId,
      ).toArray()[0];
      if (cancelled !== undefined) return { row: null, replayed: false, cancelled: true };
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

    if (result.row === null) {
      if (result.cancelled === true) return { kind: "cancelled" };
      return { kind: result.expired === true ? "expired" : "conflict" };
    }
    return { kind: result.replayed ? "replayed" : "accepted", snapshot: snapshotOf(result.row) };
  }

  /**
   * Cancel an existing job or persist a tombstone so a late submit cannot start it.
   * @param jobId - The immutable job identity.
   * @param now - The cancellation time in epoch milliseconds.
   * @returns The job transition or a before-submit cancellation marker.
   * @throws {Error} When a persisted job disappears during the transition.
   */
  cancel(jobId: string, now: number, deadlineAt: number): LongMediaTransitionResult | LongMediaPreSubmitCancellation {
    const row = this.ctx.storage.sql.exec<LongMediaJobRow>(
      "SELECT * FROM long_media_jobs WHERE job_id = ?",
      jobId,
    ).toArray()[0];
    if (row !== undefined) {
      const transition = this.transition({ type: "cancel" }, now);
      if (transition === null) throw new Error("The long-media job disappeared during cancellation.");
      return transition;
    }
    if (deadlineAt > now) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO long_media_cancelled_before_submit (job_id, cancelled_at) VALUES (?, ?)",
          jobId,
          now,
        );
      });
    }
    return { jobId, phase: "cancelled", beforeSubmit: true };
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
   * Read and revalidate the accepted probe report for this job.
   * @returns The report, or null until a probe report has been persisted.
   */
  probeReport(): LongMediaProbeReport | null {
    const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
    if (job === undefined) return null;
    const row = this.ctx.storage.sql.exec<LongMediaProbeRow>(
      "SELECT * FROM long_media_probe_facts WHERE job_id = ?",
      job.job_id,
    ).toArray()[0];
    if (row === undefined) return null;
    const report = readLongMediaProbeReport(JSON.parse(row.report_json) as unknown);
    const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
    if (report.sourceFingerprint !== request.source.sha256) {
      throw new Error("The persisted long media probe report does not match its source.");
    }
    return report;
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
   * Apply one idempotent plan mutation for a single probed media input.
   * @param value - The untrusted plan mutation.
   * @returns The accepted revision, replay, or rejection.
   * @throws {Error} When durable probe facts are corrupt.
   */
  async applyLongMediaPlan(value: unknown): Promise<LongMediaPlanMutationResult> {
    const plan = readLongMediaPlanRequest(value);
    const planDigest = await digestPlanPayload(plan);
    const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
    if (job === undefined) return { kind: "stale" };
    const probe = this.ctx.storage.sql.exec<LongMediaProbeRow>(
      "SELECT * FROM long_media_probe_facts WHERE job_id = ?", job.job_id,
    ).toArray()[0];
    if (probe === undefined) return { kind: "invalid" };
    const report = readLongMediaProbeReport(JSON.parse(probe.report_json) as unknown);
    const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
    const requiredInputsDigest = await computeLongMediaInputsDigest(
      request.source.sha256,
      request.profileVersion,
      report.mediaInputs,
    );
    if (plan.requiredMediaInputsDigest !== requiredInputsDigest ||
        JSON.stringify(plan.requiredMediaInputs) !== JSON.stringify(report.mediaInputs)) return { kind: "invalid" };

    return this.ctx.storage.transactionSync(() => {
      const currentJob = this.ctx.storage.sql.exec<LongMediaJobRow>(
        "SELECT * FROM long_media_jobs WHERE job_id = ?", job.job_id,
      ).toArray()[0];
      if (currentJob === undefined) return { kind: "stale" };
      const state = stateOf(currentJob);
      if (state.phase !== "planning" || Date.now() >= state.deadlineAt) return { kind: "stale" };
      const duplicate = this.ctx.storage.sql.exec<LongMediaPlanMutationRow>(
        "SELECT * FROM long_media_plan_mutations WHERE job_id = ? AND mutation_id = ?",
        job.job_id, plan.mutationId,
      ).toArray()[0];
      if (duplicate !== undefined) {
        return duplicate.payload_digest === planDigest
          ? { kind: "replayed", revision: duplicate.revision, complete: this.rootPlanComplete(job.job_id) }
          : { kind: "conflict" };
      }
      const manifest = this.ctx.storage.sql.exec<{
        revision: number; required_inputs_json: string; required_inputs_digest: string;
      } & Record<string, SqlStorageValue>>(
        "SELECT * FROM long_media_segment_plans WHERE job_id = ?", job.job_id,
      ).toArray()[0];
      const revision = manifest?.revision ?? 0;
      if (plan.expectedVersion !== revision) return { kind: "stale" };
      if (manifest !== undefined && (manifest.required_inputs_json !== JSON.stringify(plan.requiredMediaInputs) ||
          manifest.required_inputs_digest !== plan.requiredMediaInputsDigest)) return { kind: "conflict" };
      const input = report.mediaInputs.find((item) => item.mediaInputId === plan.mediaInputId);
      if (input === undefined) return { kind: "invalid" };
      const parent = plan.parentId === null ? undefined : this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        "SELECT * FROM long_media_segments WHERE job_id = ? AND segment_id = ?",
        job.job_id, plan.parentId,
      ).toArray()[0];
      if (plan.parentId !== null && (parent === undefined || parent.media_input_id !== plan.mediaInputId ||
          readLongMediaSegmentStatus(parent.status) !== "oversize")) return { kind: "conflict" };
      if (plan.parentId === null) {
        const existing = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
          "SELECT * FROM long_media_segments WHERE job_id = ? AND media_input_id = ?",
          job.job_id, plan.mediaInputId,
        ).toArray();
        if (existing.length > 0) return { kind: "conflict" };
      }
      const intervals = [...plan.intervals].sort((left, right) => BigInt(left.core.startUs) < BigInt(right.core.startUs) ? -1 : 1);
      const targetRange = parent === undefined
        ? input.sourceRange
        : { startUs: parent.core_start_us, endUs: parent.core_end_us };
      if (!intervalsCoverRange(intervals, targetRange.startUs, targetRange.endUs)) return { kind: "invalid" };
      if (intervals.some((item) => BigInt(item.decode.startUs) < BigInt(input.sourceRange.startUs) ||
          BigInt(item.decode.endUs) > BigInt(input.sourceRange.endUs))) return { kind: "invalid" };
      const existingIds = new Set(this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        "SELECT * FROM long_media_segments WHERE job_id = ?", job.job_id,
      ).toArray().map((row) => row.segment_id));
      const existingPermits = this.ctx.storage.sql.exec<{
        candidate_id: string; grant_id: string; storage_key: string;
      } & Record<string, SqlStorageValue>>(
        "SELECT candidate_id, grant_id, storage_key FROM long_media_write_permits WHERE job_id = ?", job.job_id,
      ).toArray();
      if (plan.intervals.some((item) => {
        const grant = plan.grants.find((candidate) => candidate.segmentId === item.id);
        return existingIds.has(item.id) || (item.mode === "prepare" && (grant === undefined || existingPermits.some((permit) =>
          permit.candidate_id === grant.candidateId || permit.grant_id === grant.grantId || permit.storage_key === grant.storageKey)));
      })) return { kind: "conflict" };
      const count = this.ctx.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
        "SELECT COUNT(*) AS count FROM long_media_segments WHERE job_id = ? AND status != 'superseded'", job.job_id,
      ).one().count;
      if (count - (parent === undefined ? 0 : 1) + intervals.length > request.limitsSnapshot.maxActiveLeaves) return { kind: "invalid" };
      if (manifest === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO long_media_segment_plans (job_id, revision, required_inputs_json, required_inputs_digest) VALUES (?, 0, ?, ?)",
          job.job_id, JSON.stringify(plan.requiredMediaInputs), plan.requiredMediaInputsDigest,
        );
      }
      if (parent !== undefined) {
        const superseded = transitionLongMediaSegment(readLongMediaSegmentStatus(parent.status), { type: "split" });
        if (superseded !== "superseded") return { kind: "conflict" };
        this.ctx.storage.sql.exec(
          "UPDATE long_media_segments SET status = ?, version = version + 1 WHERE job_id = ? AND segment_id = ? AND version = ?",
          superseded, job.job_id, parent.segment_id, parent.version,
        );
      }
      for (const item of intervals) {
        const grant = plan.grants.find((candidate) => candidate.segmentId === item.id);
        if (item.mode === "prepare" && grant === undefined) return { kind: "invalid" };
        this.ctx.storage.sql.exec(
          `INSERT INTO long_media_segments (
            job_id, segment_id, parent_id, media_input_id, descriptor_json, core_start_us, core_end_us,
            decode_start_us, decode_end_us, mode, candidate_id, grant_id, storage_key, status, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          job.job_id, item.id, plan.parentId, item.mediaInputId, JSON.stringify(item.descriptor), item.core.startUs,
          item.core.endUs, item.decode.startUs, item.decode.endUs, item.mode,
          grant?.candidateId ?? null, grant?.grantId ?? null, grant?.storageKey ?? null,
          item.mode === "adopt" ? "ready" : "planned", 0,
        );
        if (grant !== undefined) {
          this.ctx.storage.sql.exec(
            "INSERT INTO long_media_write_permits (job_id, candidate_id, segment_id, grant_id, storage_key, status) VALUES (?, ?, ?, ?, ?, 'pending')",
            job.job_id, grant.candidateId, item.id, grant.grantId, grant.storageKey,
          );
        }
      }
      const nextRevision = revision + 1;
      this.ctx.storage.sql.exec("UPDATE long_media_segment_plans SET revision = ? WHERE job_id = ?", nextRevision, job.job_id);
      this.ctx.storage.sql.exec(
        "INSERT INTO long_media_plan_mutations (job_id, mutation_id, payload_digest, revision) VALUES (?, ?, ?, ?)",
        job.job_id, plan.mutationId, planDigest, nextRevision,
      );
      return { kind: "accepted", revision: nextRevision, complete: this.rootPlanComplete(job.job_id) };
    });
  }

  /**
   * Check whether every frozen input has contiguous root coverage.
   * @param jobId - The durable job identity.
   * @returns Whether all required input ranges have planned leaves.
   */
  private rootPlanComplete(jobId: string): boolean {
    const manifest = this.ctx.storage.sql.exec<{
      required_inputs_json: string;
    } & Record<string, SqlStorageValue>>(
      "SELECT required_inputs_json FROM long_media_segment_plans WHERE job_id = ?", jobId,
    ).toArray()[0];
    if (manifest === undefined) return false;
    const requiredInputs = JSON.parse(manifest.required_inputs_json) as LongMediaPlanRequest["requiredMediaInputs"];
    return requiredInputs.every((input) => {
      const rows = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        "SELECT * FROM long_media_segments WHERE job_id = ? AND media_input_id = ? AND status != 'superseded' ORDER BY core_start_us",
        jobId, input.mediaInputId,
      ).toArray();
      return intervalsCoverRange(rows.map((row) => ({ core: { startUs: row.core_start_us, endUs: row.core_end_us } })),
        input.sourceRange.startUs, input.sourceRange.endUs);
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
    const measurements = this.ctx.storage.sql.exec<{
      segment_id: string; sha256: string; size_bytes: number; content_type: string;
    } & Record<string, SqlStorageValue>>(
      "SELECT segment_id, sha256, size_bytes, content_type FROM long_media_segment_measurements WHERE job_id = ?",
      job.job_id,
    ).toArray();
    const bySegment = new Map(measurements.map((row) => [row.segment_id, row]));
    return rows.map((row) => {
      const measured = bySegment.get(row.segment_id);
      return ({
      id: row.segment_id,
      mediaInputId: row.media_input_id,
      descriptor: JSON.parse(row.descriptor_json) as Record<string, unknown>,
      core: { startUs: row.core_start_us, endUs: row.core_end_us },
      decode: { startUs: row.decode_start_us, endUs: row.decode_end_us },
      grantId: row.grant_id,
      storageKey: row.storage_key,
      measured: measured === undefined ? null : {
        sha256: measured.sha256,
        sizeBytes: measured.size_bytes,
        contentType: measured.content_type,
      },
      status: readLongMediaSegmentStatus(row.status),
      version: row.version,
      });
    });
  }

  /**
   * Move grant-backed planned or paused segments into encoding up to the frozen limit.
   * @param maxConcurrentSegments - The frozen encoder concurrency ceiling.
   * @returns The segments whose output requests may be sent to the Container.
   */
  markPlannedSegmentsEncoding(maxConcurrentSegments: number): LongMediaSegmentSnapshot[] {
    const started: LongMediaSegmentSnapshot[] = [];
    const activeCount = this.readSegments().filter((segment) => segment.status === "encoding").length;
    let available = Math.max(0, maxConcurrentSegments - activeCount);
    if (available === 0) return started;
    for (const segment of this.readSegments()) {
      if (available === 0) break;
      if (segment.storageKey === null || (segment.status !== "planned" && segment.status !== "paused")) continue;
      let current = segment;
      if (current.status === "paused") {
        const resumed = this.applySegmentEvent(current.id, current.version, { type: "resume", checkpoint: "planned" });
        if (resumed.kind !== "accepted") continue;
        current = this.readSegments().find((item) => item.id === segment.id) ?? current;
      }
      if (current.status !== "planned") continue;
      const result = this.applySegmentEvent(current.id, current.version, { type: "run" });
      if (result.kind !== "accepted") continue;
      const encoding = this.readSegments().find((item) => item.id === segment.id);
      if (encoding !== undefined && encoding.status === "encoding") {
        started.push(encoding);
        available -= 1;
      }
    }
    return started;
  }

  /**
   * Read a pending exact-key write authorization for one running segment.
   * @param storageKey - The candidate output key named by the Container.
   * @returns Its current write permit, or null when the key is not authorized.
   */
  segmentWritePermit(storageKey: string): LongMediaSegmentWritePermit | null {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      if (job === undefined) return null;
      const state = stateOf(job);
      if ((state.phase !== "planning" && state.phase !== "running") || Date.now() >= state.deadlineAt) return null;
      const row = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        `SELECT segment.* FROM long_media_segments AS segment
         JOIN long_media_write_permits AS permit
           ON permit.job_id = segment.job_id AND permit.segment_id = segment.segment_id
         WHERE segment.job_id = ? AND segment.storage_key = ?
           AND segment.status = 'encoding' AND permit.status = 'pending'`,
        job.job_id,
        storageKey,
      ).toArray()[0];
      if (row === undefined) return null;
      const descriptor = JSON.parse(row.descriptor_json) as Record<string, unknown>;
      if (descriptor.mediaKind !== "audio" && descriptor.mediaKind !== "video") {
        throw new Error("The persisted long media segment has an invalid media kind");
      }
      const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
      return {
        segmentId: row.segment_id,
        storageKey: row.storage_key ?? storageKey,
        expectedVersion: row.version,
        maxBytes: request.limitsSnapshot.maxSegmentBytes,
        mediaKind: descriptor.mediaKind,
      };
    });
  }

  /**
   * Atomically claim one pending output permit so concurrent PUTs cannot race on its R2 key.
   * @param storageKey - The exact authorized output key.
   * @returns The grant only to the caller that changed it from pending to writing.
   */
  claimSegmentWritePermit(storageKey: string): LongMediaSegmentWritePermit | null {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      if (job === undefined) return null;
      const state = stateOf(job);
      if ((state.phase !== "planning" && state.phase !== "running") || Date.now() >= state.deadlineAt) return null;
      const row = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        `SELECT segment.* FROM long_media_segments AS segment
         JOIN long_media_write_permits AS permit
           ON permit.job_id = segment.job_id AND permit.segment_id = segment.segment_id
         WHERE segment.job_id = ? AND segment.storage_key = ?
           AND segment.status = 'encoding' AND permit.status = 'pending'`,
        job.job_id, storageKey,
      ).toArray()[0];
      if (row === undefined || row.storage_key === null) return null;
      const descriptor = JSON.parse(row.descriptor_json) as Record<string, unknown>;
      if (descriptor.mediaKind !== "audio" && descriptor.mediaKind !== "video") {
        throw new Error("The persisted long media segment has an invalid media kind");
      }
      const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
      const changed = this.ctx.storage.sql.exec(
        `UPDATE long_media_write_permits SET status = 'writing'
         WHERE job_id = ? AND segment_id = ? AND status = 'pending'`,
        job.job_id, row.segment_id,
      );
      return changed.rowsWritten === 1 ? {
        segmentId: row.segment_id,
        storageKey: row.storage_key,
        expectedVersion: row.version,
        maxBytes: request.limitsSnapshot.maxSegmentBytes,
        mediaKind: descriptor.mediaKind,
      } : null;
    });
  }

  /**
   * Reclaim one interrupted segment's output authority for durable-state inspection.
   * @param segmentId - The encoding segment identity.
   * @returns Its exact permit when the live job still owns the segment.
   * @throws {Error} When persisted job or segment data is invalid.
   */
  prepareSegmentWriteRecovery(segmentId: string): LongMediaSegmentWritePermit | null {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql.exec<LongMediaJobRow>("SELECT * FROM long_media_jobs LIMIT 1").toArray()[0];
      const row = this.ctx.storage.sql.exec<LongMediaSegmentRow>(
        "SELECT * FROM long_media_segments WHERE job_id = ? AND segment_id = ? AND status = 'encoding'",
        job?.job_id ?? "",
        segmentId,
      ).toArray()[0];
      if (job === undefined || row === undefined || row.storage_key === null) return null;
      const state = stateOf(job);
      if ((state.phase !== "planning" && state.phase !== "running") || state.terminalIntent !== null) return null;
      const descriptor = JSON.parse(row.descriptor_json) as Record<string, unknown>;
      if (descriptor.mediaKind !== "audio" && descriptor.mediaKind !== "video") {
        throw new Error("The persisted long media segment has an invalid media kind");
      }
      const request = readLongMediaJobRequest(JSON.parse(job.request_json) as unknown);
      const changed = this.ctx.storage.sql.exec(
        `UPDATE long_media_write_permits SET status = 'writing'
         WHERE job_id = ? AND segment_id = ? AND status IN ('pending', 'writing')`,
        job.job_id,
        segmentId,
      );
      if (changed.rowsWritten !== 1) return null;
      return {
        segmentId,
        storageKey: row.storage_key,
        expectedVersion: row.version,
        maxBytes: request.limitsSnapshot.maxSegmentBytes,
        mediaKind: descriptor.mediaKind,
      };
    });
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
      if (event.type === "measured") {
        const permit = this.ctx.storage.sql.exec<{ status: string } & Record<string, SqlStorageValue>>(
          "SELECT status FROM long_media_write_permits WHERE job_id = ? AND segment_id = ?",
          job.job_id,
          segmentId,
        ).toArray()[0];
        if (permit?.status !== "writing") return { kind: "invalid" };
      }
      if (event.type === "measured" && (!/^[a-f0-9]{64}$/u.test(event.measured.sha256) ||
          !Number.isSafeInteger(event.measured.sizeBytes) || event.measured.sizeBytes < 1 ||
          !/^(audio|video)\/[a-z0-9.+-]+$/u.test(event.measured.contentType))) return { kind: "invalid" };
      const next = transitionLongMediaSegment(current, event);
      if (next === current) return { kind: "invalid" };
      this.ctx.storage.sql.exec(
        "UPDATE long_media_segments SET status = ?, version = version + 1 WHERE job_id = ? AND segment_id = ? AND version = ?",
        next,
        job.job_id,
        segmentId,
        expectedVersion,
      );
      if (event.type === "measured") {
        this.ctx.storage.sql.exec(
          `INSERT INTO long_media_segment_measurements (job_id, segment_id, sha256, size_bytes, content_type)
           VALUES (?, ?, ?, ?, ?)`,
          job.job_id, segmentId, event.measured.sha256, event.measured.sizeBytes, event.measured.contentType,
        );
        this.ctx.storage.sql.exec(
          "UPDATE long_media_write_permits SET status = 'written' WHERE job_id = ? AND segment_id = ? AND status = 'writing'",
          job.job_id,
          segmentId,
        );
      }
      if (event.type === "transient") {
        this.ctx.storage.sql.exec(
          `UPDATE long_media_write_permits SET status = 'pending'
           WHERE job_id = ? AND segment_id = ? AND status = 'writing'`,
          job.job_id,
          segmentId,
        );
      }
      return { kind: "accepted", status: next, version: expectedVersion + 1 };
    });
  }

  /**
   * Apply a callback to one segment at its current persisted revision.
   * @param segmentId - The durable segment identity.
   * @param event - The lifecycle event.
   * @returns The committed state or stale/invalid result.
   */
  applyCurrentSegmentEvent(segmentId: string, event: LongMediaSegmentEvent): LongMediaSegmentEventResult {
    const segment = this.readSegments().find((item) => item.id === segmentId);
    return segment === undefined
      ? { kind: "stale" }
      : this.applySegmentEvent(segmentId, segment.version, event);
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
      let validatedEvent = event;
      if (event.type === "planAck") {
        const plan = this.ctx.storage.sql.exec<{ revision: number } & Record<string, SqlStorageValue>>(
          "SELECT revision FROM long_media_segment_plans WHERE job_id = ?",
          row.job_id,
        ).toArray()[0];
        if (plan === undefined || !this.rootPlanComplete(row.job_id)) return null;
        const runnable = this.ctx.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM long_media_segments
           WHERE job_id = ? AND status IN ('planned', 'encoding', 'oversize', 'stored', 'paused')`,
          row.job_id,
        ).one().count;
        if (runnable === 0) return null;
        validatedEvent = { type: "planAck", hasRunnableSegments: true };
      }
      const next = transitionLongMediaJob(current, validatedEvent, now);
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
 * Hash the parsed mutation for durable idempotency checks.
 * @param plan - The validated mutation.
 * @returns The lowercase SHA-256 digest.
 * @throws {DOMException} When the runtime cannot compute SHA-256.
 */
async function digestPlanPayload(plan: LongMediaPlanRequest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Check that intervals form exact contiguous coverage of one source range.
 * @param intervals - Ordered or unordered intervals to check.
 * @param startUs - Trusted range start.
 * @param endUs - Trusted range end.
 * @returns Whether coverage is complete without gaps or overlap.
 */
function intervalsCoverRange(
  intervals: readonly { core: { startUs: string; endUs: string } }[],
  startUs: string,
  endUs: string,
): boolean {
  const ordered = [...intervals].toSorted((left, right) =>
    BigInt(left.core.startUs) < BigInt(right.core.startUs) ? -1 : 1);
  let cursor = BigInt(startUs);
  for (const interval of ordered) {
    const start = BigInt(interval.core.startUs);
    const end = BigInt(interval.core.endUs);
    if (start !== cursor || end <= start) return false;
    cursor = end;
  }
  return cursor === BigInt(endUs);
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
