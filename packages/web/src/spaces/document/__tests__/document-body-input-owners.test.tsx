// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { encodeInitialSpaceContent } from '@breatic/shared';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { _resetDocumentEditorCacheForTests, getDocumentEditor, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { openCommentDraft } from '@web/spaces/document/document-comment-entries';
import { draftIn } from '@web/spaces/document/document-comment-draft-range';
import { commentOn } from '@web/spaces/document/document-comment-post';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { selectThreads } from '@web/spaces/document/document-comment-selection';
import { draftWordsOf, repliesOf } from '@web/spaces/document/document-comment-unsent';

const docs: Y.Doc[] = [];
const providers: Awareness[] = [];

/**
 * Opens the actual parent and its original cache-owned local stores.
 * @returns A mounted, prepared handle with one real text block.
 * @throws {Error} If normal construction fails.
 */
function openBody(name: string): DocumentEditorHandle {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const awareness = new Awareness(doc);
  providers.push(awareness);
  const handle = getDocumentEditor(doc, `document:owners-${name}`, {
    caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true,
  });
  render(<TooltipProvider><DocumentEditor handle={handle} myRole='editor' /></TooltipProvider>);
  act(() => handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: 'Discuss' }] as never));
  return handle;
}

/**
 * Pauses the same mounted handle while retaining its immutable recovery material.
 * @throws {Error} If the actual binding is absent.
 */
function pause(handle: DocumentEditorHandle, status: 'waiting' | 'failed'): void {
  const binding = bodyBindingOf(handle.editor.prosemirrorState);
  if (binding === null) throw new Error('Missing actual records binding');
  act(() => {
    if (status === 'waiting') handle.runtime.wait(['context:later']);
    else handle.runtime.fail({ phase: 'preflighting', error: new Error('owner-failure'), batch: 'input',
      epoch: binding.read().epoch, accepted: binding.read().doc, selection: handle.editor.prosemirrorState.selection,
      journal: null, lastGood: binding.read(), writeStarted: false, writeReturned: false });
  });
}

afterEach(() => {
  cleanup();
  act(() => _resetDocumentEditorCacheForTests());
  providers.splice(0).forEach((provider) => provider.destroy());
  docs.splice(0).forEach((doc) => doc.destroy());
});

describe('the existing URL form owner during a records pause', () => {
  it.each(['waiting', 'failed'] as const)('retains the same selectable input and refuses submission while %s', async (status) => {
    const doc = new Y.Doc();
    docs.push(doc);
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    const awareness = new Awareness(doc);
    providers.push(awareness);
    const handle = getDocumentEditor(doc, `document:input-owner-${status}`, {
      caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true,
    });
    render(<DocumentEditor handle={handle} myRole='editor' />);
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: [
        { type: 'text', text: 'Read ', styles: {} },
        { type: 'link', href: 'https://example.com/original', content: 'the link' },
      ] }] as never);
      const view = handle.editor.prosemirrorView;
      let inside = -1;
      view.state.doc.descendants((node, pos) => {
        if (inside < 0 && node.isText && node.marks.some((mark) => mark.type.name === 'link')) inside = pos + 1;
      });
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inside)));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('doc-link-edit'));
    const input = screen.getByTestId<HTMLInputElement>('doc-link-input');
    fireEvent.change(input, { target: { value: 'https://example.com/draft' } });
    expect(input.value).toBe('https://example.com/draft');
    const binding = bodyBindingOf(handle.editor.prosemirrorState);
    if (binding === null) throw new Error('Missing actual records binding');
    act(() => {
      if (status === 'waiting') handle.runtime.wait(['context:later']);
      else handle.runtime.fail({ phase: 'preflighting', error: new Error('input-owner-failure'), batch: 'input',
        epoch: binding.read().epoch, accepted: binding.read().doc, selection: handle.editor.prosemirrorState.selection,
        journal: null, lastGood: binding.read(), writeStarted: false, writeReturned: false });
    });
    await waitFor(() => expect(screen.getByTestId('doc-link-input')).toBe(input));
    expect(input.value).toBe('https://example.com/draft');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    input.focus();
    input.setSelectionRange(0, input.value.length);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    const bytes = Y.encodeStateAsUpdate(doc);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('doc-link-confirm'));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(screen.getByTestId('doc-link-input')).toBe(input);
    expect(input.value).toBe('https://example.com/draft');
    expect(screen.getByTestId('document-body-runtime-notice')).toBeInTheDocument();
  });
});

describe('real comment and caption owners during a records pause', () => {
  it.each(['waiting', 'failed'] as const)('retains a readonly new comment and its opening while %s', async (status) => {
    const handle = openBody(`draft-${status}`);
    const binding = bodyBindingOf(handle.editor.prosemirrorState)!;
    const owner = [...binding.read().index.owners.values()][0];
    act(() => { openCommentDraft(handle.editor, [{ from: owner.contentFrom, to: owner.contentTo }]); });
    const input = await screen.findByTestId<HTMLTextAreaElement>('doc-comment-draft-input');
    fireEvent.change(input, { target: { value: 'New draft' } });
    const opening = draftIn(handle.editor.prosemirrorState)!.opening;
    pause(handle, status);
    expect(screen.getByTestId('doc-comment-draft-input')).toBe(input);
    expect(input.value).toBe('New draft');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    expect(draftIn(handle.editor.prosemirrorState)!.opening).toBe(opening);
    expect(draftWordsOf(opening)).toBe('New draft');
  });

  it.each(['waiting', 'failed'] as const)('retains the existing readonly reply owner while %s', async (status) => {
    const handle = openBody(`reply-${status}`);
    const binding = bodyBindingOf(handle.editor.prosemirrorState)!;
    const owner = [...binding.read().index.owners.values()][0];
    let id = '';
    await act(async () => {
      const thread = await commentOn(handle.editor, asCommentBody('Published'), () => [{ from: owner.contentFrom, to: owner.contentTo }]);
      if (thread === null) throw new Error('Expected the actual saved comment');
      id = thread.id;
      selectThreads(handle.editor, [id]);
    });
    const input = await screen.findByTestId<HTMLTextAreaElement>('doc-comment-reply-input');
    fireEvent.change(input, { target: { value: 'Reply draft' } });
    const held = repliesOf(handle.editor);
    pause(handle, status);
    expect(screen.getByTestId('doc-comment-reply-input')).toBe(input);
    expect(input.value).toBe('Reply draft');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    expect(repliesOf(handle.editor)).toBe(held);
    expect(held.get(id)).toBe('Reply draft');
  });

  it.each(['waiting', 'failed'] as const)('captures caption composition and retains the same readonly session while %s', async (status) => {
    const handle = openBody(`caption-${status}`);
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [
        { type: 'paragraph', content: 'Above' },
        { type: 'image', props: { url: 'https://example.com/image.png', name: 'image.png', caption: 'Shared' } },
        { type: 'paragraph', content: 'Below' },
      ] as never);
      const view = handle.editor.prosemirrorView;
      let at = -1;
      view.state.doc.descendants((node, pos) => { if (node.type.name === 'image') at = pos; });
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
      view.focus();
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('doc-media-caption-button'));
    const input = screen.getByTestId<HTMLInputElement>('doc-media-caption-input');
    const media = handle.editor.document[1] as { id: string };
    const session = handle.captionDrafts.get(media.id)!.session;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'Earlier composition' } });
    // The IME's last DOM value has not yet reached React's change callback.
    input.value = 'Local completed';
    pause(handle, status);
    expect(screen.getByTestId('doc-media-caption-input')).toBe(input);
    expect(input.value).toBe('Local completed');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    expect(handle.captionDrafts.get(media.id)).toMatchObject({ session, value: 'Local completed', composing: false });
  });
});
