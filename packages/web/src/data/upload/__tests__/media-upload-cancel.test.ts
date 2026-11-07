// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { UploadClientConfig } from '@breatic/shared';
import type { UploadContext, UploadTicket, UploadTicketRequest, UploadTicketResponse } from '@web/data/upload/ingest-upload';
import type { UploadEnding } from '@web/data/upload/upload-status';
import { runMediaUpload } from '@web/data/upload/media-upload';

const CONFIG: UploadClientConfig = {
  maxUploadBytes: 2147483648, clientMaxAttempts: 3, clientRetryBaseDelayMs: 1000,
  uploadIdleTimeoutMs: 60000,
};
const FILE = new File(['model'], 'model.glb', { type: 'model/gltf-binary' });
const CONTEXT: UploadContext = { projectId: 'project-1', derived: true };
const HASH = 'a'.repeat(64);
const TICKET = {
  uploadId: 'upload-1', token: 'token-1', storageKey: 'file/model.glb',
  uploadUrl: 'https://ingest.example.test', kind: 'file', partSize: 8388608, totalParts: 1,
};
const QUEUED = { storageKey: TICKET.storageKey };
const COMPLETED: Extract<UploadEnding, { state: 'completed' }> = {
  key: TICKET.storageKey, state: 'completed',
  result: { assetId: 'asset-1', fileUrl: 'https://assets.example.test/model.glb', kind: 'file', width: null, height: null },
};

interface UploadTestDeps {
  getUploadConfig: Mock<() => Promise<UploadClientConfig>>;
  hashFile: Mock<(file: File, signal?: AbortSignal) => Promise<string | null>>;
  requestTicket: Mock<(params: UploadTicketRequest, signal?: AbortSignal) => Promise<UploadTicketResponse>>;
  sendToIngest: Mock<(file: File, ticket: UploadTicket, config: UploadClientConfig,
    onPartLanded?: (bytes: number) => void, signal?: AbortSignal) => Promise<typeof QUEUED>>;
  waitForEnding: Mock<(key: string, signal?: AbortSignal) => Promise<UploadEnding>>;
  onAnswered: Mock<() => void>;
  onRegistering: Mock<() => void>;
  onProgress: Mock<(fraction: number) => void>;
  onSuccess: Mock<(stored: typeof COMPLETED.result) => void>;
  onFailure: Mock<() => void>;
  sleep: Mock<() => Promise<void>>;
}

/**
 * Expose each upload dependency as a separately observable boundary.
 * @returns A complete node-free upload dependency set.
 * @throws {never} Never directly.
 */
function dependencies(): UploadTestDeps {
  return {
    getUploadConfig: vi.fn(async (): Promise<UploadClientConfig> => CONFIG),
    hashFile: vi.fn(async (_file: File, _signal?: AbortSignal): Promise<string | null> => HASH),
    requestTicket: vi.fn(async (_params: UploadTicketRequest, _signal?: AbortSignal): Promise<UploadTicketResponse> => TICKET),
    sendToIngest: vi.fn(async (_file: File, _ticket: UploadTicket, _config: UploadClientConfig,
      _onPartLanded?: (bytes: number) => void, _signal?: AbortSignal): Promise<typeof QUEUED> => QUEUED),
    waitForEnding: vi.fn(async (_key: string, _signal?: AbortSignal): Promise<UploadEnding> => COMPLETED),
    onAnswered: vi.fn(), onRegistering: vi.fn(), onProgress: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(),
    sleep: vi.fn(async (): Promise<void> => undefined),
  };
}

/**
 * Hold an asynchronous dependency until the test delivers its answer.
 * @returns The promise and its single completion function.
 * @throws {never} Never directly.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('runMediaUpload cancellation ownership', () => {
  it('rejects a pre-cancelled operation before fetching configuration', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = dependencies();

    await expect(runMediaUpload(FILE, CONTEXT, deps, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(deps.getUploadConfig).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
  });

  it.each(['config', 'hash', 'ticket', 'transfer', 'status'] as const)(
    'rejects cancellation during %s and ignores its late successful answer',
    async (stage) => {
      const controller = new AbortController();
      const deps = dependencies();
      switch (stage) {
        case 'config': deps.getUploadConfig.mockImplementationOnce(async () => { controller.abort(); return CONFIG; }); break;
        case 'hash': deps.hashFile.mockImplementationOnce(async () => { controller.abort(); return HASH; }); break;
        case 'ticket': deps.requestTicket.mockImplementationOnce(async () => { controller.abort(); return TICKET; }); break;
        case 'transfer': deps.sendToIngest.mockImplementationOnce(async () => { controller.abort(); return QUEUED; }); break;
        case 'status': deps.waitForEnding.mockImplementationOnce(async () => { controller.abort(); return COMPLETED; }); break;
      }

      await expect(runMediaUpload(FILE, CONTEXT, deps, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

      const stages = [deps.getUploadConfig, deps.hashFile, deps.requestTicket, deps.sendToIngest, deps.waitForEnding];
      const index = ['config', 'hash', 'ticket', 'transfer', 'status'].indexOf(stage);
      for (const later of stages.slice(index + 1)) expect(later).not.toHaveBeenCalled();
      expect(deps.onFailure).not.toHaveBeenCalled();
      expect(deps.onSuccess).not.toHaveBeenCalled();
    },
  );

  it.each(['config', 'hash', 'ticket', 'transfer', 'status'] as const)(
    'propagates an AbortError from %s without reporting an upload failure',
    async (stage) => {
      const controller = new AbortController();
      const deps = dependencies();
      const aborted = new DOMException('The operation was cancelled', 'AbortError');
      switch (stage) {
        case 'config': deps.getUploadConfig.mockImplementationOnce(async () => { controller.abort(); throw aborted; }); break;
        case 'hash': deps.hashFile.mockImplementationOnce(async () => { controller.abort(); throw aborted; }); break;
        case 'ticket': deps.requestTicket.mockImplementationOnce(async () => { controller.abort(); throw aborted; }); break;
        case 'transfer': deps.sendToIngest.mockImplementationOnce(async () => { controller.abort(); throw aborted; }); break;
        case 'status': deps.waitForEnding.mockImplementationOnce(async () => { controller.abort(); throw aborted; }); break;
      }

      await expect(runMediaUpload(FILE, CONTEXT, deps, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

      expect(deps.onFailure).not.toHaveBeenCalled();
      expect(deps.onSuccess).not.toHaveBeenCalled();
    },
  );

  it('threads the same cancellation signal through hashing, authorization, transfer and registration', async () => {
    const controller = new AbortController();
    const deps = dependencies();

    await runMediaUpload(FILE, CONTEXT, deps, controller.signal);

    expect(deps.hashFile).toHaveBeenCalledWith(FILE, controller.signal);
    expect(deps.requestTicket).toHaveBeenCalledWith({
      ...CONTEXT, filename: FILE.name, contentType: FILE.type, size: FILE.size, hash: HASH,
    }, controller.signal);
    expect(deps.sendToIngest).toHaveBeenCalledWith(FILE, TICKET, CONFIG, expect.any(Function), controller.signal);
    expect(deps.waitForEnding).toHaveBeenCalledWith(TICKET.storageKey, controller.signal);
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith(COMPLETED.result);
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('places the signal after an absent progress callback', async () => {
    const controller = new AbortController();
    const { onProgress: _onProgress, ...deps } = dependencies();

    await runMediaUpload(FILE, CONTEXT, deps, controller.signal);

    expect(deps.sendToIngest).toHaveBeenCalledWith(FILE, TICKET, CONFIG, undefined, controller.signal);
  });

  it('suppresses late transfer progress after cancellation', async () => {
    const controller = new AbortController();
    const deps = dependencies();
    deps.sendToIngest.mockImplementationOnce(async (_file, _ticket, _config, onPartLanded) => {
      controller.abort();
      onPartLanded?.(FILE.size);
      return QUEUED;
    });

    await expect(runMediaUpload(FILE, CONTEXT, deps, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(deps.onProgress).not.toHaveBeenCalled();
    expect(deps.onRegistering).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('does not hand back a late dedup result to a cancelled operation', async () => {
    const controller = new AbortController();
    const deps = dependencies();
    deps.requestTicket.mockImplementationOnce(async () => {
      controller.abort();
      return { alreadyExists: true, assetId: 'existing-asset', fileUrl: 'https://assets.example.test/existing.glb',
        kind: 'file', width: null, height: null };
    });

    await expect(runMediaUpload(FILE, CONTEXT, deps, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('enters registration after finish is queued and waits for the registered result', async () => {
    const finish = deferred<typeof QUEUED>();
    const registration = deferred<UploadEnding>();
    const entered = deferred<void>();
    const deps = dependencies();
    deps.sendToIngest.mockReturnValueOnce(finish.promise);
    deps.waitForEnding.mockImplementationOnce(() => { entered.resolve(); return registration.promise; });
    const running = runMediaUpload(FILE, CONTEXT, deps, new AbortController().signal);
    await vi.waitFor(() => expect(deps.sendToIngest).toHaveBeenCalledTimes(1));
    expect(deps.onRegistering).not.toHaveBeenCalled();

    finish.resolve(QUEUED);
    try {
      await entered.promise;
      expect(deps.onRegistering).toHaveBeenCalledTimes(1);
      expect(deps.onRegistering.mock.invocationCallOrder[0]).toBeLessThan(deps.waitForEnding.mock.invocationCallOrder[0]);
      expect(deps.onSuccess).not.toHaveBeenCalled();
    } finally {
      registration.resolve(COMPLETED);
      await running;
    }

    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith(COMPLETED.result);
  });

  it.each(['answered', 'registering'] as const)('honors cancellation from the %s callback', async (stage) => {
    const controller = new AbortController();
    const deps = dependencies();
    if (stage === 'answered') deps.onAnswered.mockImplementationOnce(() => controller.abort());
    else deps.onRegistering.mockImplementationOnce(() => controller.abort());

    await expect(runMediaUpload(FILE, CONTEXT, deps, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    if (stage === 'answered') expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.waitForEnding).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('retains the successful node-free flow when no cancellation signal is supplied', async () => {
    const { onProgress: _onProgress, onRegistering: _onRegistering, ...deps } = dependencies();

    await runMediaUpload(FILE, CONTEXT, deps);

    expect(deps.hashFile).toHaveBeenCalledWith(FILE, undefined);
    expect(deps.sendToIngest).toHaveBeenCalledWith(FILE, TICKET, CONFIG, undefined, undefined);
    expect(deps.waitForEnding).toHaveBeenCalledWith(TICKET.storageKey, undefined);
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith(COMPLETED.result);
    expect(deps.onFailure).not.toHaveBeenCalled();
  });
});
