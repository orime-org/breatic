// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-76 to W-81: a file put into a document
 * body asks for room before it is uploaded, after its placeholder is drawn;
 * a refusal turns the placeholder into a retryable failure that says why,
 * and every way an upload ends gives the room back.
 *
 * Driven through the uploader the editor cache builds for a registered
 * document Space, so the body, its name and the size state are the ones a
 * real Space has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

const sequence = vi.hoisted(() => ({ log: [] as string[], quiet: false, slotsAtReserve: [] as number[], view: null as unknown }));
vi.mock('@web/data/yjs/space-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/yjs/space-write')>();
  const { uploadSlots } = await import('@web/spaces/document/document-upload-slots');
  return {
    ...actual,
    reserveSpaceRoom: vi.fn((...args: Parameters<typeof actual.reserveSpaceRoom>) => {
      if (!sequence.quiet) {
        sequence.log.push('reserve');
        const view = sequence.view as { state: Parameters<typeof uploadSlots>[0] } | null;
        if (view !== null) sequence.slotsAtReserve.push(uploadSlots(view.state).length);
      }
      return actual.reserveSpaceRoom(...args);
    }),
  };
});
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/data/upload/media-upload')>(),
  uploadMedia: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { assetsApi, type UploadConfig } from '@web/data/api/assets';
import { uploadMedia, UploadFailedError, type StoredUpload } from '@web/data/upload/media-upload';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { reserveSpaceRoom } from '@web/data/yjs/space-write';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { DocumentUploadPlaceholders } from '@web/spaces/document/DocumentUploadPlaceholders';
import { uploadSlots } from '@web/spaces/document/document-upload-slots';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { sizeGateProviders, type SizeGateProvider } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { confirmLatest, handshake, openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_AFTER_WRITE,
  F_FULL,
  F_NORMAL,
  F_WARNING,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';
import { gapBefore } from './textblocks';

const PID = 'p1';
const SID = 'd1';
const NAME = docName.documentSpace(PID, SID);

const UPLOAD_CONFIG: UploadConfig = {
  maxUploadBytes: 100_000_000,
  clientMaxAttempts: 1,
  clientRetryBaseDelayMs: 1,
  uploadIdleTimeoutMs: 1000,
  assetUrlPrefix: 'https://cdn.example.test/',
  uploadStatusPollSeconds: 5,
};

/** An upload the test settles by hand. */
interface Pending {
  file: File;
  resolve: (stored: StoredUpload) => void;
  reject: (err: unknown) => void;
}

let pending: Pending[] = [];

/**
 * The room available right now, read off a refusal no estimate can pass
 * (a no_room result carries the available room, spec 0.3).
 * @returns The available room in bytes.
 * @throws {AssertionError} When the request was not refused for room.
 */
function roomNow(): number {
  sequence.quiet = true;
  try {
    const result = reserveSpaceRoom(NAME, 2 ** 40, { notify: false });
    expect(result).toMatchObject({ ok: false, reason: 'no_room' });
    return (result as { room: number }).room;
  } finally {
    sequence.quiet = false;
  }
}

/**
 * Lets the uploader's awaits run.
 * @returns When they have.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Opens the document Space body holding A and B, with its placeholders drawn,
 * the seed confirmed, and one size push delivered.
 * @param push - The size push.
 * @returns The handle and its provider.
 */
async function open(push: DocSizePush): Promise<{ handle: DocumentEditorHandle; provider: SizeGateProvider; doc: Y.Doc }> {
  const { doc, provider } = openSizedDoc(NAME);
  const handle = getDocumentEditor(doc, NAME, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
    uploadTarget: { projectId: PID, spaceId: SID },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  handle.editor.replaceBlocks(handle.editor.document, [
    { type: 'paragraph', content: 'A' },
    { type: 'paragraph', content: 'B' },
  ] as never);
  render(React.createElement(DocumentUploadPlaceholders, { editor: handle.editor as never, uploader: handle.uploader!, readOnly: false }));
  await handshake(NAME, provider);
  await confirmLatest(provider);
  pushSize(provider, push);
  sequence.view = handle.editor.prosemirrorView;
  sequence.log.length = 0;
  sequence.slotsAtReserve.length = 0;
  vi.mocked(toast.warning).mockClear();
  return { handle, provider, doc };
}

/**
 * Starts one picture between A and B.
 * @param handle - The body.
 */
async function startPhoto(handle: DocumentEditorHandle): Promise<void> {
  const view = handle.editor.prosemirrorView!;
  const b = (handle.editor.document as Array<{ id: string }>)[1]!;
  await handle.uploader!.start(view, [new File([new Uint8Array(10)], 'photo.png', { type: 'image/png' })], () => gapBefore(view.state.doc, b.id), false);
  await settle();
}

/**
 * The single placeholder's slot.
 * @param handle - The body.
 * @returns The slot.
 */
function slot(handle: DocumentEditorHandle): ReturnType<typeof uploadSlots>[number] {
  const slots = uploadSlots(handle.editor.prosemirrorView!.state);
  expect(slots).toHaveLength(1);
  return slots[0]!;
}

/**
 * The block types of the body.
 * @param handle - The body.
 * @returns Each top-level block's type.
 */
function types(handle: DocumentEditorHandle): string[] {
  return (handle.editor.document as Array<{ type: string }>).map((block) => block.type);
}

const IMAGE: StoredUpload = { fileUrl: 'https://cdn.example.test/photo.png', assetId: 'a1', kind: 'image', width: null, height: null };

beforeEach(() => {
  sizeGateProviders.length = 0;
  pending = [];
  sequence.view = null;
  sequence.log.length = 0;
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue(UPLOAD_CONFIG);
  vi.mocked(uploadMedia).mockImplementation((file) => {
    sequence.log.push('upload');
    return new Promise<StoredUpload>((resolve, reject) => {
      pending.push({ file, resolve, reject });
    });
  });
  useSpaceOperationsStore.setState({ operations: {} });
});

afterEach(() => {
  cleanup();
  _resetDocumentEditorCacheForTests();
  _resetCollabSocketForTests();
  _resetForTests();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('W-76 a full Space refuses the upload before it is sent', () => {
  it('draws the placeholder first, then fails it as retryable and says the Space is full', async () => {
    const { handle, doc } = await open(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);

    await startPhoto(handle);

    expect(sequence.slotsAtReserve[0]).toBe(1);
    expect(slot(handle)).toMatchObject({ phase: 'failed', failure: { retryable: true } });
    const shown = screen.getByTestId('doc-upload-placeholder');
    expect(shown).toHaveTextContent(COPY_EN.T_UPLOAD_FAILED);
    expect(shown).toHaveTextContent(COPY_EN.T_SPACE_FULL_REASON);
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useSpaceOperationsStore.getState().operations[SID]).toBeUndefined();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-77 an estimate over the room refuses the upload before it is sent', () => {
  it('fails the placeholder as retryable with the no-room reason', async () => {
    const { handle } = await open(F_WARNING_TIGHT);

    await startPhoto(handle);

    expect(uploadMedia).not.toHaveBeenCalled();
    expect(slot(handle)).toMatchObject({ phase: 'failed', failure: { retryable: true } });
    const shown = screen.getByTestId('doc-upload-placeholder');
    expect(shown).toHaveTextContent(COPY_EN.T_UPLOAD_FAILED);
    expect(shown).toHaveTextContent(COPY_EN.T_NO_ROOM('1 B'));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-78 an upload that fits holds its room until the server has counted the block', () => {
  it('reserves before uploading, inserts on that reservation, and releases after confirm and push', async () => {
    const { handle, provider } = await open(F_WARNING);

    await startPhoto(handle);
    expect(sequence.log).toEqual(['reserve', 'upload']);
    const during = roomNow();
    expect(during).toBeLessThan(786432);

    pending[0]!.resolve(IMAGE);
    await settle();
    const media = (handle.editor.document as Array<{ type: string; props: Record<string, unknown> }>)[1]!;
    expect(media.type).toBe('image');
    expect(media.props.url).toBe(IMAGE.fileUrl);
    expect(roomNow()).toBe(during);

    await confirmLatest(provider);
    pushSize(provider, F_AFTER_WRITE);
    expect(roomNow()).toBe(286432);
  });
});

describe('W-79 an upload that ends without a block gives its room back', () => {
  it('releases when the upload fails', async () => {
    const { handle } = await open(F_WARNING);
    await startPhoto(handle);
    expect(roomNow()).toBeLessThan(786432);

    pending[0]!.reject(new UploadFailedError('upload'));
    await settle();

    expect(roomNow()).toBe(786432);
  });

  it('releases when the placeholder is taken away', async () => {
    const { handle } = await open(F_WARNING);
    await startPhoto(handle);
    expect(roomNow()).toBeLessThan(786432);

    act(() => {
      handle.uploader!.remove(handle.editor.prosemirrorView!, slot(handle).id);
    });
    await settle();

    expect(roomNow()).toBe(786432);
  });
});

describe('W-80 the Space filling up during the upload stops the insert', () => {
  it('fails the placeholder as full, writes no block and releases the room', async () => {
    const { handle, provider } = await open(F_WARNING);
    await startPhoto(handle);

    pushSize(provider, F_FULL);
    pending[0]!.resolve(IMAGE);
    await settle();

    expect(types(handle)).toEqual(['paragraph', 'paragraph']);
    expect(slot(handle)).toMatchObject({ phase: 'failed' });
    expect(screen.getByTestId('doc-upload-placeholder')).toHaveTextContent(COPY_EN.T_SPACE_FULL_REASON);
    pushSize(provider, F_WARNING);
    expect(roomNow()).toBe(786432);
  });
});

describe('W-81 a refused placeholder retries once there is room again', () => {
  it('asks for room again before sending, then lands the block', async () => {
    const { handle, provider } = await open(F_FULL);
    await startPhoto(handle);
    const id = slot(handle).id;

    pushSize(provider, F_NORMAL);
    sequence.log.length = 0;
    act(() => {
      handle.uploader!.retry(handle.editor.prosemirrorView!, id);
    });
    await settle();
    expect(sequence.log).toEqual(['reserve', 'upload']);
    expect(uploadMedia).toHaveBeenCalledTimes(1);

    pending[0]!.resolve(IMAGE);
    await settle();
    expect(types(handle)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(uploadSlots(handle.editor.prosemirrorView!.state)).toEqual([]);
  });

  it('fails again as full without sending while the Space is still full', async () => {
    const { handle } = await open(F_FULL);
    await startPhoto(handle);
    const id = slot(handle).id;

    act(() => {
      handle.uploader!.retry(handle.editor.prosemirrorView!, id);
    });
    await settle();

    expect(slot(handle)).toMatchObject({ phase: 'failed', failure: { retryable: true } });
    expect(screen.getByTestId('doc-upload-placeholder')).toHaveTextContent(COPY_EN.T_SPACE_FULL_REASON);
    expect(uploadMedia).not.toHaveBeenCalled();
  });
});
