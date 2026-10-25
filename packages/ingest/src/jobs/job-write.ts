// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { miniToolPlanAccess } from "@breatic/shared";
import { canonicalMiniToolValue } from "@shared/mini-tools/canonical-value.js";
import { JOB_RECORD_KEY, type JobWritten, type StoredMiniToolJob } from "@ingest/jobs/job-record.js";
import { transition } from "@ingest/jobs/transition.js";

/**
 * Persist the current byte measurement without replacing known immutable facts.
 * @param storage - The actual Durable Object storage.
 * @param key - The issued object key.
 * @param written - Measurements computed over the stored bytes.
 * @param attemptId - The planned attempt that issued the output.
 * @param _claimToken - The pending pre-write claim contract, not enforced by this RED baseline.
 * @returns Nothing after the atomic measurement/state update.
 * @throws {Error} When a planned attempt or byte observation conflicts.
 */
export async function recordJobWrite(storage: DurableObjectStorage, key: string, written: JobWritten, attemptId?: string, _claimToken?: string): Promise<void> {
  await storage.transaction(async (transaction) => {
    const record = await transaction.get<StoredMiniToolJob>(JOB_RECORD_KEY);
    if (!record) return;
    if ("schemaVersion" in record.request && record.request.schemaVersion === 2) {
      const access = miniToolPlanAccess(record.request);
      if (attemptId !== record.state.attemptId || access.writes[key] === undefined || access.writes[key] !== written.contentType) throw new Error("Unexpected planned output write or attempt");
      const existing = record.written[key];
      if (existing !== undefined) {
        if (canonicalMiniToolValue(existing) !== canonicalMiniToolValue(written)) throw new Error("Conflicting immutable output measurements");
        return;
      }
    }
    const changed = transition(record.state, { type: "written", key }, Date.now());
    await transaction.put(JOB_RECORD_KEY, { ...record, state: changed.state ?? record.state, written: { ...record.written, [key]: written } });
  });
}

/**
 * Claim one planned output before any R2 write is started.
 * @param _storage - The actual Durable Object storage.
 * @param _key - The issued output key.
 * @param _attemptId - The immutable attempt claiming the key.
 * @returns The durable writer token, or null for a refused claim.
 * @throws {Error} Until the pre-write claim is implemented after its real R2 RED.
 */
export async function claimJobWrite(_storage: DurableObjectStorage, _key: string, _attemptId: string): Promise<string | null> {
  throw new Error("Planned pre-write claims are not implemented");
}
