// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec RQ-10
 * and RQ-11: a 3D model import asks the server before anything is written, so
 * `scene-uploads.ts` checks `canAdd` first. Confirming the import dialog on a
 * full Space sends nothing and the dialog says why (answer Q10: in the
 * dialog, no toast); Retry on a failed task row sends nothing, warns once
 * and keeps the row and its file.
 *
 * The store is the real `createSceneUploads` with the network replaced by a
 * recorder; its `notify` is wired as `getSceneUploads` wires it, so the toast
 * is the same whichever way the store reports it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({ toast, muteToasts: vi.fn(), _unmuteToastsForTests: vi.fn() }));

import type { UploadContext } from '@web/data/upload/ingest-upload';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import {
  evictModelImportController, getModelImportController, type ModelImportInputs, type ModelImportSnapshot, type PreparedModel,
} from '@web/spaces/three-d/model-import-controller';
import { createSceneUploads, type SceneUploadDeps, type SceneUploadSinks } from '@web/spaces/three-d/scene-uploads';
import { P_WARNING, SIZE_COPY_EN, enterSize, expectSizeToast, pushSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PROJECT = '22222222-2222-4222-8222-222222222222';
const SPACE = '33333333-3333-4333-8333-333333333333';
const NAME = docName.threeDSpace(PROJECT, SPACE);
const lamp = new File(['bytes'], 'lamp.glb', { type: 'model/gltf-binary' });

interface Run {
  file: File;
  context: UploadContext;
  sinks: SceneUploadSinks;
}

/**
 * A store whose network is a recorder; each run's ticket opens row `t<n>`.
 * @returns The store and its recorded runs.
 */
function harness(): { store: ReturnType<typeof createSceneUploads>; runs: Run[] } {
  const runs: Run[] = [];
  const deps: SceneUploadDeps = {
    run: vi.fn((file: File, context: UploadContext, sinks: SceneUploadSinks) => {
      runs.push({ file, context, sinks });
      sinks.onAnswered?.(`t${runs.length}`);
      return new Promise<void>(() => undefined);
    }),
    reportFailure: vi.fn(async () => undefined),
    register: vi.fn(),
    unregister: vi.fn(),
    // As `getSceneUploads` wires it.
    notify: ({ toastKey, severity, filename }) => { toast[severity](t(toastKey, { filename })); },
  };
  return { store: createSceneUploads(deps), runs };
}

/**
 * The sentence the import dialog shows for a failed snapshot, read the way
 * `SceneModelImportDialog` reads it.
 * @param snapshot - The controller snapshot.
 * @returns The sentence.
 */
function dialogError(snapshot: ModelImportSnapshot): string {
  const failedUpload = snapshot.phase === 'failed' && snapshot.prepared !== null;
  const uploadFailure = failedUpload ? snapshot.uploadFailure : null;
  if (snapshot.error instanceof ModelImportError) return `ModelImportError ${snapshot.error.code}`;
  return uploadFailure ? t(uploadFailure.key, uploadFailure.params) : t('spaces.threeD.importModel.errorLoad');
}

afterEach(() => {
  evictModelImportController(NAME);
  clearAllDocSizes();
  _resetForTests();
  vi.clearAllMocks();
});

describe('RQ-10 confirming a model import on a full Space', () => {
  it('RQ-10 at F sends nothing, opens no task row and the dialog shows the add sentence', async () => {
    const { store, runs } = harness();
    const doc = getDoc(NAME);
    const prepared: PreparedModel = { file: lamp, entry: 'lamp.glb', entries: ['lamp.glb'], bounds: { center: [0, 0, 0], min: [0, 0, 0] }, dispose: vi.fn() };
    const inputs: ModelImportInputs = {
      prepare: vi.fn<ModelImportInputs['prepare']>().mockResolvedValue(prepared),
      start: (file, label) => store.start({ projectId: PROJECT, spaceId: SPACE, file, label }),
    };
    const controller = getModelImportController(doc, NAME, inputs);
    await controller.select([{ path: 'lamp.glb', file: lamp }]);
    controller.setName('Lamp');
    enterSize(NAME, 'F');
    toast.warning.mockClear();

    await expect(controller.confirm()).resolves.toBeNull();

    expect(runs).toHaveLength(0);
    expect(store.list(SPACE)).toEqual([]);
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('failed');
    expect(dialogError(snapshot)).toBe(SIZE_COPY_EN.T_ADD);
    expectSizeToast(null);
  });
});

describe('RQ-11 Retry on a failed task row of a full Space', () => {
  it('RQ-11 at F sends nothing, warns once and keeps the row and its file; back at warning it sends', async () => {
    const { store, runs } = harness();
    const started = store.start({ projectId: PROJECT, spaceId: SPACE, file: lamp, label: 'Lamp' });
    await expect(started).resolves.toEqual({ kind: 'opened', taskId: 't1' });
    runs[0].sinks.onFailure({ reason: 'transfer', taskId: 't1' });
    expect(store.get('t1')).toMatchObject({ phase: 'retained', file: lamp });
    enterSize(NAME, 'F');
    toast.warning.mockClear();

    await store.retry('t1');

    expect(runs).toHaveLength(1);
    expectSizeToast(SIZE_COPY_EN.T_ADD);
    expect(store.get('t1')).toMatchObject({ phase: 'retained', file: lamp });

    pushSize(NAME, P_WARNING);
    void store.retry('t1');
    expect(runs).toHaveLength(2);
  });
});
