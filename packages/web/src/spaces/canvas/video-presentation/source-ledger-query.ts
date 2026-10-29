// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The stored source frame table a presentation response names (inner#1306).
 *
 * The small response comes from the authorized presentation query; this one
 * reads the companion body it points at, through the shared bounded reader.
 * A ready receipt alone is not a table: the query has data only once the whole
 * body was validated for exactly this key.
 */

import { queryOptions, type UseQueryOptions } from '@tanstack/react-query';
import {
  DEFAULT_TIMEOUT_MS,
  readVideoSourceLedger,
  type VideoPresentationResponse,
  type VideoSourceLedgerCompanion,
  type VideoSourceLedgerReadLimits,
  type VideoSourceLedgerReceipt,
} from '@breatic/shared';

/** The parsed presentation response and whether its Space is active. */
export interface SourceLedgerQueryInput { projectId: string; response: VideoPresentationResponse | undefined; active: boolean }

/** The query key: the project, the bound source, the whole small receipt and the captured read policy. */
type SourceLedgerQueryKey = readonly [
  'video-source-ledger', 1, string, string, string, VideoSourceLedgerReceipt | null, VideoSourceLedgerReadLimits | null,
];

/** Options for the existing account-scoped QueryClient. */
export type SourceLedgerQueryOptions = UseQueryOptions<VideoSourceLedgerCompanion, Error, VideoSourceLedgerCompanion, SourceLedgerQueryKey>;

/**
 * Describe the read of one stored source frame table.
 * @param input - Project, the parsed presentation response and Space activation.
 * @returns Options that read nothing until a ready receipt bound to the source and a read policy are both present.
 * @throws {never} Constructing options starts no request.
 */
export function sourceLedgerQuery(input: SourceLedgerQueryInput): SourceLedgerQueryOptions {
  const binding = input.response?.sourceBinding;
  const state = input.response?.sourceLedger;
  // Only a version 1 receipt names a companion this reader parses; a version 2 receipt waits for the v2 reader.
  const receipt = state?.state === 'ready' && state.receipt.schemaVersion === 1 && state.receipt.sourceFingerprint === binding?.contentHash ? state.receipt : null;
  const limits = input.response?.sourceLedgerReadLimits ?? null;
  return queryOptions({
    queryKey: ['video-source-ledger', 1, input.projectId, binding?.canonicalURL ?? '', binding?.contentHash ?? '', receipt, limits] as const,
    enabled: input.active && receipt !== null && limits !== null,
    retry: false,
    queryFn: ({ signal }): Promise<VideoSourceLedgerCompanion> => {
      // `enabled` keeps both present; a direct fetch of disabled options refuses.
      if (receipt === null || limits === null) return Promise.reject(new Error('No ready source ledger to read'));
      // An ordinary page read has no task deadline: it takes the existing
      // default delivery budget once, and the GET and the body share it.
      return readVideoSourceLedger(receipt, limits, { deadlineAt: Date.now() + DEFAULT_TIMEOUT_MS, signal });
    },
  });
}
