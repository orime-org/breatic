// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { UploadStatus } from '@breatic/shared';

import { apiGet } from '@web/data/api/request';

/** One answer of the Studio page's poll (#1580). */
export interface StudioPagePoll {
  /** The person's bell: the unread count and when the newest notification still there was made. */
  notifications: { unread: number; latestAt: string | null };
  /** The Studio's live transfer, for its admin; null otherwise. */
  transfer: { id: string; status: string; updatedAt: string } | null;
  /** How each asked upload stands, in the order asked. */
  uploads: UploadStatus[];
  /** Of the asked Projects, the ones no longer being copied (inner#1706), in the order asked. */
  copied: string[];
  /** How long to wait before asking again, in ms. */
  nextPollMs: number;
}

export const studioPageApi = {
  /**
   * `GET /api/v1/studio-page/poll` — what the Studio page shows that can change on its own.
   * @param studio - The Studio the page shows, or null on the Recent page.
   * @param uploads - The keys of the uploads the page waits for.
   * @param copying - The Projects the page shows as being copied.
   * @param signal - Cancels the request.
   * @returns The answer.
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  poll(studio: string | null, uploads: readonly string[], copying: readonly string[], signal?: AbortSignal): Promise<StudioPagePoll> {
    return apiGet<StudioPagePoll>('/studio-page/poll', {
      params: {
        ...(studio !== null && { studio }),
        ...(uploads.length > 0 && { uploads: uploads.join(',') }),
        ...(copying.length > 0 && { copying: copying.join(',') }),
      },
      ...(signal !== undefined && { signal }),
    });
  },
};
