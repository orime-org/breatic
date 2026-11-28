// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What an upload placeholder in a Space document says when it failed, shared by the Document's pending media blocks
 * and the Timeline's upload placeholders (inner#1709): this page's own reasons are mapped to the reasons
 * collab writes, and every reason has one message.
 */

import type { PendingFailureReason } from '@breatic/shared';

import type { UploadFailureReason } from '@web/data/upload/media-upload';

/** The reason a placeholder names for each way this page's file upload fails. */
export const FILE_FAILURE_REASON: Readonly<Record<UploadFailureReason, PendingFailureReason>> = {
  storage: 'storageFull',
  hash: 'hashUnavailable',
  unsupportedType: 'unsupportedType',
  rateLimited: 'rateLimited',
  tooLarge: 'tooLarge',
  upload: 'failed',
  transfer: 'failed',
};

/** The message key a failed placeholder shows for each reason. */
export const FAILURE_MESSAGE: Readonly<Record<PendingFailureReason, string>> = {
  failed: 'spaces.document.media.uploadFailed',
  storageFull: 'spaces.document.media.failure.storageFull',
  rateLimited: 'spaces.document.media.failure.rateLimited',
  hashUnavailable: 'spaces.document.media.failure.hashUnavailable',
  unsupportedType: 'spaces.document.media.failure.unsupportedType',
  tooLarge: 'spaces.document.media.failure.tooLarge',
  empty: 'spaces.document.media.failure.empty',
  unreachable: 'spaces.document.media.failure.unreachable',
  spaceFull: 'spaces.sizeCap.reason',
};
