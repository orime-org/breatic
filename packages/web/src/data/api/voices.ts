// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { sanitizeVoicePage, type Voice, type VoicePage } from '@breatic/shared';

import { apiGet } from '@web/data/api/request';

/** What to ask a page for. */
interface VoiceListQuery {
  /** What the user typed. Searched upstream, not in the rendered list. */
  query?: string;
  /** The token the previous page handed back. */
  cursor?: string;
}

/**
 * Builds the path for one model's voices, with the search state on the query
 * string. Both parts are encoded: a model name or a search term carrying `&`,
 * `#` or `/` would otherwise end the parameter early and ask for something
 * else entirely.
 * @param modelName - The model whose voices are wanted.
 * @param query - The search state, if any.
 * @returns A relative API path.
 */
function voicesPath(modelName: string, query: VoiceListQuery): string {
  const params = new URLSearchParams();
  if (query.query) params.set('query', query.query);
  if (query.cursor) params.set('cursor', query.cursor);
  const search = params.toString();
  const base = `/models/${encodeURIComponent(modelName)}/voices`;
  return search ? `${base}?${search}` : base;
}

export const voicesApi = {
  /**
   * Fetch one page of the voices a model offers.
   *
   * Trust boundary: the page is assembled from a vendor's response, so it runs
   * through `sanitizeVoicePage` here once, the same way the catalog does.
   * @param modelName - The model whose voices are wanted.
   * @param query - Search term and paging cursor.
   * @returns A structurally valid page.
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  async list(modelName: string, query: VoiceListQuery): Promise<VoicePage> {
    const raw = await apiGet<unknown>(voicesPath(modelName, query));
    return sanitizeVoicePage(raw);
  },

  /**
   * Fetch one voice by its id, to show the stored choice by name instead of by
   * a 20-character id or a UUID.
   *
   * Sanitizes through the page schema so a single voice is judged by exactly
   * the rules a listed one is — no second copy of what makes a voice usable.
   * @param modelName - The model the voice belongs to.
   * @param voiceId - The id held in the node's param record.
   * @returns The voice, or null when what came back is unusable.
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  async get(modelName: string, voiceId: string): Promise<Voice | null> {
    const path = `/models/${encodeURIComponent(modelName)}/voices/${encodeURIComponent(voiceId)}`;
    const raw = await apiGet<unknown>(path);
    return sanitizeVoicePage({ voices: [raw], hasMore: false }).voices[0] ?? null;
  },
};
