// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { NodeSelection, TextSelection, type Selection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { documentBodyFragment, documentBodySource } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { nameBodySelection, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import { bodyEdgeBetween, bodyEdgePos } from '@web/spaces/document/document-body-edge-selection';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { documentCaretExtension } from '@web/spaces/document/document-caret';
import type { DocumentBodyCursor } from '@web/spaces/document/document-caret-types';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { cleanupCodecFixtures, codecFixture, codecTableFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

const NAME = 'document:records-caret';
const REMOTE_ID = 4242;
const editors: ReturnType<typeof buildDocumentEditor>[] = [];
const histories: Y.UndoManager[] = [];
const runtimes: ReturnType<typeof createDocumentBodyRuntime>[] = [];
const providers: Awareness[] = [];
const elements: HTMLElement[] = [];

/** A synchronous wire observation also records the actual publication boundary. */
interface PublishedCursor {
  readonly cursor: unknown;
  readonly user: unknown;
  readonly phase: string | null;
  readonly status: string;
  readonly focused: boolean;
}

/**
 * Constructs the real records editor with the same explicit handle resources.
 * @param doc - The original native fixture held by the document handle.
 * @returns The editor, awareness and shared runtime with synchronous wire observations.
 * @throws {Error} If actual records construction or mounting fails.
 */
function open(doc = codecFixture([{ id: 'A', text: 'AB' }])): {
  doc: Y.Doc; awareness: Awareness; editor: ReturnType<typeof buildDocumentEditor>;
  runtime: ReturnType<typeof createDocumentBodyRuntime>; root: HTMLElement; published: PublishedCursor[];
} {
  const awareness = new Awareness(doc);
  providers.push(awareness);
  awareness.setLocalStateField('user', { focused: true });
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  runtimes.push(runtime);
  const origin = {};
  const history = createDocumentUndo(doc, { origin, runtime });
  histories.push(history.manager);
  const published: PublishedCursor[] = [];
  let editor: ReturnType<typeof buildDocumentEditor> | null = null;
  let activeView: EditorView | null = null;
  awareness.on('update', () => {
    const local = awareness.getLocalState();
    const binding = editor === null ? null : bodyBindingOf(editor.prosemirrorState);
    published.push({ cursor: local?.['cursor'], user: local?.['user'], phase: binding?.phase() ?? null,
      status: runtime.read().status, focused: activeView?.hasFocus() ?? false });
  });
  const root = document.createElement('div');
  elements.push(root);
  document.body.appendChild(root);
  editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc), body: { document: NAME, runtime, history: history.manager, origin },
    extensions: [history.extension, documentCaretExtension(awareness, (id) => id === 'u-peer' ? 'Peer' : null, { document: NAME, runtime })],
  });
  editors.push(editor);
  act(() => editor.mount(root));
  activeView = editor.prosemirrorView;
  return { doc, awareness, editor, runtime, root, published };
}

/**
 * Requires the exact cursor envelope published on the existing awareness field.
 * @param awareness - The actual document provider awareness.
 * @returns The complete versioned records cursor.
 * @throws {Error} If no complete records cursor is published.
 */
function cursorOf(awareness: Awareness): DocumentBodyCursor {
  const cursor: unknown = awareness.getLocalState()?.['cursor'];
  expect(cursor).toMatchObject({ format: 'breatic.document.records', version: 1, document: NAME });
  if (cursor === null || typeof cursor !== 'object' || !('selection' in cursor)) throw new Error('Expected a complete records cursor');
  return cursor as DocumentBodyCursor;
}

/**
 * Publishes a real remote frame using the same JSON transport boundary as awareness.
 * @param awareness - The actual receiving awareness object.
 * @param cursor - A remote cursor or explicit withdrawal.
 * @throws {Error} If awareness listeners reject the frame.
 */
function remote(awareness: Awareness, cursor: DocumentBodyCursor | null): void {
  const wire: unknown = cursor === null ? null : JSON.parse(JSON.stringify(cursor));
  awareness.states.set(REMOTE_ID, { user: { id: 'u-peer', focused: true, name: 'Untrusted name', color: 'red;display:none' }, cursor: wire });
  awareness.emit('change', [{ added: [REMOTE_ID], updated: [], removed: [] }, 'remote']);
}

/**
 * Counts only the view-owned awareness event listeners.
 * @param awareness - The provider that outlives the mounted view.
 * @returns The exact current change listener count.
 * @throws {never}
 */
function changeListeners(awareness: Awareness): number {
  const observed = (awareness as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  return observed.get('change')?.size ?? 0;
}

afterEach(() => {
  act(() => editors.splice(0).forEach((editor) => editor.unmount()));
  histories.splice(0).forEach((history) => history.destroy());
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  providers.splice(0).forEach((awareness) => awareness.destroy());
  elements.splice(0).forEach((element) => element.remove());
  cleanupCodecFixtures();
  vi.restoreAllMocks();
});

describe('records caret through the existing document caret entry', () => {
  it('constructs without XML sync and keeps every published identity server-owned', () => {
    const { editor, awareness, published } = open();
    expect(awareness.getLocalState()?.['cursor']).toBeNull();
    act(() => editor.prosemirrorView.focus());
    cursorOf(awareness);
    for (const frame of published) expect(frame.user).toEqual({ focused: true });
    expect(awareness.getLocalState()?.['user']).toEqual({ focused: true });
    const keys = editor.prosemirrorState.plugins.map((plugin) => (plugin as unknown as { key: string }).key);
    expect(keys.some((key) => key.startsWith('y-sync') || key.startsWith('yjs-cursor'))).toBe(false);
  });

  it.each(['text', 'cell', 'body-start', 'body-end'] as const)('publishes the exact final %s selection while focused and idle', (kind) => {
    const { editor, awareness, doc, published } = open(codecTableFixture());
    const before = Y.encodeStateAsUpdate(doc);
    const view = editor.prosemirrorView;
    let selection: Selection;
    if (kind === 'text') selection = TextSelection.create(view.state.doc, 6, 9);
    else if (kind === 'cell') selection = new CellSelection(view.state.doc.resolve(3), view.state.doc.resolve(13));
    else if (kind === 'body-start') selection = bodyEdgeBetween(view.state.doc, bodyEdgePos(view.state.doc, 'start'), 21);
    else selection = bodyEdgeBetween(view.state.doc, 6, bodyEdgePos(view.state.doc, 'end'));
    act(() => view.dispatch(view.state.tr.setSelection(selection)));
    act(() => view.focus());
    const binding = bodyBindingOf(view.state);
    if (binding === null) throw new Error('Missing records binding');
    const cursor = cursorOf(awareness);
    expect(cursor.selection).toEqual(nameBodySelection(binding.read(view.state).index, view.state.selection));
    const resolved = resolveBodySelection(binding.read(view.state).index, JSON.parse(JSON.stringify(cursor.selection)) as DocumentBodyCursor['selection']);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('Published final cursor must resolve');
    expect(resolved.selection.toJSON()).toEqual(selection.toJSON());
    for (const frame of published.filter((frame) => frame.cursor !== null && frame.cursor !== undefined)) {
      expect(frame.status).toBe('active');
      expect(frame.phase).toBe('idle');
      expect(frame.focused).toBe(true);
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('publishes a newly typed character only through its final native name', () => {
    const { editor, awareness, published } = open();
    const view = editor.prosemirrorView;
    act(() => view.focus());
    act(() => view.dispatch(view.state.tr.insertText('X', 4)));
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4, 5))));
    const cursor = cursorOf(awareness);
    const binding = bodyBindingOf(view.state);
    if (binding === null) throw new Error('Missing records binding');
    const frame = binding.read(view.state);
    const resolved = resolveBodySelection(frame.index, JSON.parse(JSON.stringify(cursor.selection)) as DocumentBodyCursor['selection']);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('New final character must resolve');
    expect(resolved.selection.toJSON()).toEqual({ type: 'text', anchor: 4, head: 5 });
    expect(view.state.doc.textBetween(4, 5)).toBe('X');
    const x = frame.index.units.find((unit) => unit.pos === 4);
    if (x === undefined) throw new Error('Expected the new character in the final native index');
    expect(cursor.selection).toMatchObject({ kind: 'text', anchor: { kind: 'text', source: x.source, token: x.token } });
    for (const wire of published.filter((value) => value.cursor !== null && value.cursor !== undefined)) {
      expect(wire.phase).toBe('idle');
      expect(wire.status).toBe('active');
      expect(wire.focused).toBe(true);
    }
  });

  it('publishes native inline-node names and renders their JSON peer cursor', async () => {
    const seed = codecFixture([{ id: 'A', text: 'AB' }]);
    documentBodySource(seed, 'S:A').insertEmbed(2, { bodyInline: { type: 'futureToken', attrs: { payload: ['keep', 7] } } }, { ctx: 'base' });
    const { editor, awareness, root, doc } = open(seed);
    const view = editor.prosemirrorView;
    const selection = NodeSelection.create(view.state.doc, 4);
    expect(selection.node.type.name).toBe('unsupportedInline');
    act(() => view.dispatch(view.state.tr.setSelection(selection)));
    act(() => view.focus());
    const cursor = cursorOf(awareness);
    const binding = bodyBindingOf(view.state);
    if (binding === null) throw new Error('Missing records binding');
    const token = binding.read(view.state).index.units.find((unit) => unit.pos === 4)!.token;
    expect(cursor.selection).toMatchObject({ kind: 'inlineNode',
      anchor: { kind: 'text', source: 'S:A', token, assoc: 1 },
      head: { kind: 'text', source: 'S:A', token, assoc: -1 },
    });
    const resolved = resolveBodySelection(binding.read(view.state).index, JSON.parse(JSON.stringify(cursor.selection)) as DocumentBodyCursor['selection']);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('Published inline-node selection must resolve');
    expect(resolved.selection.toJSON()).toEqual(selection.toJSON());
    act(() => remote(awareness, cursor));
    await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); });
    const caret = root.querySelector<HTMLElement>('.collaboration-carets__caret');
    expect(caret).not.toBeNull();
    if (caret === null) throw new Error('Missing inline-node remote caret');
    expect(view.posAtDOM(caret, 0)).toBe(5);
    expect(root.querySelector('.collaboration-carets__selection')).not.toBeNull();
    act(() => documentBodySource(doc, 'S:A').insert(1, 'Z', { ctx: 'base' }));
    const moved = root.querySelector<HTMLElement>('.collaboration-carets__caret');
    if (moved === null) throw new Error('Native insertion removed the inline-node caret');
    expect(view.posAtDOM(moved, 0)).toBe(6);
    const next = resolveBodySelection(binding.read(view.state).index, cursor.selection);
    expect(next.status).toBe('resolved');
    if (next.status === 'resolved') expect(next.selection.toJSON()).toEqual({ type: 'node', anchor: 5 });
  });

  it.each(['waiting', 'failed', 'disposed'] as const)('withdraws synchronously on %s without another PM transaction', (status) => {
    const { editor, awareness, runtime, doc } = open();
    const view = editor.prosemirrorView;
    act(() => view.focus());
    cursorOf(awareness);
    const before = Y.encodeStateAsUpdate(doc);
    act(() => {
      if (status === 'waiting') runtime.wait(['context:missing']);
      else if (status === 'disposed') runtime.dispose();
      else runtime.fail({ phase: 'caret-test', error: new Error('Original binding failure'), batch: null, epoch: 1,
        accepted: view.state.doc, selection: view.state.selection, journal: null, lastGood: view.state.doc, writeStarted: false, writeReturned: false });
    });
    expect(awareness.getLocalState()?.['cursor']).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    if (status === 'waiting') {
      act(() => runtime.resume());
      cursorOf(awareness);
    }
  });

  it('withdraws on real view blur and hidden document and resumes only with actual focus', () => {
    const { editor, awareness, runtime } = open();
    const view = editor.prosemirrorView;
    act(() => view.focus());
    cursorOf(awareness);
    const outside = document.createElement('button');
    elements.push(outside);
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(view.hasFocus()).toBe(false);
    expect(awareness.getLocalState()?.['cursor']).toBeNull();
    act(() => { runtime.wait(['fact:missing']); runtime.resume(); });
    expect(awareness.getLocalState()?.['cursor']).toBeNull();
    act(() => view.focus());
    cursorOf(awareness);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(awareness.getLocalState()?.['cursor']).toBeNull();
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    cursorOf(awareness);
  });

  it('renders JSON remote names with the common roster renderer and follows native source changes', async () => {
    const { editor, awareness, root, doc } = open();
    const view = editor.prosemirrorView;
    const binding = bodyBindingOf(view.state);
    if (binding === null) throw new Error('Missing records binding');
    const cursor: DocumentBodyCursor = { format: 'breatic.document.records', version: 1, document: NAME,
      selection: nameBodySelection(binding.read(view.state).index, TextSelection.create(view.state.doc, 4, 5)) };
    act(() => remote(awareness, cursor));
    await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); });
    const caret = root.querySelector<HTMLElement>('.collaboration-carets__caret');
    expect(root.querySelectorAll('.collaboration-carets__caret')).toHaveLength(1);
    if (caret === null) throw new Error('Missing records remote caret');
    expect(caret.dataset.clientId).toBe(String(REMOTE_ID));
    expect(caret.querySelector('.collaboration-carets__label')?.textContent?.trim()).toBe('Peer');
    expect(view.posAtDOM(caret, 0)).toBe(5);
    expect(root.querySelector('.collaboration-carets__selection')?.textContent).toBe('B');
    expect(caret.style.cssText).not.toContain('display');
    act(() => documentBodySource(doc, 'S:A').insert(1, 'Z', { ctx: 'base' }));
    expect(view.state.doc.textContent).toBe('ZAB');
    const moved = root.querySelector<HTMLElement>('.collaboration-carets__caret');
    if (moved === null) throw new Error('Native update removed the records caret');
    expect(view.posAtDOM(moved, 0)).toBe(6);
    expect(root.querySelector('.collaboration-carets__selection')?.textContent).toBe('B');
    act(() => remote(awareness, null));
    await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); });
    expect(root.querySelectorAll('.collaboration-carets__caret')).toHaveLength(0);
    expect(root.querySelectorAll('.collaboration-carets__selection')).toHaveLength(0);
  });

  it('does not render names belonging to another document', async () => {
    const { editor, awareness, root } = open();
    const binding = bodyBindingOf(editor.prosemirrorState);
    if (binding === null) throw new Error('Missing records binding');
    const selection = nameBodySelection(binding.read().index, TextSelection.create(editor.prosemirrorState.doc, 4));
    act(() => remote(awareness, { format: 'breatic.document.records', version: 1, document: 'another-document',
      selection: { ...selection, document: 'another-document' } }));
    await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); });
    expect(root.querySelectorAll('.collaboration-carets__caret')).toHaveLength(0);
  });

  it('withdraws and detaches view listeners on unmount while preserving handle runtime', () => {
    const { editor, awareness, runtime } = open();
    act(() => editor.prosemirrorView.focus());
    cursorOf(awareness);
    expect(changeListeners(awareness)).toBe(1);
    act(() => editor.unmount());
    expect(awareness.getLocalState()?.['cursor']).toBeNull();
    expect(changeListeners(awareness)).toBe(0);
    expect(runtime.read().status).toBe('active');
    const write = vi.spyOn(awareness, 'setLocalStateField');
    act(() => { runtime.wait(['context:later']); runtime.resume(); });
    awareness.emit('change', [{ added: [], updated: [REMOTE_ID], removed: [] }, 'remote']);
    expect(write).not.toHaveBeenCalled();
  });
});
