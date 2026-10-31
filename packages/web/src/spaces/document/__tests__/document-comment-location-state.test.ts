// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Explicit comment commands and ordinary reading share one real plugin state. */

import { act } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type { DocumentProposal } from '@breatic/shared';

import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { openCommentDraft } from '@web/spaces/document/document-comment-entries';
import { DRAFT_THREAD_ID } from '@web/spaces/document/document-comment-draft-range';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { commentOn } from '@web/spaces/document/document-comment-post';
import {
  commentLocationIn,
  hoverThread,
  onCommentLocationChange,
  onSelectedThreadsChange,
  requestCommentLocation,
  selectThreads,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import { landedAt } from '@web/spaces/document/document-proposal-landing';
import { isCurrentProposalLocation, type ProposalLocation } from '@web/spaces/document/document-proposal-location';
import { useDocumentProposals } from '@web/stores/document-proposals';

interface Fixture {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly name: string;
  readonly handle: DocumentEditorHandle;
  readonly proposal: DocumentProposal;
  readonly threadId: string;
  readonly otherThreadId: string;
}

const fixtures: Array<Pick<Fixture, 'doc' | 'awareness'>> = [];
const subscriptions: Array<() => void> = [];
let nextDocument = 0;

/**
 * Reads the fixture's first text run from its actual editor state.
 * @param handle - The fixture's cached editor.
 * @returns The first text run's positions.
 * @throws {Error} If the fixture has no text.
 */
function firstRun(handle: DocumentEditorHandle): { from: number; to: number } {
  let result: { from: number; to: number } | undefined;
  handle.editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText && result === undefined) result = { from: pos, to: pos + node.nodeSize };
    return true;
  });
  if (result === undefined) throw new Error('The fixture has no text.');
  return result;
}

/**
 * Builds a cached document with two real anchored comment threads.
 * @returns The document, comments and their proposal.
 * @throws {Error} If the fixture cannot create both threads.
 */
async function open(): Promise<Fixture> {
  nextDocument += 1;
  const name = `project-p/document-location-state-${String(nextDocument)}`;
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const handle = getDocumentEditor(doc, name, {
    caretProvider: { awareness },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  fixtures.push({ doc, awareness });
  act(() => {
    const host = document.createElement('div');
    document.body.append(host);
    adoptDocumentEditor(handle, host);
    handle.editor.replaceBlocks(handle.editor.document, [
      { id: 'target', type: 'paragraph', content: 'alpha bravo charlie' },
    ] as never);
  });
  const proposal: DocumentProposal = {
    proposalId: '33333333-3333-4333-8333-333333333333',
    spaceId: '44444444-4444-4444-8444-444444444444',
    spaceName: 'Storyboard',
    kind: 'comment',
    blockId: 'target',
    original: 'alpha bravo charlie',
    quote: 'alpha',
    body: 'Agent observation',
    title: 'Observation',
    heading: '',
    blockType: 'paragraph',
    lossy: false,
  };
  const run = firstRun(handle);
  const thread = await commentOn(handle.editor, asCommentBody(proposal.body), () => [{ from: run.from, to: run.from + 5 }], {
    thread: { proposalId: proposal.proposalId },
    comment: { fromAgent: true },
  });
  const other = await commentOn(handle.editor, asCommentBody('Another observation'), () => [{ from: run.from + 6, to: run.from + 11 }]);
  if (thread === null || other === null) throw new Error('The fixture did not create both threads.');
  const fixture = { doc, awareness, name, handle, proposal, threadId: thread.id, otherThreadId: other.id };
  return fixture;
}

/**
 * Creates the same immutable publication shape as a valid completion.
 * @param fixture - The cached document and its anchored proposal.
 * @returns A fresh immutable publication.
 * @throws {Error} If the fixture has no valid pending landing.
 */
function locationFor(fixture: Fixture): ProposalLocation {
  useDocumentProposals.getState().view(fixture.proposal, 'comment');
  const pending = useDocumentProposals.getState().pending[fixture.proposal.proposalId];
  const at = landedAt(fixture.handle, fixture.proposal);
  if (pending === undefined || at?.how !== 'comment') throw new Error('The fixture has no valid pending landing.');
  return Object.freeze({ ...at, documentName: fixture.name, handle: fixture.handle, pending, owner: {} });
}

/**
 * Issues one command and then performs its normal pending-request completion.
 * @param fixture - The document receiving the command.
 * @returns The publication issued by this command.
 * @throws {Error} If the fixture has no valid pending landing.
 */
function publish(fixture: Fixture): ProposalLocation {
  const location = locationFor(fixture);
  act(() => {
    requestCommentLocation(fixture.handle.editor, location);
    useDocumentProposals.getState().report(fixture.proposal.proposalId, 'applied');
  });
  return location;
}

afterEach(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  act(() => _resetDocumentEditorCacheForTests());
  fixtures.splice(0).forEach((fixture) => {
    fixture.awareness.destroy();
    fixture.doc.destroy();
  });
  useDocumentProposals.getState().reset();
  document.body.innerHTML = '';
});

describe('the current explicit comment command', () => {
  it('broadcasts the selected IDs and publication from the same transaction', async () => {
    const fixture = await open();
    const editor = fixture.handle.editor;
    const location = locationFor(fixture);
    const selected: Array<{ ids: readonly string[]; location: ProposalLocation | null }> = [];
    const located: Array<{ ids: readonly string[]; location: ProposalLocation | null }> = [];
    subscriptions.push(onSelectedThreadsChange(() => {
      selected.push({ ids: selectedThreadsIn(editor.prosemirrorState), location: commentLocationIn(editor.prosemirrorState) });
    }));
    subscriptions.push(onCommentLocationChange(() => {
      located.push({ ids: selectedThreadsIn(editor.prosemirrorState), location: commentLocationIn(editor.prosemirrorState) });
    }));

    expect(commentLocationIn(editor.prosemirrorState)).toBeNull();
    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([]);
    act(() => requestCommentLocation(editor, location));

    expect(selected).toEqual([{ ids: [fixture.threadId], location }]);
    expect(located).toEqual([{ ids: [fixture.threadId], location }]);
    expect(commentLocationIn(editor.prosemirrorState)).toBe(location);
  });

  it('independently broadcasts a fresh command with the same selected IDs', async () => {
    const fixture = await open();
    const editor = fixture.handle.editor;
    const first = publish(fixture);
    const ids = selectedThreadsIn(editor.prosemirrorState);
    const selected: Array<readonly string[]> = [];
    const located: Array<ProposalLocation | null> = [];
    subscriptions.push(onSelectedThreadsChange(() => selected.push(selectedThreadsIn(editor.prosemirrorState))));
    subscriptions.push(onCommentLocationChange(() => located.push(commentLocationIn(editor.prosemirrorState))));

    const second = publish(fixture);

    expect(second === first).toBe(false);
    expect(selectedThreadsIn(editor.prosemirrorState)).toBe(ids);
    expect(selected).toEqual([]);
    expect(located).toEqual([second]);
    expect(commentLocationIn(editor.prosemirrorState)).toBe(second);
    expect(useDocumentProposals.getState().pending).toEqual({});
    expect(isCurrentProposalLocation(second, editor)).toBe(true);
  });

  it('preserves command and selection identity for an ordinary repeated card press', async () => {
    const fixture = await open();
    const editor = fixture.handle.editor;
    const location = publish(fixture);
    const ids = selectedThreadsIn(editor.prosemirrorState);
    const located: Array<ProposalLocation | null> = [];
    subscriptions.push(onCommentLocationChange(() => located.push(commentLocationIn(editor.prosemirrorState))));

    act(() => selectThreads(editor, [fixture.threadId]));

    expect(selectedThreadsIn(editor.prosemirrorState)).toBe(ids);
    expect(commentLocationIn(editor.prosemirrorState)).toBe(location);
    expect(located).toEqual([]);
  });

  it.each(['other', 'overlap', 'draft', 'clear'] as const)('ends the explicit command when ordinary reading changes to %s', async (reading) => {
    const fixture = await open();
    const editor = fixture.handle.editor;
    publish(fixture);
    const located: Array<ProposalLocation | null> = [];
    subscriptions.push(onCommentLocationChange(() => located.push(commentLocationIn(editor.prosemirrorState))));
    const expected = reading === 'other' ? [fixture.otherThreadId]
      : reading === 'overlap' ? [fixture.threadId, fixture.otherThreadId]
        : reading === 'draft' ? [DRAFT_THREAD_ID] : [];

    act(() => {
      if (reading === 'draft') {
        const run = firstRun(fixture.handle);
        expect(openCommentDraft(editor, [{ from: run.from + 12, to: run.to }])).toBe(true);
      } else selectThreads(editor, expected);
    });

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual(expected);
    expect(commentLocationIn(editor.prosemirrorState)).toBeNull();
    expect(located).toEqual([null]);
  });

  it('keeps the command through hover and document edits while the anchor remains', async () => {
    const fixture = await open();
    const editor = fixture.handle.editor;
    const location = publish(fixture);
    const ids = selectedThreadsIn(editor.prosemirrorState);
    const located: Array<ProposalLocation | null> = [];
    subscriptions.push(onCommentLocationChange(() => located.push(commentLocationIn(editor.prosemirrorState))));

    act(() => {
      hoverThread(editor, fixture.otherThreadId);
      const view = editor.prosemirrorView!;
      view.dispatch(view.state.tr.insertText('prefix ', firstRun(fixture.handle).from));
      hoverThread(editor, null);
    });

    expect(selectedThreadsIn(editor.prosemirrorState)).toBe(ids);
    expect(commentLocationIn(editor.prosemirrorState)).toBe(location);
    expect(isCurrentProposalLocation(location, editor)).toBe(true);
    expect(located).toEqual([]);
  });

  it('clears the command with and without hover and keeps repeated clears stable', async () => {
    const fixture = await open();
    const editor = fixture.handle.editor;
    publish(fixture);
    act(() => {
      hoverThread(editor, fixture.threadId);
      selectThreads(editor, []);
    });
    expect(commentLocationIn(editor.prosemirrorState)).toBeNull();
    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([]);
    act(() => hoverThread(editor, null));
    const cleared = selectedThreadsIn(editor.prosemirrorState);

    act(() => selectThreads(editor, []));

    expect(selectedThreadsIn(editor.prosemirrorState)).toBe(cleared);
    expect(commentLocationIn(editor.prosemirrorState)).toBeNull();
    const current = publish(fixture);
    expect(commentLocationIn(editor.prosemirrorState)).toBe(current);
  });

  it('leaves shared bytes, native text selection and undo history unchanged', async () => {
    const fixture = await open();
    const editor = fixture.handle.editor;
    act(() => {
      const view = editor.prosemirrorView!;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, firstRun(fixture.handle).from + 2)));
    });
    const before = {
      bytes: Y.encodeStateAsUpdate(fixture.doc),
      selection: editor.prosemirrorState.selection.toJSON(),
      undo: [...fixture.handle.undoManager.undoStack],
      redo: [...fixture.handle.undoManager.redoStack],
    };

    publish(fixture);
    publish(fixture);
    act(() => selectThreads(editor, [fixture.threadId]));

    expect(Y.encodeStateAsUpdate(fixture.doc)).toEqual(before.bytes);
    expect(editor.prosemirrorState.selection.toJSON()).toEqual(before.selection);
    expect(fixture.handle.undoManager.undoStack).toEqual(before.undo);
    expect(fixture.handle.undoManager.redoStack).toEqual(before.redo);
  });
});
