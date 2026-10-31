// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Telling a storage refusal apart from an ordinary upload failure (#89).
 *
 * Nothing crashes when they are confused: the user reads "upload failed, try
 * again" and the node lights up a Retry button, which asks once more for room
 * nobody has freed. So this branch can only be held by assertions — measured
 * in an adversarial round: forcing the 507 check to false turned none of the
 * 1744 tests under canvas red.
 *
 * Two entries share one check and one exit, and both are pinned here: a file
 * dropped onto the canvas (`runMediaUpload`, which throws 507 while asking for
 * a ticket) and one filling an existing node (`fillNodeFromFile`).
 */

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import {
  fillNodeFromFile,
  type FillNodeDeps,
} from '@web/spaces/canvas/canvas-upload';
import {
  runMediaUpload,
  type MediaUploadDeps,
  type UploadFailure,
} from '@web/data/upload/media-upload';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const CONFIG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 1,
  clientRetryBaseDelayMs: 1,
  uploadIdleTimeoutMs: 60000,
};

/** What a full account answers with, shaped the way `apiGet` hands it over. */
function storageFull(): ApiException {
  return new ApiException({
    status: 507,
    message: 'Studio storage is full; nothing can be uploaded right now.',
    fromServer: true,
  });
}

/** An image small enough to clear the per-file cap. */
function pngFile(name = 'a.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

/**
 * Upload deps that get as far as asking for a ticket and are refused.
 * @param onFailure - The failure exit.
 * @returns Deps that `runMediaUpload` takes as they are.
 */
function refusingDeps(
  onFailure: (outcome: UploadFailure) => void,
): MediaUploadDeps {
  return {
    getUploadConfig: async () => CONFIG,
    hashFile: async () => 'a'.repeat(64),
    requestTicket: async () => {
      throw storageFull();
    },
    sendToIngest: async () => ({}),
    onSuccess: () => {
      throw new Error('this upload must not succeed');
    },
    onFailure,
  } as unknown as MediaUploadDeps;
}

describe('a 507 reads as storage rather than an ordinary upload failure', () => {
  it('on the file dropped onto the canvas', async () => {
    const onFailure = vi.fn();
    await runMediaUpload(
      pngFile(),
      { projectId: 'p1' },
      refusingDeps(onFailure),
    );
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'storage' });
  });

  it('leaves an ordinary ticket failure outside the 507 branch', async () => {
    const onFailure = vi.fn();
    await runMediaUpload(pngFile(), { projectId: 'p1' }, {
      ...refusingDeps(onFailure),
      requestTicket: async () => {
        throw new ApiException({
          status: 503,
          message: 'down',
          fromServer: true,
        });
      },
    } as unknown as MediaUploadDeps);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'upload' });
  });
});

describe('filling an existing node says a full account on the node', () => {
  /**
   * Fill deps whose ticket request always answers that storage is full.
   * @param extra - What this case overrides or adds.
   * @returns Deps that `fillNodeFromFile` takes as they are.
   */
  function fillDeps(extra: Partial<FillNodeDeps>): FillNodeDeps {
    return {
      getUploadConfig: async () => CONFIG,
      hashFile: async () => 'a'.repeat(64),
      requestTicket: async () => {
        throw storageFull();
      },
      sendToIngest: async () => ({}),
      extractText: async () => '',
      setContent: () => true,
      onUploadFailure: () => {},
      spaceId: 's1',
      markOp: '',
      ...extra,
    } as unknown as FillNodeDeps;
  }

  // inner#1303 §6.7: refused before any ticket, so no task row; the node says it.
  it('marks the node with the full account and hands nothing to the caller', async () => {
    useUploadMarksStore.setState({ marks: {} });
    const markOp = useUploadMarksStore.getState().begin('s1', 'n1', 'upload');
    const onUploadFailure = vi.fn((_outcome: UploadFailure) => {});
    await fillNodeFromFile('n1', pngFile(), 'image', 'p1', fillDeps({ onUploadFailure, markOp }));
    expect(onUploadFailure).not.toHaveBeenCalled();
    expect(useUploadMarksStore.getState().markOf('s1', 'n1')).toMatchObject({
      state: 'failed',
      message: { key: 'canvas.upload.storageFull' },
    });
  });
});
