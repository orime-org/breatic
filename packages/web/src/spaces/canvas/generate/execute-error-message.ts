// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a failed Generate submit says to the user.
 *
 * The failures are the task-create service's, not any one modality's: credits,
 * an already-locked node, and an outage mean the same thing whether the user
 * was generating a picture or a video, so they read the same way.
 */

/**
 * Maps a failed execute request to a user-facing message. Credit / lock /
 * outage are the meaningful task-create failures (server `AppError`s).
 * @param status - The HTTP status, or undefined for a non-API error.
 * @param translate - The i18n translate function.
 * @returns A localized error message.
 */
export function executeErrorMessage(
  status: number | undefined,
  translate: (key: string) => string,
): string {
  switch (status) {
    case 402:
      return translate('canvas.generatePanel.errorCredits');
    case 409:
      return translate('canvas.generatePanel.errorBusy');
    case 503:
      return translate('canvas.generatePanel.errorUnavailable');
    default:
      return translate('canvas.generatePanel.errorFailed');
  }
}
