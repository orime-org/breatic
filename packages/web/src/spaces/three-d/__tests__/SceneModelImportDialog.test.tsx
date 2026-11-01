// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
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
async function readyImport(): Promise<{ controller: ModelImportController; prepared: PreparedModel; upload: ReturnType<typeof vi.fn> }> {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', 1);
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  const prepared: PreparedModel = { file: new File(['model'], 'model.glb'), entry: 'model.glb', entries: ['model.glb'],
    paths: ['model.glb'], bounds: { center: [0, 0, 0], min: [0, 0, 0] }, dispose: vi.fn() };
  const upload = vi.fn().mockResolvedValue({ assetId: '44444444-4444-4444-8444-444444444444' });
  const controller = new ModelImportController({ session,
    prepare: async () => prepared, upload, position: () => [0, 0, 0] });
  disposers.push(() => { controller.dispose(); session.destroy(); doc.destroy(); });
  await controller.select([{ path: prepared.file.name, file: prepared.file }]);
  return { controller, prepared, upload };
}

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.clearAllMocks();
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
    doc.getMap('scene').set('formatVersion', 1);
    const session = new SceneSession(doc);
    session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
    const budget = { limit: 'expanded', allowed: 256 * 1024 * 1024, actual: 300 * 1024 * 1024 } as const;
    const controller = new ModelImportController({ session, upload: vi.fn(), position: () => [0, 0, 0],
      prepare: () => Promise.reject(new ModelImportError('budget', 'Model archive exceeds its expanded-byte budget', { detail: '', budget })) });
    disposers.push(() => { controller.dispose(); session.destroy(); doc.destroy(); });
    await controller.select([{ path: 'model.zip', file: new File(['zip'], 'model.zip') }]);
    render(<SceneModelImportDialog open onOpenChange={vi.fn()} controller={controller} canEdit maxInputBytes={IMPORT_LIMITS.maxInputBytes} />);
    expect(screen.getByText('The model exceeds an import limit.')).toBeInTheDocument();
    expect(screen.getByText('Unpacked size 300 MB; the limit is 256 MB.')).toBeInTheDocument();
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
