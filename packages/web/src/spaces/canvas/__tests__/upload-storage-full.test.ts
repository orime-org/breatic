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
  runMediaUpload,
  fillNodeFromFile,
  type MediaUploadDeps,
  type FillNodeDeps,
  type UploadFailure,
} from '@web/spaces/canvas/canvas-upload';

const CONFIG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 1,
  clientRetryBaseDelayMs: 1,
  clientRequestTimeoutMs: 30000,
  clientPutMinBytesPerSec: 65536,
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

describe('filling an existing node hands the failure to the one exit', () => {
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
      onTypeMismatch: () => {},
      // Shaped after `UploadLease` itself: a double whose return type differs
      // from the function it stands in for measures only the double.
      setHandling: () => ({ gen: 1, clientId: 7, userId: 'u1' }),
      setContent: () => true,
      setError: () => true,
      onUploadFailure: () => {},
      ...extra,
    } as unknown as FillNodeDeps;
  }

  it('hands storage over and writes nothing onto the node itself', async () => {
    const onUploadFailure = vi.fn((_outcome: UploadFailure) => {});
    const setError = vi.fn(() => true);
    await fillNodeFromFile('n1', pngFile(), 'image', 'p1', fillDeps({
      onUploadFailure,
      setError,
    }));
    expect(onUploadFailure).toHaveBeenCalledOnce();
    expect(onUploadFailure.mock.calls[0]?.[0]).toEqual({ reason: 'storage' });
    // The sentence the user reads is written by that one exit. Keeping a
    // second copy here would mean changing one of them leaves what the user
    // sees untouched.
    expect(setError).not.toHaveBeenCalled();
  });
});
