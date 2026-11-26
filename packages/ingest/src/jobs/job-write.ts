// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
 * @param claimToken - The immutable pre-write owner of these stored bytes.
 * @returns Nothing after the atomic measurement/state update.
 * @throws {Error} When a planned attempt or byte observation conflicts.
 */
export async function recordJobWrite(storage: DurableObjectStorage, key: string, written: JobWritten, attemptId?: string, claimToken?: string): Promise<void> {
  await storage.transaction(async (transaction) => {
    const record = await transaction.get<StoredMiniToolJob>(JOB_RECORD_KEY);
    if (!record) return;
    if ("schemaVersion" in record.request && record.request.schemaVersion === 2) {
      const access = miniToolPlanAccess(record.request);
      if (attemptId !== record.state.attemptId || access.writes[key] === undefined || access.writes[key] !== written.contentType) throw new Error("Unexpected planned output write or attempt");
      if (claimToken === undefined || record.writeClaims?.[key] !== claimToken) throw new Error("Output measurement has no matching durable writer claim");
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
 * @param storage - The actual Durable Object storage.
 * @param key - The issued output key.
 * @param attemptId - The immutable attempt claiming the key.
 * @returns The durable writer token, or null for a refused claim.
 * @throws {Error} When the durable transaction cannot be completed.
 */
export async function claimJobWrite(storage: DurableObjectStorage, key: string, attemptId: string): Promise<string | null> {
  return storage.transaction(async (transaction) => {
    const record = await transaction.get<StoredMiniToolJob>(JOB_RECORD_KEY);
    if (!record || !("schemaVersion" in record.request) || record.request.schemaVersion !== 2) return null;
    if (record.state.attemptId !== attemptId || record.request.deadlineAt <= Date.now()) return null;
    if (record.state.phase !== "starting" && record.state.phase !== "running") return null;
    if (miniToolPlanAccess(record.request).writes[key] === undefined || record.written[key] !== undefined || record.writeClaims?.[key] !== undefined) return null;
    const token = crypto.randomUUID();
    await transaction.put(JOB_RECORD_KEY, { ...record, writeClaims: { ...record.writeClaims, [key]: token } });
    return token;
  });
}
