// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web spec RQ-05): an Agent proposal landing
 * in a document Space checks the size state quietly before writing; a refusal
 * ends the press with the reason the state gives (`full`, `over_ceiling`), the
 * body is untouched and the proposal's own outcome toast says so once.
 *
 * Driven through the real pickup hook and landing on a registered document,
 * so the outcome reaches the user the way it does in the product.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { DocumentProposal } from '@breatic/shared';

vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/size-v2-provider')).providerModuleV2(await importOriginal()));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api/assets';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
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
import {
  SIZE_COPY_EN,
  captureWriteAsync,
  enterSize,
  expectSizeToast,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import { providersV2, syncProviderV2, type ProviderV2 } from '@web/data/yjs/__tests__/helpers/size-v2-provider';

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
 * Opens the registered document holding one paragraph, connected and synced,
 * then puts it in one size state.
 * @param code - The size state.
 * @returns The handle and its document.
 */
function open(code: SizeCode): { handle: DocumentEditorHandle; doc: Y.Doc } {
  const doc = getDoc(NAME);
  const provider = acquireDocProvider(NAME, doc) as unknown as ProviderV2;
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
  syncProviderV2(provider);
  enterSize(NAME, code);
  vi.mocked(toast.warning).mockClear();
  return { handle, doc };
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
  providersV2.length = 0;
  useDocumentProposals.getState().reset();
  // No prefix: only media would be left out, and this proposal has none.
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockRejectedValue(new Error('offline'));
});

afterEach(() => {
  cleanup();
  clearAllDocSizes();
  _resetDocumentEditorCacheForTests();
  _resetCollabSocketForTests();
  _resetForTests();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('RQ-05 a document proposal in a Space that cannot take an add', () => {
  it.each([
    ['F', 'full'],
    ['O', 'over_ceiling'],
  ] as const)('RQ-05 [%s] lands as refused with the state\'s reason and writes nothing', async (code, reason) => {
    const { handle, doc } = open(code);

    const captured = await captureWriteAsync(doc, () => landProposal(handle, insertProposal(), 'write', ADMITTED));

    expect(captured.result).toEqual({ outcome: 'refused', refusal: { ok: false, reason } });
    expect(captured.shape).toBe('∅');
    expect(texts(handle)).toEqual(['First']);
    expectSizeToast(null);
  });

  it.each(['F', 'O'] as const)('RQ-05 [%s] the proposal toast says it was not placed, once', async (code) => {
    const { handle } = open(code);

    await press(handle);

    expectSizeToast(SIZE_COPY_EN.T_PROPOSAL);
    expect(texts(handle)).toEqual(['First']);
  });

  it('RQ-05 [W] a proposal with room applies without a size toast (control)', async () => {
    const { handle } = open('W');

    await press(handle);

    expect(useDocumentProposals.getState().cards[PROPOSAL_ID]?.state).toBe('applied');
    expect(texts(handle)).toEqual(['First', 'Added line']);
    expectSizeToast(null);
  });
});
