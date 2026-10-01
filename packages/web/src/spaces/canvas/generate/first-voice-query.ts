// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The first voice of a model's list, which stands in for a voice nobody picked
 * (user 2026-09-29). One query for the audio panel and for what a node hands
 * the agent (#2218), so both name the same voice.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Voice } from '@breatic/shared';

import { voicesApi } from '@web/data/api/voices';

/**
 * Where a model's first listed voice is cached.
 * @param model - The model id.
 * @returns The query key.
 */
export function firstVoiceKey(model: string): readonly [string, string] {
  return ['voice-default', model] as const;
}

/**
 * The query that asks for a model's first listed voice. The row it brings back
 * also seeds the by-id cache the voice pill reads its name from.
 * @param queryClient - The client whose by-id cache gets the row.
 * @param model - The model id.
 * @returns The query's key and function.
 */
export function firstVoiceQuery(
  queryClient: QueryClient,
  model: string,
): { queryKey: readonly [string, string]; queryFn: () => Promise<Voice | null> } {
  return {
    queryKey: firstVoiceKey(model),
    queryFn: async () => {
      const first = (await voicesApi.list(model, { query: '' })).voices[0] ?? null;
      if (first) queryClient.setQueryData(['voice', model, first.id], first);
      return first;
    },
  };
}
