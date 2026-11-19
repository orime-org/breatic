// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { DurableObject } from "cloudflare:workers";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import { JOB_RECORD_KEY, type JobWritten, type StoredMiniToolJob } from "@ingest/jobs/job-record.js";
import type { JobPhase } from "@ingest/jobs/transition.js";
import { claimJobWrite, recordJobWrite } from "@ingest/jobs/job-write.js";

/** A real workerd storage fixture; it never constructs or impersonates a media Container. */
export class PlanWriteTestObject extends DurableObject {
  /**
   * Seed an already accepted immutable plan without starting a media image.
   * @param request - The exact accepted fixture plan.
   * @param attemptId - The immutable fixture attempt.
   * @returns Nothing after the actual DO storage write.
   * @throws {Error} When storage fails.
   */
  async initialize(request: MiniToolPlanJobRequest, attemptId: string): Promise<void> {
    const record: StoredMiniToolJob = {
      request, state: { phase: "running", attemptId, outputs: request.outputs.map((output) => output.storageKey), written: [], startedAt: Date.now(), endedAt: null, reason: null },
      written: {}, media: {}, cpuUsec: null,
    };
    await this.ctx.storage.put(JOB_RECORD_KEY, record);
  }

  /**
   * Call the same production durable pre-write claim helper as the media DO.
   * @param key - The declared output key.
   * @param attemptId - The claimed attempt.
   * @returns Its writer token or refusal.
   * @throws {Error} When the production claim transaction fails.
   */
  async claimOutputWrite(key: string, attemptId: string): Promise<string | null> {
    return claimJobWrite(this.ctx.storage, key, attemptId);
  }

  /**
   * Call the production atomic measurement helper over real DO storage.
   * @param key - The declared output key.
   * @param written - The real R2 byte measurements.
   * @param attemptId - The issued attempt.
   * @param token - The pre-write claim token.
   * @returns Nothing after the actual stored observation.
   * @throws {Error} When the production helper rejects the observation.
   */
  async noteWritten(key: string, written: JobWritten, attemptId?: string, token?: string): Promise<void> {
    await recordJobWrite(this.ctx.storage, key, written, attemptId, token);
  }

  /**
   * Read the actual stored request, state and byte observations.
   * @returns Its persisted record.
   * @throws {Error} When storage fails.
   */
  async snapshot(): Promise<{ written: Record<string, JobWritten>; state: { phase: JobPhase } } | undefined> {
    const record = await this.ctx.storage.get<StoredMiniToolJob>(JOB_RECORD_KEY);
    return record === undefined ? undefined : { written: record.written, state: { phase: record.state.phase } };
  }

  /**
   * Place the fixture in an absorbing terminal state before a late PUT.
   * @returns Nothing after the actual state write.
   * @throws {Error} When storage fails or no fixture was initialized.
   */
  async fail(): Promise<void> {
    const record = await this.ctx.storage.get<StoredMiniToolJob>(JOB_RECORD_KEY);
    if (!record) throw new Error("Missing plan fixture");
    await this.ctx.storage.put(JOB_RECORD_KEY, { ...record, state: { ...record.state, phase: "failed", endedAt: Date.now(), reason: "tool_failed" } });
  }
}
