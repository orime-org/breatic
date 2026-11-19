// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The compact frame table of the selected version (inner#1306; design §3.2, §7.4, §7.12 step 4).
 *
 * The small response comes from the authorized presentation query; this one
 * reads the compact object the selected version's ledger receipt names, through
 * the shared bounded reader. A ready receipt alone is not a table: the query has
 * data only once the whole envelope was validated for exactly this receipt.
 */

import { queryOptions, type UseQueryOptions } from '@tanstack/react-query';
import {
  DEFAULT_TIMEOUT_MS,
  readVideoPresentationCompact,
  type VideoPresentationResponse,
  type VideoPresentationTableReadLimits,
} from '@breatic/shared';
import type { VideoPresentationTable } from '@breatic/shared/mini-tools';

/** The parsed presentation response and whether its Space is active. */
export interface SourceLedgerQueryInput { projectId: string; response: VideoPresentationResponse | undefined; active: boolean }

/** The selected version's ready ledger receipt. */
type LedgerReceipt = Extract<NonNullable<VideoPresentationResponse['ledger']>, { state: 'ready' }>['receipt'];
/** The query key: the project, the bound source, the whole small receipt and the captured read policy. */
type SourceLedgerQueryKey = readonly [
  'video-source-ledger', 1, string, string, string, LedgerReceipt | null, VideoPresentationTableReadLimits | null,
];

/** Options for the existing account-scoped QueryClient. */
export type SourceLedgerQueryOptions = UseQueryOptions<VideoPresentationTable, Error, VideoPresentationTable, SourceLedgerQueryKey>;

/**
 * Describe the read of one stored source frame table.
 * @param input - Project, the parsed presentation response and Space activation.
 * @returns Options that read nothing until a ready receipt bound to the source and the selected version's toolInputId,
 * and a read policy, are all present.
 * @throws {never} Constructing options starts no request.
 */
export function sourceLedgerQuery(input: SourceLedgerQueryInput): SourceLedgerQueryOptions {
  const binding = input.response?.sourceBinding;
  const ledger = input.response?.ledger;
  const selected = input.response?.presentation;
  const receipt = ledger?.state === 'ready' && selected != null && ledger.receipt.toolInputId === selected.toolInputId &&
    ledger.receipt.sourceFingerprint === binding?.contentHash ? ledger.receipt : null;
  const limits = input.response?.sourceLedgerReadLimits ?? null;
  return queryOptions({
    queryKey: ['video-source-ledger', 1, input.projectId, binding?.canonicalURL ?? '', binding?.contentHash ?? '', receipt, limits] as const,
    enabled: input.active && receipt !== null && limits !== null,
    retry: false,
    // A measured immutable object cannot become newer under the same receipt.
    staleTime: Infinity,
    queryFn: ({ signal }): Promise<VideoPresentationTable> => {
      // `enabled` keeps both present; a direct fetch of disabled options refuses.
      if (receipt === null || limits === null) return Promise.reject(new Error('No ready source ledger to read'));
      // An ordinary page read has no task deadline: it takes the existing
      // default delivery budget once, and the GET and the body share it.
      return readVideoPresentationCompact(receipt, limits, { deadlineAt: Date.now() + DEFAULT_TIMEOUT_MS, signal });
    },
  });
}
