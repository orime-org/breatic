// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashFile } from '@web/data/upload/hash';

const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const FILE = new File(['abc'], 'model.glb');

/** A manually completed worker exposes termination and late deliveries. */
class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  /** Record the worker created by the actual hash facade. */
  constructor() { ControlledWorker.instances.push(this); }
}

beforeEach(() => {
  ControlledWorker.instances = [];
  vi.stubGlobal('Worker', ControlledWorker);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('hashFile cancellation', () => {
  it('rejects a pre-cancelled hash before constructing a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    const running = Promise.resolve().then(() => hashFile(FILE, controller.signal));
    // Complete an erroneously created worker so the failing baseline also settles.
    await Promise.resolve();
    ControlledWorker.instances[0]?.onmessage?.({ data: { hash: HASH } } as MessageEvent);

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it('terminates an active worker once and ignores its late successful answer', async () => {
    const controller = new AbortController();
    const running = hashFile(FILE, controller.signal);
    const worker = ControlledWorker.instances[0];
    controller.abort();
    worker.onmessage?.({ data: { hash: HASH } } as MessageEvent);

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ file: FILE });
  });

  it('keeps cancellation distinct from a late worker failure', async () => {
    const controller = new AbortController();
    const running = hashFile(FILE, controller.signal);
    const worker = ControlledWorker.instances[0];
    controller.abort();
    worker.onerror?.(new Error('worker ended'));

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed hash stable when the signal is cancelled later', async () => {
    const controller = new AbortController();
    const running = hashFile(FILE, controller.signal);
    const worker = ControlledWorker.instances[0];
    worker.onmessage?.({ data: { hash: HASH } } as MessageEvent);
    await expect(running).resolves.toBe(HASH);

    controller.abort();
    worker.onmessage?.({ data: { hash: 'late result' } } as MessageEvent);

    await expect(running).resolves.toBe(HASH);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('preserves the hash result with a live signal', async () => {
    const running = hashFile(FILE, new AbortController().signal);
    const worker = ControlledWorker.instances[0];
    worker.onmessage?.({ data: { hash: HASH } } as MessageEvent);

    await expect(running).resolves.toBe(HASH);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
