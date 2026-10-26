// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, documentBodySource, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { applyLink } from '@web/spaces/document/document-link';
import { trackLink, resolveTrackedLink, resolveTrackedSpan } from '@web/spaces/document/document-link-tracking';
import { showLinkEditSpan } from '@web/spaces/document/document-link-edit-mark';
import { DOCUMENT_COMMENT_DRAFT_RANGE, draftIn, draftRangeIn } from '@web/spaces/document/document-comment-draft-range';
import { draftWordsOf, writeDraftWords } from '@web/spaces/document/document-comment-unsent';
import {
  addUploadBatch, documentUploadsExtension, documentUploadsKey, holdGap, uploadBatchesIn,
  uploadSlotHoldersIn, UPLOAD_SLOT_ATTRIBUTE,
} from '@web/spaces/document/document-upload-slots';
import { nameCell, cellNamed } from '@web/spaces/document/document-table-cell-name';
import { setTableTarget, tableTargetOf } from '@web/spaces/document/document-table-target';
import { startTableDrag, dragSourceOf } from '@web/spaces/document/document-table-drag';
import { deleteColumnAt } from '@web/spaces/document/document-table-run';
import { cleanupCodecFixtures, codecDoc, codecFixture, codecTableFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

const NAME = 'document:common-consumers';
const mounted: ReturnType<typeof buildDocumentEditor>[] = [];
const managers: Y.UndoManager[] = [];
const runtimes: ReturnType<typeof createDocumentBodyRuntime>[] = [];
const hosts: HTMLElement[] = [];

/** One real view and the original handle resources passed into its factory. */
interface Client {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly manager: Y.UndoManager;
  readonly runtime: ReturnType<typeof createDocumentBodyRuntime>;
}

/**
 * Opens the actual factory, including each production consumer plugin.
 * @param doc - An independent native replica with the shared initial identities.
 * @returns Its existing native history, runtime and mounted editor.
 * @throws {Error} If production construction or mounting fails.
 */
function open(doc: Y.Doc): Client {
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  runtimes.push(runtime);
  const origin = {};
  const { manager, extension } = createDocumentUndo(doc, { origin, runtime });
  managers.push(manager);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc),
    body: { document: NAME, runtime, history: manager, origin }, extensions: [extension, documentUploadsExtension()] });
  mounted.push(editor);
  const host = document.createElement('div');
  hosts.push(host);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  return { doc, editor, manager, runtime };
}

/**
 * Builds two actual records editors from one stored native snapshot.
 * @param doc - The independent original input fixture.
 * @returns The local consumer and a peer with its own runtime and user origin.
 * @throws {Error} If decoding or editor construction fails.
 */
function pair(doc = codecFixture([{ id: 'A', text: 'hello world' }])): { local: Client; peer: Client } {
  const copy = codecDoc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return { local: open(doc), peer: open(copy) };
}

/**
 * Exchanges real native state, preserving production source projection handling.
 * @param from - The replica whose accepted changes are being delivered.
 * @param to - The existing receiving replica.
 * @throws {Error} If native update application fails.
 */
function exchange(from: Client, to: Client): void {
  act(() => Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc))));
}

/**
 * Searches actual PM characters rather than a second mapping of native names.
 * @param client - The editor whose current document is inspected.
 * @param text - The exact character sequence to locate.
 * @returns The independently observed current PM range.
 * @throws {Error} If the requested text is absent.
 */
function rangeOf(client: Client, text: string): { from: number; to: number } {
  const units: { value: string; pos: number }[] = [];
  client.editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText) (node.text ?? '').split('').forEach((value, offset) => units.push({ value, pos: pos + offset }));
  });
  const start = units.map((unit) => unit.value).join('').indexOf(text);
  if (start < 0) throw new Error(`Missing expected text:${text}`);
  return { from: units[start].pos, to: units[start + text.length - 1].pos + 1 };
}

/**
 * Requires the same open draft owned by the production plugin.
 * @param client - The editor holding the unposted draft.
 * @returns The actual aimed draft snapshot.
 * @throws {Error} If the draft was incorrectly discarded.
 */
function aimed(client: Client): NonNullable<ReturnType<typeof draftRangeIn>> {
  const draft = draftRangeIn(client.editor.prosemirrorState);
  if (draft === null) throw new Error('Expected the original aimed draft');
  return draft;
}

/**
 * Reads the actual upload placeholder decoration handed to ProseMirror.
 * @param client - The mounted editor holding a pending upload.
 * @param slot - The returned real upload slot identity.
 * @returns Its exact current widget position.
 * @throws {Error} If the existing slot has no placeholder.
 */
function placeholderAt(client: Client, slot: string): number {
  const state = documentUploadsKey.getState(client.editor.prosemirrorState);
  const widget = state?.decorations.find().find((decoration) => decoration.spec['key'] === slot);
  if (widget === undefined) throw new Error('Expected a real pending upload placeholder');
  return widget.from;
}

afterEach(() => {
  act(() => mounted.splice(0).forEach((editor) => editor.unmount()));
  managers.splice(0).forEach((manager) => manager.destroy());
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  hosts.splice(0).forEach((host) => host.remove());
  cleanupCodecFixtures();
});

describe('existing position consumers on the common records index', () => {
  it('resolves simultaneous link draft upload target and drag holds from the same exact peer frame', () => {
    const { local, peer } = pair(codecTableFixture());
    const view = local.editor.prosemirrorView;
    act(() => applyLink(local.editor, { from: 6, to: 10 }, 'https://example.com/table'));
    exchange(local, peer);
    const link = trackLink(view.state, { from: 6, to: 10 });
    if (link === null) throw new Error('Expected the actual records link handle');
    act(() => showLinkEditSpan(view, link));
    act(() => view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{ from: 7, to: 9 }])));
    const opening = aimed(local).opening;
    writeDraftWords(opening, 'Simultaneous pending input');
    const [slot] = addUploadBatch(view, 1, ['pending.png']);
    const gap = holdGap(view, 1);
    act(() => setTableTarget(view, 13));
    act(() => { startTableDrag(view, 'column', 13); });
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.insertText('XX', 6)));
    exchange(peer, local);
    const state = view.state;
    const binding = bodyBindingOf(state);
    if (binding === null) throw new Error('Expected one actual common binding frame');
    const frame = binding.read(state);
    expect(frame.index.doc).toBe(state.doc);
    expect(frame.doc.textContent).toBe('XXleftright');
    expect(resolveTrackedLink(state, link)).toEqual({ range: { from: 8, to: 12 }, href: 'https://example.com/table' });
    expect(aimed(local).segments).toEqual([{ from: 9, to: 11 }]);
    expect(aimed(local).opening).toBe(opening);
    expect(state.doc.textBetween(9, 11)).toBe('ef');
    expect(draftWordsOf(opening)).toBe('Simultaneous pending input');
    expect(placeholderAt(local, slot)).toBe(1);
    expect(gap()).toBe(1);
    expect(tableTargetOf(state)).toBe(15);
    expect(dragSourceOf(state)).toEqual({ cellPos: 15, orientation: 'column' });
    expect(frame.index.nodes.get('right')?.from).toBe(15);
  });

  it('keeps the actual held href through peer insertion before and inside its range', () => {
    const { local, peer } = pair();
    act(() => applyLink(local.editor, { from: 3, to: 8 }, 'https://example.com/original'));
    exchange(local, peer);
    const held = trackLink(local.editor.prosemirrorState, { from: 3, to: 8 });
    if (held === null) throw new Error('The real records factory must expose a link hold');
    act(() => showLinkEditSpan(local.editor.prosemirrorView, held));
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.insertText('XX', 3)));
    exchange(peer, local);
    expect(local.editor.prosemirrorState.doc.textContent).toBe('XXhello world');
    expect(resolveTrackedLink(local.editor.prosemirrorState, held)).toEqual({ range: { from: 5, to: 10 }, href: 'https://example.com/original' });
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.insertText('Y', 7)));
    exchange(peer, local);
    expect(local.editor.prosemirrorState.doc.textContent).toBe('XXheYllo world');
    expect(resolveTrackedSpan(local.editor.prosemirrorState, held)).toEqual({ from: 5, to: 11 });
    expect(resolveTrackedLink(local.editor.prosemirrorState, held)).toEqual({ range: { from: 5, to: 11 }, href: 'https://example.com/original' });
    expect(local.editor.prosemirrorView.dom.querySelector('[data-show-selection="true"]')?.textContent).toBe('heYllo');
    expect(bodyBindingOf(local.editor.prosemirrorState)?.read().doc).toBe(local.editor.prosemirrorState.doc);
  });

  it('keeps draft ranges on surviving original letters and stops at the final character without crossing owners', () => {
    const { local, peer } = pair(codecFixture([{ id: 'A', text: 'AB' }, { id: 'B', text: 'CD' }]));
    const view = local.editor.prosemirrorView;
    act(() => view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{ from: 4, to: 5 }, { from: 9, to: 10 }])));
    const opening = aimed(local).opening;
    writeDraftWords(opening, 'Local unposted words');
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.delete(4, 5)));
    exchange(peer, local);
    expect(local.editor.prosemirrorState.doc.textContent).toBe('ACD');
    expect(aimed(local).segments).toEqual([{ from: 8, to: 9 }]);
    expect(aimed(local).opening).toBe(opening);
    expect(local.editor.prosemirrorState.doc.textBetween(8, 9)).toBe('C');
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.delete(8, 9)));
    exchange(peer, local);
    expect(local.editor.prosemirrorState.doc.textContent).toBe('AD');
    expect(draftIn(local.editor.prosemirrorState)).toEqual({ kind: 'dropped', why: 'targetGone', opening });
    expect(draftWordsOf(opening)).toBe('Local unposted words');
  });

  it('restores the same draft opening and exact named letters through local native undo and redo', () => {
    const { local } = pair(codecFixture([{ id: 'A', text: 'ABCD' }]));
    const view = local.editor.prosemirrorView;
    act(() => view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{ from: 4, to: 6 }])));
    const opening = aimed(local).opening;
    writeDraftWords(opening, 'Keep this input');
    act(() => view.dispatch(view.state.tr.delete(4, 5)));
    expect(aimed(local).segments).toEqual([{ from: 4, to: 5 }]);
    act(() => { local.editor.undo(); });
    expect(view.state.doc.textContent).toBe('ABCD');
    expect(aimed(local).segments).toEqual([{ from: 4, to: 6 }]);
    expect(view.state.doc.textBetween(4, 6)).toBe('BC');
    expect(aimed(local).opening).toBe(opening);
    act(() => { local.editor.redo(); });
    expect(view.state.doc.textContent).toBe('ACD');
    expect(aimed(local).segments).toEqual([{ from: 4, to: 5 }]);
    expect(view.state.doc.textBetween(4, 5)).toBe('C');
    expect(draftWordsOf(opening)).toBe('Keep this input');
  });

  it('moves the real upload gap placeholder with peer input and restores its exact undo and redo gap', () => {
    const { local, peer } = pair(codecFixture([{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }]));
    const view = local.editor.prosemirrorView;
    const [slot] = addUploadBatch(view, 6, ['pending.png'], false, local.manager);
    const heldGap = holdGap(view, 6);
    expect(placeholderAt(local, slot)).toBe(6);
    expect(uploadSlotHoldersIn(view).get(slot)?.getAttribute(UPLOAD_SLOT_ATTRIBUTE)).toBe(slot);
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.insertText('XX', 3)));
    exchange(peer, local);
    expect(rangeOf(local, 'B')).toEqual({ from: 10, to: 11 });
    expect(placeholderAt(local, slot)).toBe(8);
    expect(heldGap()).toBe(8);
    act(() => view.dispatch(view.state.tr.insertText('Y', 3)));
    expect(placeholderAt(local, slot)).toBe(9);
    expect(uploadBatchesIn(view.state).map((batch) => batch.gap)).toEqual([9]);
    act(() => { local.editor.undo(); });
    expect(view.state.doc.textContent).toBe('XXAB');
    expect(placeholderAt(local, slot)).toBe(8);
    expect(heldGap()).toBe(8);
    act(() => { local.editor.redo(); });
    expect(view.state.doc.textContent).toBe('YXXAB');
    expect(placeholderAt(local, slot)).toBe(9);
    expect(heldGap()).toBe(9);
  });

  it('keeps a named cell at its exact new position and reports null only after its native deletion', () => {
    const { local, peer } = pair(codecTableFixture());
    const held = nameCell(local.editor.prosemirrorState, 13);
    if (held === null) throw new Error('The real records factory must expose the original cell name');
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.insertText('XX', 6)));
    exchange(peer, local);
    expect(cellNamed(local.editor.prosemirrorState, local.editor.prosemirrorState.doc, held)).toBe(15);
    expect(local.editor.prosemirrorState.doc.nodeAt(15)?.textContent).toBe('right');
    act(() => deleteColumnAt(peer.editor, 15));
    exchange(peer, local);
    expect(local.editor.prosemirrorState.doc.textContent).toBe('XXleft');
    expect(cellNamed(local.editor.prosemirrorState, local.editor.prosemirrorState.doc, held)).toBeNull();
  });

  it('carries the actual table menu target and column drag through the same peer frame and clears deleted targets', () => {
    const { local, peer } = pair(codecTableFixture());
    const view = local.editor.prosemirrorView;
    act(() => setTableTarget(view, 13, 'column'));
    let started = false;
    act(() => { started = startTableDrag(view, 'column', 13); });
    expect(started).toBe(true);
    act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.insertText('XX', 6)));
    exchange(peer, local);
    expect(tableTargetOf(view.state)).toBe(15);
    expect(dragSourceOf(view.state)).toEqual({ cellPos: 15, orientation: 'column' });
    expect(view.state.doc.nodeAt(15)?.textContent).toBe('right');
    act(() => deleteColumnAt(peer.editor, 15));
    exchange(peer, local);
    expect(tableTargetOf(view.state)).toBeNull();
    expect(dragSourceOf(view.state)).toBeNull();
  });

  it.each(['waiting', 'failed'] as const)('preserves draft upload target and drag holds while %s takes priority over source disappearance', (status) => {
    const { local, peer } = pair(codecTableFixture());
    const view = local.editor.prosemirrorView;
    act(() => view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{ from: 7, to: 9 }])));
    const originalDraft = aimed(local);
    writeDraftWords(originalDraft.opening, 'Pending input');
    const [slot] = addUploadBatch(view, 1, ['pending.png']);
    act(() => setTableTarget(view, 13));
    act(() => { startTableDrag(view, 'column', 13); });
    const batches = uploadBatchesIn(view.state);
    const originalDoc = view.state.doc;
    act(() => {
      if (status === 'waiting') {
        documentBodySource(peer.doc, 'S:L').format(1, 1, { ctx: 'not-yet-delivered' });
      } else {
        local.runtime.fail({ phase: 'consumer-test', error: new Error('Original failure'), batch: null, epoch: 1,
          accepted: originalDoc, selection: view.state.selection, journal: null, lastGood: originalDoc, writeStarted: false, writeReturned: false });
        deleteColumnAt(peer.editor, 13);
      }
    });
    exchange(peer, local);
    act(() => view.dispatch(view.state.tr.setMeta('paused-consumers-probe', true)));
    expect(local.runtime.read().status).toBe(status);
    expect(view.state.doc).toBe(originalDoc);
    expect(draftRangeIn(view.state)).toBe(originalDraft);
    expect(draftWordsOf(originalDraft.opening)).toBe('Pending input');
    expect(uploadBatchesIn(view.state)).toEqual(batches);
    expect(placeholderAt(local, slot)).toBe(1);
    expect(tableTargetOf(view.state)).toBe(13);
    expect(dragSourceOf(view.state)).toEqual({ cellPos: 13, orientation: 'column' });
    if (status === 'waiting') {
      act(() => registerDocumentBodyRecords(peer.doc, { contexts: [{ id: 'not-yet-delivered', dependencies: [] }] }));
      exchange(peer, local);
      expect(local.runtime.read().status).toBe('active');
      expect(aimed(local).opening).toBe(originalDraft.opening);
      expect(tableTargetOf(view.state)).toBe(13);
      expect(dragSourceOf(view.state)).toEqual({ cellPos: 13, orientation: 'column' });
    }
  });
});
