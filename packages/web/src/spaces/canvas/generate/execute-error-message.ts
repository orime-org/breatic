// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a failed Generate submit says to the user.
 *
 * The failures are the task-create service's, not any one modality's: credits,
 * full storage and an outage mean the same thing whether the user was
 * generating a picture or a video, so they read the same way.
 */

import { assetsApi, requestBodyLimitOf } from '@web/data/api/assets';
import { ApiException } from '@web/data/api/types';
import { refusalSentence } from '@web/data/api/server-message';
import { formatBytes } from '@web/lib/format-bytes';

/** The translate function, with ICU values. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * What a request refused as too large says (inner#1006), as a key and its
 * values: the server's own sentence with the limit from this session's upload
 * config, fetched here when nothing has fetched it yet, so a refusal reads the
 * same whether nginx or our server sent it. A sentence with no number when
 * the config cannot be had or names no limit. Shared by every canvas run a
 * 413 can refuse.
 * @returns The message key, with the limit when there is one.
 */
export async function tooLargeMessage(): Promise<{ key: string; params?: { limit: string } }> {
  let limit: number | null;
  try {
    limit = requestBodyLimitOf(await assetsApi.fetchUploadConfig());
  } catch {
    // Unreachable config: the sentence below says why without the number.
    limit = null;
  }
  return limit === null
    ? { key: 'canvas.generatePanel.errorTooLargeNoLimit' }
    : { key: 'server.error.payload_too_large', params: { limit: formatBytes(limit) } };
}

/**
 * Maps a failed execute request to a user-facing message. A refusal at a
 * spend limit (inner#1968) is read off the refusal's reason first; then credits, full storage, an outage and a request
 * over the body limit are the meaningful task-create failures.
 * @param err - What the request rejected with.
 * @param translate - The i18n translate function.
 * @returns A localized error message.
 */
export async function executeErrorMessage(err: unknown, translate: Translate): Promise<string> {
  const refused = refusalSentence(err);
  if (refused !== null) return refused;
  switch (err instanceof ApiException ? err.status : undefined) {
    case 402:
      return translate('canvas.generatePanel.errorCredits');
    case 413: {
      const { key, params } = await tooLargeMessage();
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

/**
 * Maps any failed execute press to what the user reads: the sentence our server refused it with (a 422 names the
 * rule, the limit or the slot, in the user's language), else {@link executeErrorMessage}.
 * @param err - What the request threw.
 * @param translate - The i18n translate function.
 * @returns A localized error message.
 */
export async function executeFailureMessage(err: unknown, translate: Translate): Promise<string> {
  if (err instanceof ApiException && err.status === 422 && err.fromServer) return err.message;
  return executeErrorMessage(err, translate);
}
