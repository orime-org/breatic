// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions } from '@tanstack/react-query';
import { miniToolAnalysisRecordSchema, miniToolAnalysisRequestSchema, type MiniToolAnalysisRecord, type MiniToolAnalysisRequest } from '@breatic/shared/mini-tools';
import { apiGet, apiPost, runOnceRequest } from '@web/data/api/request';
import { noteCreditsChanged } from '@web/data/api/credits';

/** Server-owned accepted analyses and their registered artifacts. */
export const miniToolAnalysesApi = {
  /**
   * Starts one frozen analysis with a stable resend identity.
   * @throws {Error} When admission or response validation fails.
   * @param body - The frozen request sent on each resend.
   * @param key - The stable Idempotency-Key for this press.
   * @returns The current value derived from these inputs.
   */
  async start(body: MiniToolAnalysisRequest, key: string): Promise<MiniToolAnalysisRecord> {
    const frozen = miniToolAnalysisRequestSchema.parse(body);
    try {
      return miniToolAnalysisRecordSchema.parse(await apiPost<unknown>('/mini-tools/analyses', frozen, runOnceRequest(key)));
    } finally {
      noteCreditsChanged(body.projectId);
    }
  },
  /**
   * Reads one authorized analysis without changing its accepted identity.
   * @throws {Error} When reading or response validation fails.
   * @param runId - The accepted analysis identity.
   * @returns The current value derived from these inputs.
   */
  async get(runId: string): Promise<MiniToolAnalysisRecord> {
    return miniToolAnalysisRecordSchema.parse(await apiGet<unknown>(`/mini-tools/analyses/${runId}`));
  },
};

/**
 * Provides a shared cache entry for admission, collaborator reads and refresh.
 * @throws {never} Never.
 * @param runId - The accepted analysis identity.
 * @returns The current value derived from these inputs.
 */
export function miniToolAnalysisQuery(runId: string): ReturnType<typeof queryOptions<MiniToolAnalysisRecord>> {
  return queryOptions<MiniToolAnalysisRecord>({
    queryKey: ['mini-tool-analysis', runId],
    queryFn: () => miniToolAnalysesApi.get(runId),
  });
}

/**
 * Chooses accepted metadata with the shared UTC-microsecond and UUID ordering.
 * @param records - Validated analysis records from one current draft and kind.
 * @returns The latest accepted record, independently of its calculation status.
 * @throws {never} Never.
 */
export function latestMiniToolAnalysis(records: readonly MiniToolAnalysisRecord[]): MiniToolAnalysisRecord | null {
  return records.reduce<MiniToolAnalysisRecord | null>((held, record) => held === null || record.acceptedAt > held.acceptedAt || record.acceptedAt === held.acceptedAt && record.analysisRunId > held.analysisRunId ? record : held, null);
}
