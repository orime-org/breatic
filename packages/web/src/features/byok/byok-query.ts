// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';

import { byokApi, type ByokView, type KeyPlan } from '@web/data/api/byok';
import type { useTranslation } from '@web/i18n/use-translation';

/**
 * The cache key of the account's BYOK view. Not keyed on the user: the whole cache is dropped when the signed-in
 * account changes.
 */
const BYOK_VIEW_KEY = ['account', 'byok'] as const;

/** The root every project's key plan sits under, so one write refreshes them all. */
const KEY_PLAN_ROOT = ['key-plan'] as const;

/**
 * The account's BYOK view.
 * @param enabled - Whether to read now; the dialog reads only while it is open.
 * @returns The query.
 */
export function useByokView(enabled: boolean): UseQueryResult<ByokView> {
  return useQuery({ queryKey: BYOK_VIEW_KEY, queryFn: byokApi.view, enabled });
}

/**
 * Read the view again after a write, and the key plans that follow from it; resolves once the view is back on screen.
 * @param client - The query client.
 * @returns Once the view's re-read settles.
 */
export async function rereadByok(client: QueryClient): Promise<void> {
  void client.invalidateQueries({ queryKey: KEY_PLAN_ROOT });
  await client.invalidateQueries({ queryKey: BYOK_VIEW_KEY });
}

/** What a run on the payer's own key shows in place of a credit figure: the key's short name, and the full sentence. */
export interface OwnKeyCredit {
  text: string;
  detail: string;
}

/**
 * What a run on the payer's own key says in place of a credit figure (inner#1953): whose key it is to the viewer, and,
 * in the short name as well as the full sentence, that describing its elements still takes credits when the language
 * model runs on ours, so a charged run never reads like one that takes none.
 * @param payer - Whose keys pay: the viewer's own, or the Studio Admin's.
 * @param t - The translator.
 * @param describing - Whether the run's description step is charged in credits.
 * @returns The short name and the sentence.
 */
export function ownKeyCredit(payer: KeyPlan['payer'], t: ReturnType<typeof useTranslation>, describing = false): OwnKeyCredit {
  const whose = payer === 'admin' ? 'Studio' : 'Own';
  const suffix = describing ? 'Describing' : '';
  return {
    text: t(`canvas.generatePanel.${payer === 'admin' ? 'studioKeyLabel' : 'ownKeyLabel'}${suffix}`),
    detail: t(`canvas.generatePanel.uses${whose}Key${suffix}`),
  };
}

/**
 * Whose key a project's runs use (inner#1953).
 * @param projectId - The project the panel is in; undefined reads nothing.
 * @returns The query.
 */
export function useKeyPlan(projectId: string | undefined): UseQueryResult<KeyPlan> {
  return useQuery({
    queryKey: [...KEY_PLAN_ROOT, projectId],
    queryFn: () => byokApi.keyPlan(projectId as string),
    enabled: projectId !== undefined,
  });
}

