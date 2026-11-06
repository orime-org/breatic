// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { UploadFailedError } from '@web/data/upload/media-upload';
import { uploadFailureMessageKey, uploadRetryCanChange } from '@web/spaces/canvas/upload-failure';

/** Why a model upload did not start, and whether sending the same model again can succeed. */
export interface ModelUploadFailure {
  key: string;
  params: Record<string, string>;
  retryable: boolean;
}

/**
 * Say why a model upload ended and whether sending the same model again can succeed.
 * @param error - What the model upload rejected with.
 * @param filename - The uploaded model file's name, for messages that name it.
 * @returns The message key, its parameters and whether Retry is offered.
 * @throws {never} Never.
 */
export function modelUploadFailure(error: unknown, filename: string): ModelUploadFailure {
  const reason = error instanceof UploadFailedError ? error.reason : 'upload';
  const generic = reason === 'upload' || reason === 'transfer';
  return {
    key: generic ? 'spaces.threeD.importModel.errorUpload' : uploadFailureMessageKey(reason),
    params: { filename, kind: 'other' },
    retryable: uploadRetryCanChange(reason),
  };
}
