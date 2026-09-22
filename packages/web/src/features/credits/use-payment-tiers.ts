// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { getLocale } from '@breatic/shared';

import { paymentApi } from '@web/data/api/payment';
import type { PackList } from '@web/data/api/payment';

/**
 * The packs and the refund rule, in the reader's language.
 *
 * Three screens read this one answer and share it under one key, which is
 * what makes opening them all ask once. The language is part of that key
 * because the rule comes back translated: left out, switching language leaves
 * the rule in the previous one until the answer goes stale.
 * @param enabled - Whether to ask at all.
 * @returns The query.
 */
export function usePaymentTiers(enabled: boolean): UseQueryResult<PackList> {
  return useQuery({
    queryKey: ['payment', 'tiers', getLocale()],
    queryFn: () => paymentApi.tiers(),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}
