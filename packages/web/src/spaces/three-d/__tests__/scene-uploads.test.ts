// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it, vi } from 'vitest';
import type { UploadContext } from '@web/data/upload/ingest-upload';
import { createSceneUploads, type SceneUploadDeps, type SceneUploadSinks } from '@web/spaces/three-d/scene-uploads';

interface Run {
  file: File;
  context: UploadContext;
  sinks: SceneUploadSinks;
}

/**
 * A store whose network is a recorder the case drives by hand.
 * @returns The store, its recorded runs and its other doubles.
 */
function harness(): {
  store: ReturnType<typeof createSceneUploads>;
  runs: Run[];
  deps: { [K in keyof SceneUploadDeps]: ReturnType<typeof vi.fn> };
  busy: (spaceId: string) => number;
  } {
  const runs: Run[] = [];
  const ops = new Map<string, number>();
  const deps = {
    run: vi.fn((file: File, context: UploadContext, sinks: SceneUploadSinks) => {
      runs.push({ file, context, sinks });
      return new Promise<void>(() => undefined);
    }),
    reportFailure: vi.fn(async () => undefined),
    register: vi.fn((spaceId: string) => { ops.set(spaceId, (ops.get(spaceId) ?? 0) + 1); }),
    unregister: vi.fn((spaceId: string) => { ops.set(spaceId, (ops.get(spaceId) ?? 0) - 1); }),
    notify: vi.fn(),
  };
  const store = createSceneUploads(deps as unknown as SceneUploadDeps);
  return { store, runs, deps, busy: (spaceId) => ops.get(spaceId) ?? 0 };
}

const P = 'project-1';
const S = 'space-1';
const lamp = new File(['bytes'], 'lamp.glb', { type: 'model/gltf-binary' });

/**
 * Begin one import and answer its ticket.
 * @param h - The harness.
 * @param taskId - The row the ticket opens.
 * @returns The run.
 */
async function opened(h: ReturnType<typeof harness>, taskId: string): Promise<Run> {
  const started = h.store.start({ projectId: P, spaceId: S, file: lamp, label: 'Lamp' });
  const run = h.runs.at(-1)!;
  run.sinks.onAnswered?.(taskId);
  await expect(started).resolves.toEqual({ kind: 'opened', taskId });
  return run;
}

describe('starting a scene upload', () => {
  it('asks for a scene model ticket naming the Space and the model', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    expect(run.file).toBe(lamp);
    expect(run.context).toEqual({ projectId: P, purpose: 'scene_model', spaceId: S, label: 'Lamp' });
  });

  it('holds the Space busy from the start until the bytes are delivered', async () => {
    const h = harness();
    const started = h.store.start({ projectId: P, spaceId: S, file: lamp, label: 'Lamp' });
    expect(h.busy(S)).toBe(1);
    h.runs[0]!.sinks.onAnswered?.('t1');
    await started;
    expect(h.busy(S)).toBe(1);
    h.runs[0]!.sinks.onRegistering?.();
    expect(h.busy(S)).toBe(0);
    expect(h.store.get('t1')).toMatchObject({ phase: 'registering' });
  });

  it('records integer progress and tells listeners only when it changes', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    const listener = vi.fn();
    h.store.subscribe(listener);
    run.sinks.onProgress?.(0.421);
    run.sinks.onProgress?.(0.429);
    run.sinks.onProgress?.(0.43);
    expect(h.store.get('t1')).toMatchObject({ phase: 'uploading', percent: 43 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ends a dedup hit at once: no entry, nothing held', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onSuccess({ fileUrl: 'u', assetId: 'a', kind: 'file', width: null, height: null });
    expect(h.store.get('t1')).toBeUndefined();
    expect(h.busy(S)).toBe(0);
  });

  it('answers a refusal before any row with its reason and holds nothing', async () => {
    const h = harness();
    const started = h.store.start({ projectId: P, spaceId: S, file: lamp, label: 'Lamp' });
    h.runs[0]!.sinks.onFailure({ reason: 'storage' });
    await expect(started).resolves.toEqual({ kind: 'refused', reason: 'storage' });
    expect(h.store.list(S)).toEqual([]);
    expect(h.busy(S)).toBe(0);
  });

  it('keeps imports apart: each has its own entry and its own hold on the Space', async () => {
    const h = harness();
    await opened(h, 't1');
    await opened(h, 't2');
    expect(h.store.list(S).map((entry) => entry.taskId)).toEqual(['t1', 't2']);
    expect(h.busy(S)).toBe(2);
    h.runs[0]!.sinks.onRegistering?.();
    expect(h.busy(S)).toBe(1);
  });
});

describe('a scene upload that fails after its row opened', () => {
  it('reports bytes that never reached the edge and keeps the file for a retry', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onFailure({ reason: 'transfer', taskId: 't1' });
    expect(h.deps.reportFailure).toHaveBeenCalledWith(P, S, 't1');
    expect(h.store.get('t1')).toMatchObject({ phase: 'retained', file: lamp });
    expect(h.busy(S)).toBe(0);
  });

  it('keeps the file when a retry can end differently, and says why', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onRegistering?.();
    run.sinks.onFailure({ reason: 'upload', taskId: 't1' });
    expect(h.store.get('t1')).toMatchObject({ phase: 'retained' });
    expect(h.deps.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', filename: 'lamp.glb' }));
  });

  it('lets the file go when a retry would meet the same refusal', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onFailure({ reason: 'unsupportedType', taskId: 't1' });
    expect(h.store.get('t1')).toBeUndefined();
    expect(h.deps.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning' }));
  });
});

describe('retrying', () => {
  it('hands the file to the new row and holds the Space while it starts', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onFailure({ reason: 'transfer', taskId: 't1' });

    const retried = h.store.retry('t1');
    expect(h.store.get('t1')).toMatchObject({ phase: 'retrying' });
    expect(h.busy(S)).toBe(1);
    const again = h.runs.at(-1)!;
    expect(again.file).toBe(lamp);
    expect(again.context).toMatchObject({ label: 'Lamp', spaceId: S });
    again.sinks.onAnswered?.('t2');
    await expect(retried).resolves.toEqual({ kind: 'opened', taskId: 't2' });

    expect(h.store.get('t1')).toBeUndefined();
    expect(h.store.get('t2')).toMatchObject({ phase: 'uploading', file: lamp });
  });

  it('leaves the file on the old row when the retry cannot start, and says why', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onFailure({ reason: 'transfer', taskId: 't1' });
    const retried = h.store.retry('t1');
    h.runs.at(-1)!.sinks.onFailure({ reason: 'rateLimited' });
    await expect(retried).resolves.toEqual({ kind: 'refused', reason: 'rateLimited' });
    expect(h.store.get('t1')).toMatchObject({ phase: 'retained' });
    expect(h.busy(S)).toBe(0);
    expect(h.deps.notify).toHaveBeenCalled();
  });

  it('does nothing for a row this page holds no file for', async () => {
    const h = harness();
    await expect(h.store.retry('nobody')).resolves.toEqual({ kind: 'missing' });
    expect(h.runs).toEqual([]);
  });
});

describe('reconciling against the Space list', () => {
  it('lets the file go once the row is done or expired, and keeps it on a failed row', async () => {
    const h = harness();
    const done = await opened(h, 't1');
    const failed = await opened(h, 't2');
    const expired = await opened(h, 't3');
    for (const run of [done, failed, expired]) run.sinks.onRegistering?.();

    h.store.reconcile(S, [{ id: 't1', status: 'done' }, { id: 't2', status: 'failed' }, { id: 't3', status: 'expired' }]);

    expect(h.store.get('t1')).toBeUndefined();
    expect(h.store.get('t2')).toMatchObject({ phase: 'retained' });
    expect(h.store.get('t3')).toBeUndefined();
  });

  it('lets a retained file go when its row, once listed, is removed', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onFailure({ reason: 'transfer', taskId: 't1' });
    h.store.reconcile(S, [{ id: 't1', status: 'running' }]);
    expect(h.store.get('t1')).toMatchObject({ phase: 'retained' });
    h.store.reconcile(S, []);
    expect(h.store.get('t1')).toBeUndefined();
  });

  it('lets the file go once its registration ends in a model, without waiting for the list', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onRegistering?.();
    run.sinks.onRegistered?.();
    expect(h.store.get('t1')).toBeUndefined();
  });

  it('keeps a row it has not seen listed yet', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onRegistering?.();
    h.store.reconcile(S, []);
    expect(h.store.get('t1')).toMatchObject({ phase: 'registering' });
  });

  it('keeps sending a row that expired mid-upload, then lets the file go once delivered', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    h.store.reconcile(S, [{ id: 't1', status: 'expired' }]);
    expect(h.store.get('t1')).toMatchObject({ phase: 'uploading' });
    run.sinks.onRegistering?.();
    expect(h.store.get('t1')).toBeUndefined();
    expect(h.busy(S)).toBe(0);
  });

  it('leaves other Spaces alone', async () => {
    const h = harness();
    const run = await opened(h, 't1');
    run.sinks.onRegistering?.();
    h.store.reconcile('space-2', [{ id: 't1', status: 'done' }]);
    expect(h.store.get('t1')).toMatchObject({ phase: 'registering' });
  });
});
