// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a failed Generate submit says to the user.
 *
 * The failures are the task-create service's, not any one modality's: credits,
 * full storage and an outage mean the same thing whether the user was
 * generating a picture or a video, so they read the same way.
 */

import { assetsApi, requestBodyLimitOf } from '@web/data/api/assets';
import { formatBytes } from '@web/lib/format-bytes';

/** The translate function, with ICU values. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * What a request refused as too large says (inner#1006), as a key and its
 * values: the limit the server named in this session's upload knobs, or the
 * sentence with no number when the page has none. Shared by every canvas run
 * a 413 can refuse.
 * @returns The message key, with the limit when there is one.
 */
export function tooLargeMessage(): { key: string; params?: { limit: string } } {
  const limit = requestBodyLimitOf(assetsApi.cachedUploadConfig());
  return limit === null
    ? { key: 'canvas.generatePanel.errorTooLargeNoLimit' }
    : { key: 'canvas.generatePanel.errorTooLarge', params: { limit: formatBytes(limit) } };
}

/**
 * Maps a failed execute request to a user-facing message. Credits, full
 * storage, an outage and a request over the body limit are the meaningful
 * task-create failures.
 * @param status - The HTTP status, or undefined for a non-API error.
 * @param translate - The i18n translate function.
 * @returns A localized error message.
 */
export function executeErrorMessage(status: number | undefined, translate: Translate): string {
  switch (status) {
    case 402:
      return translate('canvas.generatePanel.errorCredits');
    case 413: {
      const { key, params } = tooLargeMessage();
      return params === undefined ? translate(key) : translate(key, params);
    }
    case 507:
      return translate('canvas.generatePanel.errorStorageFull');
    case 503:
      return translate('canvas.generatePanel.errorUnavailable');
    default:
      return translate('canvas.generatePanel.errorFailed');
  }
}
