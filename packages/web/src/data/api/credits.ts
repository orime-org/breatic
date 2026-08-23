// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { StudioCreditsView } from '@breatic/shared';

import { apiGet } from '@web/data/api/request';

/**
 * Read what the studio owning a project can spend.
 *
 * Its own request, separate from the project's detail: this figure moves with
 * every generation while the project's name and role do not.
 * @param projectId - The project being viewed.
 * @returns What its studio has left, below zero when the studio owes.
 */
export async function fetchProjectCredits(
  projectId: string,
): Promise<{ spendable: number }> {
  return apiGet<{ spendable: number }>(
    `/projects/${encodeURIComponent(projectId)}/credits`,
  );
}

/**
 * Read one studio's credits.
 * @param slug - The studio being viewed.
 * @param cursor - The previous page's `nextCursor`, when paging the ledger.
 * @returns The studio's credits and one page of its ledger.
 */
export async function fetchStudioCredits(
  slug: string,
  cursor?: string,
): Promise<StudioCreditsView> {
  return apiGet<StudioCreditsView>(`/studio/${encodeURIComponent(slug)}/credits`, {
    params: cursor ? { cursor } : undefined,
  });
}
