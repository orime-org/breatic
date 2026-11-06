// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { SCENE_FORMAT_VERSION } from '@breatic/shared';
import { SceneSession } from '@web/data/yjs/scene-session';
import { SceneModelImportDialog } from '@web/spaces/three-d/SceneModelImportDialog';
import SceneModelImportHost from '@web/spaces/three-d/SceneModelImportHost';
import { toast } from '@web/lib/toast';
import { ModelImportController } from '@web/spaces/three-d/model-import-controller';
import type { PreparedModel } from '@web/spaces/three-d/model-import-controller';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { UploadFailedError } from '@web/data/upload/media-upload';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';

vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, success: vi.fn() } };
});

const disposers: (() => void)[] = [];

/**
 * Supply a real document command owner behind the import dialog.
 * @returns The ready import operation and its original prepared input.
 * @throws {Error} When the scene session cannot be constructed.
 */
async function readyImport(): Promise<{ controller: ModelImportController; prepared: PreparedModel; upload: ReturnType<typeof vi.fn>; session: SceneSession }> {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  const prepared: PreparedModel = { file: new File(['model'], 'model.glb'), entry: 'model.glb', entries: ['model.glb'],
    paths: ['model.glb'], bounds: { center: [0, 0, 0], min: [0, 0, 0] }, dispose: vi.fn() };
  const upload = vi.fn().mockResolvedValue({ assetId: '44444444-4444-4444-8444-444444444444' });
  const controller = new ModelImportController({ session,
    prepare: async () => prepared, upload, position: () => [0, 0, 0] });
  disposers.push(() => { controller.dispose(); session.destroy(); doc.destroy(); });
  await controller.select([{ path: prepared.file.name, file: prepared.file }]);
  return { controller, prepared, upload, session };
}

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.clearAllMocks();
});

/**
 * Build a dropped directory entry whose reader answers when the test allows it.
 * @throws {never} Never.
 */
function droppedFolder(name: string, files: readonly File[], gate: Promise<void> = Promise.resolve()): FileSystemDirectoryEntry {
  const entries = files.map((file) => ({ isFile: true, isDirectory: false, name: file.name, fullPath: `/${name}/${file.name}`,
    file: (resolve: (value: File) => void) => resolve(file) }));
  return { isFile: false, isDirectory: true, name, fullPath: `/${name}`, createReader: () => {
    const batches = [entries, []];
    return { readEntries: (resolve: (value: unknown[]) => void) => { void gate.then(() => resolve(batches.shift() ?? [])); } };
  } } as unknown as FileSystemDirectoryEntry;
}

/**
 * Drop one folder entry on the dialog's drop zone as a browser does.
 * @throws {never} Never.
 */
function dropFolder(folder: FileSystemDirectoryEntry): void {
  const placeholder = new File([], folder.name);
  fireEvent.drop(screen.getByTestId('model-import-dropzone'), { dataTransfer: {
    types: ['Files'], files: [placeholder], items: [{ kind: 'file', webkitGetAsEntry: () => folder, getAsFile: () => placeholder }],
  } });
}

/**
 * Supply an idle import whose inspection is a test double.
 * @throws {never} Never.
 */
function idleImport(): { controller: ModelImportController; prepare: ReturnType<typeof vi.fn> } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  const prepare = vi.fn(() => new Promise<PreparedModel>(() => undefined));
  const controller = new ModelImportController({ session, upload: vi.fn(), position: () => [0, 0, 0], prepare });
  disposers.push(() => { controller.dispose(); session.destroy(); doc.destroy(); });
  return { controller, prepare };
}

describe('model import dialog folder drops (inner#1690)', () => {
  it('inspects a dropped folder with its files under the folder path', async () => {
    const { controller, prepare } = idleImport();
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    dropFolder(droppedFolder('hero', [new File(['{}'], 'scene.gltf'), new File(['x'], 'mesh.bin')]));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(prepare.mock.calls[0][0].map((source: { path: string }) => source.path)).toEqual(['hero/scene.gltf', 'hero/mesh.bin']);
  });

  it('keeps a later selection when an earlier folder drop finishes reading after it', async () => {
    const { controller, prepare } = idleImport();
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    const read = Promise.withResolvers<void>();
    dropFolder(droppedFolder('large', [new File(['x'], 'junk.txt')], read.promise));
    const later = [{ path: 'hero.glb', file: new File(['glb'], 'hero.glb') }];
    await act(async () => { void controller.select(later); });
    await act(async () => { read.resolve(); await read.promise; await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().files).toBe(later);
  });

  it('reports a dropped folder that holds no files', async () => {
    const { controller, prepare } = idleImport();
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    dropFolder(droppedFolder('empty', []));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(prepare.mock.calls[0][0]).toEqual([]);
  });
});

describe('model import dialog controls', () => {
  it('keeps the displayed name exact and disables browser input history', async () => {
    const { controller } = await readyImport();
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    const name = screen.getByRole('textbox');
    expect(name).toHaveValue('model');
    expect(name).toHaveAttribute('autoComplete', 'off');
    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, 'My character');
    expect(controller.getSnapshot().name).toBe('My character');
  });

  it('reports placement once and releases the completed local preview', async () => {
    const { controller, prepared, upload } = await readyImport();
    const onOpenChange = vi.fn();
    const onPlaced = vi.fn();
    const { rerender } = render(<SceneModelImportHost open onOpenChange={onOpenChange} onPlaced={onPlaced} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import to scene' }));
    await waitFor(() => expect(onPlaced).toHaveBeenCalledExactlyOnceWith(expect.any(String)));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Model imported.');
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', prepared: null, files: [] });
    rerender(<SceneModelImportHost open={false} onOpenChange={onOpenChange} onPlaced={onPlaced} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await controller.confirm();
    expect(onPlaced).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['storage', 'Studio storage is full. Uploading is unavailable.', false],
    ['hash', 'Couldn\'t verify this file. Reload the page and try again.', false],
    ['rateLimited', 'Uploading too often. Try again later.', true],
    ['transfer', 'The model could not be uploaded. Try again.', true],
  ] as const)('states a %s upload failure and offers Retry only when retrying can succeed', async (reason, message, retryable) => {
    const { controller, upload } = await readyImport();
    upload.mockRejectedValueOnce(new UploadFailedError(reason));
    await controller.confirm();
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    expect(screen.getByText(message)).toBeInTheDocument();
    if (retryable) expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    else {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Import to scene' })).toBeDisabled();
    }
  });

  it('states which import limit a selection exceeded, with both sizes', async () => {
    const doc = new Y.Doc();
    doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
    const session = new SceneSession(doc);
    session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
    const budget = { limit: 'expanded', allowed: 256 * 1024 * 1024, actual: 300 * 1024 * 1024 } as const;
    const controller = new ModelImportController({ session, upload: vi.fn(), position: () => [0, 0, 0],
      prepare: () => Promise.reject(new ModelImportError('budget', 'Model archive exceeds its expanded-byte budget', { detail: '', budget })) });
    disposers.push(() => { controller.dispose(); session.destroy(); doc.destroy(); });
    await controller.select([{ path: 'model.zip', file: new File(['zip'], 'model.zip') }]);
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    expect(screen.getByText('The model exceeds an import limit.')).toBeInTheDocument();
    expect(screen.getByText('Unpacked size 300 MiB; the limit is 256 MiB.')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ files?/)).toBeNull();
  });

  it('shows no floating opener for a cancelled ready, checking or failed import, as the approved demo does', async () => {
    const { controller } = await readyImport();
    const host = <SceneModelImportHost open={false} onOpenChange={vi.fn()} onPlaced={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />;
    render(host);
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    const checking = idleImport();
    render(<SceneModelImportHost open={false} onOpenChange={vi.fn()} onPlaced={vi.fn()} controller={checking.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { void checking.controller.select([{ path: 'a.glb', file: new File(['a'], 'a.glb') }]); });
    expect(checking.controller.getSnapshot().phase).toBe('checking');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    const failing = idleImport();
    failing.prepare.mockRejectedValueOnce(new ModelImportError('invalid', 'Unreadable', { detail: '' }));
    render(<SceneModelImportHost open={false} onOpenChange={vi.fn()} onPlaced={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.glb', file: new File(['a'], 'a.glb') }]); });
    expect(failing.controller.getSnapshot().phase).toBe('failed');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the uploading opener mounted while its dialog is open, so closing returns focus to it', async () => {
    const { controller, upload } = await readyImport();
    upload.mockReturnValueOnce(new Promise(() => undefined));
    void controller.confirm();
    const onOpenChange = vi.fn();
    const { rerender } = render(<SceneModelImportHost open={false} onOpenChange={onOpenChange} onPlaced={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    const opener = screen.getByRole('button', { name: 'Uploading 0%' });
    opener.focus();
    rerender(<SceneModelImportHost open onOpenChange={onOpenChange} onPlaced={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    expect(document.contains(opener)).toBe(true);
    rerender(<SceneModelImportHost open={false} onOpenChange={onOpenChange} onPlaced={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('keeps a registered model reachable while editing is unavailable', async () => {
    const { controller, upload, session } = await readyImport();
    upload.mockResolvedValueOnce({ assetId: '44444444-4444-4444-8444-444444444444' });
    session.setEnvironment({ readOnly: true, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
    await controller.confirm();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', assetId: '44444444-4444-4444-8444-444444444444' });
    render(<SceneModelImportHost open={false} onOpenChange={vi.fn()} onPlaced={vi.fn()} controller={controller} canEdit={false} maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    expect(screen.getByRole('button', { name: 'Import model' })).toBeEnabled();
  });

  it('keeps an uploading operation reachable through its hidden-dialog opener', async () => {
    const { controller, upload } = await readyImport();
    const pending = Promise.withResolvers<{ assetId: string }>();
    upload.mockReturnValueOnce(pending.promise);
    const confirmation = controller.confirm();
    const onOpenChange = vi.fn();
    render(<SceneModelImportHost open={false} onOpenChange={onOpenChange} onPlaced={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    const opener = screen.getByRole('button', { name: 'Uploading 0%' });
    expect(opener).toBeEnabled();
    await userEvent.setup().click(opener);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(controller.getSnapshot().phase).toBe('uploading');
    await act(async () => {
      pending.resolve({ assetId: '44444444-4444-4444-8444-444444444444' });
      await confirmation;
    });
  });

  it('keeps a prepared operation when the dialog is hidden and reopened', async () => {
    const { controller, prepared, upload } = await readyImport();
    const onOpenChange = vi.fn();
    const { rerender } = render(<SceneModelImportDialog open onOpenChange={onOpenChange} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<SceneModelImportDialog open={false} onOpenChange={onOpenChange} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', prepared });
    expect(prepared.dispose).not.toHaveBeenCalled();
    rerender(<SceneModelImportDialog open onOpenChange={onOpenChange} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    expect(screen.getByRole('textbox')).toHaveValue('model');
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('model import dialog failures outside the model (inner#1690)', () => {
  it('asks to try again when preparing fails for a reason other than the model content', async () => {
    const failing = idleImport();
    failing.prepare.mockRejectedValueOnce(new Error('Worker failed'));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.glb', file: new File(['a'], 'a.glb') }]); });
    expect(screen.getByText('The model could not be loaded. Try again.')).toBeInTheDocument();
    expect(screen.queryByText('The model or an accompanying file could not be read.')).toBeNull();
    const sources = failing.prepare.mock.calls[0][0] as unknown;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(failing.prepare).toHaveBeenCalledTimes(2);
    expect(failing.prepare.mock.calls[1][0]).toEqual(sources);
  });

  it('checks the chosen main file again and keeps keyboard focus on Retry while it runs', async () => {
    const failing = idleImport();
    failing.prepare.mockRejectedValueOnce(new Error('Worker failed'));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    const files = [{ path: 'a.glb', file: new File(['a'], 'a.glb') }, { path: 'b.glb', file: new File(['b'], 'b.glb') }];
    await act(async () => { await failing.controller.select(files, 'b.glb'); });
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    await act(async () => { fireEvent.click(retry); });
    expect(failing.prepare.mock.calls[1][1]).toBe('b.glb');
    expect(document.activeElement).toBe(retry);
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveTextContent('Retry');
  });

  it('offers no check Retry for a content verdict', async () => {
    const failing = idleImport();
    failing.prepare.mockRejectedValueOnce(new ModelImportError('invalid', 'Unreadable', { detail: '' }));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.glb', file: new File(['a'], 'a.glb') }]); });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('model import dialog footer during checks and after refusals (inner#1690)', () => {
  it('keeps Import to scene disabled, with no Retry, during a first check', async () => {
    const pending = idleImport();
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={pending.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { void pending.controller.select([{ path: 'a.glb', file: new File(['a'], 'a.glb') }]); });
    expect(screen.getByRole('button', { name: 'Import to scene' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows Retry only for the check Retry started, not for a main file chosen afterwards', async () => {
    const failing = idleImport();
    const files = [{ path: 'a.glb', file: new File(['a'], 'a.glb') }, { path: 'b.glb', file: new File(['b'], 'b.glb') }];
    failing.prepare.mockRejectedValueOnce(new Error('Worker failed'));
    failing.prepare.mockRejectedValueOnce(new ModelImportError('entry', 'Choose a model entry', { detail: '', info: { entries: ['a.glb', 'b.glb'], paths: ['a.glb', 'b.glb'], missing: [] } }));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select(files); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await act(async () => { void failing.controller.select(failing.controller.getSnapshot().files, 'b.glb'); });
    expect(failing.controller.getSnapshot().phase).toBe('checking');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Import to scene' })).toBeDisabled();
  });

  it('moves focus to Choose files when the retried check ends in a content verdict', async () => {
    const failing = idleImport();
    failing.prepare.mockRejectedValueOnce(new Error('Worker failed'));
    failing.prepare.mockRejectedValueOnce(new ModelImportError('invalid', 'Unreadable', { detail: '' }));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.glb', file: new File(['a'], 'a.glb') }]); });
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    await act(async () => { fireEvent.click(retry); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose files' })));
  });

  it('moves focus to Add resources when the retried check finds files missing', async () => {
    const failing = idleImport();
    failing.prepare.mockRejectedValueOnce(new Error('Worker failed'));
    failing.prepare.mockRejectedValueOnce(new ModelImportError('missing', 'Missing model resources: mesh.bin', { detail: '', info: { entries: [], paths: ['a.gltf'], missing: ['mesh.bin'] } }));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.gltf', file: new File(['{}'], 'a.gltf') }]); });
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    await act(async () => { fireEvent.click(retry); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add accompanying files' })));
  });

  it('moves focus to Choose files when an upload fails for a reason a retry cannot change', async () => {
    const { controller, upload } = await readyImport();
    upload.mockRejectedValueOnce(new UploadFailedError('storage'));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    const confirm = screen.getByRole('button', { name: 'Import to scene' });
    confirm.focus();
    await act(async () => { fireEvent.click(confirm); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose files' })));
  });

  it('keeps focus on Add accompanying files while its check runs and hands it to Import to scene when the model is ready', async () => {
    const failing = idleImport();
    const prepared: PreparedModel = { file: new File(['model'], 'a.gltf'), entry: 'a.gltf', entries: ['a.gltf'],
      paths: ['a.gltf', 'mesh.bin'], bounds: { center: [0, 0, 0], min: [0, 0, 0] }, dispose: vi.fn() };
    const ready = Promise.withResolvers<PreparedModel>();
    failing.prepare.mockRejectedValueOnce(new ModelImportError('missing', 'Missing model resources: mesh.bin', { detail: '', info: { entries: [], paths: ['a.gltf'], missing: ['mesh.bin'] } }));
    failing.prepare.mockReturnValueOnce(ready.promise);
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.gltf', file: new File(['{}'], 'a.gltf') }]); });
    const add = screen.getByRole('button', { name: 'Add accompanying files' });
    add.focus();
    fireEvent.click(add);
    await act(async () => { fireEvent.change(screen.getByTestId('model-import-dialog').querySelector('input[type="file"]')!, { target: { files: [new File(['b'], 'mesh.bin')] } }); });
    expect(failing.controller.getSnapshot().phase).toBe('checking');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add accompanying files' }));
    await act(async () => { ready.resolve(prepared); await ready.promise; });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Import to scene' })));
  });

  /**
   * Start a check from Add accompanying files after a missing-files refusal, leaving its result to the test.
   * @throws {never} Never directly.
   */
  async function supplementCheck(): Promise<PromiseWithResolvers<PreparedModel>> {
    const failing = idleImport();
    const result = Promise.withResolvers<PreparedModel>();
    failing.prepare.mockRejectedValueOnce(new ModelImportError('missing', 'Missing model resources: mesh.bin', { detail: '', info: { entries: [], paths: ['a.gltf'], missing: ['mesh.bin'] } }));
    failing.prepare.mockReturnValueOnce(result.promise);
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.gltf', file: new File(['{}'], 'a.gltf') }]); });
    const add = screen.getByRole('button', { name: 'Add accompanying files' });
    add.focus();
    fireEvent.click(add);
    await act(async () => { fireEvent.change(screen.getByTestId('model-import-dialog').querySelector('input[type="file"]')!, { target: { files: [new File(['b'], 'mesh.bin')] } }); });
    return result;
  }

  it('hands focus to Choose files when a check started from Add accompanying files ends in another refusal', async () => {
    const result = await supplementCheck();
    await act(async () => { result.reject(new ModelImportError('budget', 'Model is too large', { detail: '', budget: { limit: 'textureBytes', allowed: 1, actual: 2 } })); await result.promise.catch(() => undefined); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose files' })));
  });

  it('hands focus left on the dialog itself to Import to scene when the check ends ready', async () => {
    const result = await supplementCheck();
    // A browser's focus scope moves focus from an unmounted control to the dialog before React effects run.
    act(() => { screen.getByTestId('model-import-dialog').focus(); });
    await act(async () => {
      result.resolve({ file: new File(['model'], 'a.gltf'), entry: 'a.gltf', entries: ['a.gltf'], paths: ['a.gltf', 'mesh.bin'], bounds: { center: [0, 0, 0], min: [0, 0, 0] }, dispose: vi.fn() });
      await result.promise;
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Import to scene' })));
  });

  it('keeps the main-file choice mounted while the chosen file is checked', async () => {
    const failing = idleImport();
    const files = [{ path: 'a.glb', file: new File(['a'], 'a.glb') }, { path: 'b.glb', file: new File(['b'], 'b.glb') }];
    failing.prepare.mockRejectedValueOnce(new ModelImportError('entry', 'Choose a model entry', { detail: '', info: { entries: ['a.glb', 'b.glb'], paths: ['a.glb', 'b.glb'], missing: [] } }));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select(files); });
    const choice = screen.getByRole('combobox');
    choice.focus();
    await act(async () => { void failing.controller.select(failing.controller.getSnapshot().files, 'b.glb'); });
    expect(failing.controller.getSnapshot().phase).toBe('checking');
    expect(document.activeElement).toBe(choice);
  });

  it('asks for a main file as a prompt, not as a failure', async () => {
    const failing = idleImport();
    failing.prepare.mockRejectedValueOnce(new ModelImportError('entry', 'Choose a model entry', { detail: '', info: { entries: ['a.glb', 'b.glb'], paths: ['a.glb', 'b.glb'], missing: [] } }));
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={failing.controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    await act(async () => { await failing.controller.select([{ path: 'a.glb', file: new File(['a'], 'a.glb') }, { path: 'b.glb', file: new File(['b'], 'b.glb') }]); });
    const prompt = screen.getByText('Choose a main file to preview.');
    expect(prompt.closest('.text-status-error')).toBeNull();
    expect(prompt.parentElement?.querySelector('svg.lucide-triangle-alert')).toBeNull();
  });

  it('keeps focus in the name field when clearing the name disables Import to scene', async () => {
    const { controller } = await readyImport();
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    const name = screen.getByRole('textbox', { name: 'Model name' });
    name.focus();
    await act(async () => { fireEvent.change(name, { target: { value: '' } }); });
    expect(screen.getByRole('button', { name: 'Import to scene' })).toBeDisabled();
    expect(document.activeElement).toBe(name);
  });
});
