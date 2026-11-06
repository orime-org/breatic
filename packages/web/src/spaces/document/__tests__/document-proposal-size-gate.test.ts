// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-82: an Agent proposal landing in a
 * document Space asks for room quietly first; a refusal ends the press as
 * `full` or `no_room`, which the proposal's own outcome toast reports, and a
 * landing that fits holds its room until the server has counted it.
 *
 * Driven through the real pickup hook and landing on a registered document,
 * so the outcome reaches the reader the way it does in the product.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import type { DocumentProposal } from '@breatic/shared';
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

import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api/assets';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { reserveSpaceRoom } from '@web/data/yjs/space-write';
import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { landProposal } from '@web/spaces/document/document-proposal-landing';
import { useDocumentProposalPickup } from '@web/spaces/document/use-document-proposal-pickup';
import { useDocumentProposals } from '@web/stores/document-proposals';
import { sizeGateProviders, type SizeGateProvider } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { confirmLatest, handshake, markSynced, openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_AFTER_WRITE,
  F_FULL,
  F_WARNING,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p1';
const SID = 'd1';
const NAME = docName.documentSpace(PID, SID);
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';

/**
 * An insert proposal appended after the last block.
 * @returns The proposal.
 */
function insertProposal(): DocumentProposal {
  return {
    proposalId: PROPOSAL_ID,
    spaceId: SID,
    spaceName: 'Script',
    kind: 'insert',
    blockId: null,
    body: 'Added line',
    title: 't',
    heading: '',
    original: '',
    blockType: null,
    lossy: false,
  };
}

/**
 * The plain text of each top-level block.
 * @param handle - The document.
 * @returns The texts.
 */
function texts(handle: DocumentEditorHandle): string[] {
  const out: string[] = [];
  handle.editor.prosemirrorState.doc.firstChild?.forEach((node) => {
    out.push(blockPlainText(node));
  });
  return out;
}

/**
 * The room available right now (a no_room result carries it, spec 0.3).
 * @returns The available room in bytes.
 * @throws {AssertionError} When the request was not refused for room.
 */
function roomNow(): number {
  const result = reserveSpaceRoom(NAME, 2 ** 40, { notify: false });
  expect(result).toMatchObject({ ok: false, reason: 'no_room' });
  return (result as { room: number }).room;
}

/**
 * Opens the registered document holding one paragraph, synced and confirmed,
 * then delivers one size push.
 * @param push - The size push.
 * @returns The handle and its provider.
 */
async function open(push: DocSizePush): Promise<{ handle: DocumentEditorHandle; provider: SizeGateProvider }> {
  const { doc, provider } = openSizedDoc(NAME);
  const handle = getDocumentEditor(doc, NAME, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: 'First' }] as never);
  handle.undoManager.clear();
  markSynced(provider);
  await handshake(NAME, provider);
  await confirmLatest(provider);
  pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
  return { handle, provider };
}

/**
 * Presses "write" on the proposal with the document's pickup mounted, and
 * waits for the press to end.
 * @param handle - The document.
 */
async function press(handle: DocumentEditorHandle): Promise<void> {
  renderHook(() => useDocumentProposalPickup(SID, handle, 'granted', false, NAME));
  act(() => {
    useDocumentProposals.getState().start(insertProposal(), 'write');
  });
  await waitFor(() => {
    expect(useDocumentProposals.getState().pending[PROPOSAL_ID]).toBeUndefined();
  });
}

const ADMITTED = (): { available: true; writeAccess: 'granted' } => ({ available: true, writeAccess: 'granted' });

beforeEach(() => {
  sizeGateProviders.length = 0;
  useDocumentProposals.getState().reset();
  // No prefix: only media would be left out, and this proposal has none.
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockRejectedValue(new Error('offline'));
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

describe('W-82 a document proposal in a full Space', () => {
  it('lands as full and leaves the body unchanged', async () => {
    const { handle } = await open(F_FULL);

    const result = await landProposal(handle, insertProposal(), 'write', ADMITTED);

    expect(result).toEqual({ outcome: 'refused', refusal: { ok: false, reason: 'full' } });
    expect(texts(handle)).toEqual(['First']);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('reports the full outcome once through the proposal toast', async () => {
    const { handle } = await open(F_FULL);

    await press(handle);

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_PROPOSAL_FULL);
    expect(toast.error).not.toHaveBeenCalled();
    expect(texts(handle)).toEqual(['First']);
  });
});

describe('a rewrite that shortens its block while the Space is full', () => {
  it('lands, as it takes out more than it puts in', async () => {
    const { handle } = await open(F_FULL);
    const id = (handle.editor.document[0] as { id: string }).id;
    const rewrite: DocumentProposal = { ...insertProposal(), kind: 'rewrite', blockId: id, body: 'Fi', original: 'First', blockType: 'paragraph' };

    const result = await landProposal(handle, rewrite, 'write', ADMITTED);

    expect(result).toMatchObject({ outcome: 'applied' });
    expect(texts(handle)).toEqual(['Fi']);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-82 a document proposal larger than the room left', () => {
  it('lands as no_room carrying the room', async () => {
    const { handle } = await open(F_WARNING_TIGHT);

    const result = await landProposal(handle, insertProposal(), 'write', ADMITTED);

    expect(result).toEqual({ outcome: 'refused', refusal: { ok: false, reason: 'no_room', room: 1 } });
    expect(texts(handle)).toEqual(['First']);
  });

  it('reports the no-room outcome once through the proposal toast', async () => {
    const { handle } = await open(F_WARNING_TIGHT);

    await press(handle);

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_PROPOSAL_NO_ROOM('1 B'));
    expect(toast.error).not.toHaveBeenCalled();
    expect(texts(handle)).toEqual(['First']);
  });
});

describe('W-82 a document proposal that fits', () => {
  it('applies on a reservation that is released after confirm and push', async () => {
    const { handle, provider } = await open(F_WARNING);

    await press(handle);

    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]?.state).toBe('applied');
    expect(texts(handle)).toEqual(['First', 'Added line']);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(roomNow()).toBeLessThan(786432);

    await confirmLatest(provider);
    pushSize(provider, F_AFTER_WRITE);
    expect(roomNow()).toBe(286432);
  });
});
