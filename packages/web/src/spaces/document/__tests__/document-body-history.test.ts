// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { AllSelection, NodeSelection, Plugin, TextSelection, type EditorState, type Selection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  documentBodyFragment, documentBodyRecords, documentBodySource, documentCommentThreads,
  readBodyTree, registerDocumentBodyRecords,
} from '@breatic/shared/document-body';

import { buildDocumentEditor, type DocumentEditorOptions } from '@web/spaces/document/build-document-editor';
import type { DocumentBodyOptions } from '@web/spaces/document/document-body-binding-types';
import { bodyBindingOf, BODY_TRANSACTION_SOURCE } from '@web/spaces/document/document-body-binding-key';
import { nameBodySelection, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import { bodyEdgeBetween, bodyEdgePos } from '@web/spaces/document/document-body-edge-selection';
import type { BodySelectionName } from '@web/spaces/document/document-body-positions-types';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { namesOnUndoStack } from '@web/spaces/document/document-undo-selection';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { cleanupCodecFixtures, codecFixture, codecTableFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

const NAME = 'document:native-history';
const managers: Y.UndoManager[] = [];
const runtimes: ReturnType<typeof createDocumentBodyRuntime>[] = [];
const mounted: ReturnType<typeof buildDocumentEditor>[] = [];
const hosts: HTMLElement[] = [];

/**
 * Allocates history through its actual production entry and retains ownership.
 * @param doc - The existing document held by a handle.
 * @param origin - This binding's unique user origin.
 * @returns The original manager, extension and shared runtime.
 * @throws {Error} If production history construction fails.
 */
function history(doc: Y.Doc, origin: object = {}): ReturnType<typeof createDocumentUndo> & { runtime: ReturnType<typeof createDocumentBodyRuntime>; origin: object } {
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const undo = createDocumentUndo(doc, { origin, runtime });
  managers.push(undo.manager);
  runtimes.push(runtime);
  return { ...undo, runtime, origin };
}

/**
 * Mounts the actual records factory with the original handle's undo extension.
 * @param extensions - Additional real batch/contributor plugins.
 * @param doc - A caller-owned native fixture, or the original two-character fixture.
 * @param modern - Whether to register the explicit modern history extension.
 * @returns The editor and its native history resources.
 * @throws {Error} If production assembly or mounting fails.
 */
function open(extensions: DocumentEditorOptions['extensions'] = [], doc = codecFixture([{ id: 'A', text: 'AB' }]), modern = true): ReturnType<typeof history> & { doc: Y.Doc; editor: ReturnType<typeof buildDocumentEditor> } {
  const undo = history(doc);
  const options: DocumentEditorOptions & { body: DocumentBodyOptions } = {
    fragment: documentBodyFragment(doc),
    extensions: [...modern ? [undo.extension] : [], ...extensions ?? []],
    body: { document: NAME, runtime: undo.runtime, history: undo.manager, origin: undo.origin },
  };
  const editor = buildDocumentEditor(options);
  mounted.push(editor);
  const host = document.createElement('div');
  hosts.push(host);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  return { ...undo, doc, editor };
}

/**
 * Counts existing observers without replacing the production cleanup wrapper.
 * @param doc - The native document that outlives its history.
 * @returns Exact per-event listener counts.
 * @throws {never}
 */
function listeners(doc: Y.Doc): ReadonlyMap<string, number> {
  const registry = (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  return new Map([...registry].map(([event, handlers]): [string, number] => [event, handlers.size]).filter(([, count]) => count !== 0));
}

/** The independent selection inputs already exercised by the positions spec. */
type SelectionCase = 'text' | 'node' | 'cell' | 'body-start' | 'body-end' | 'all';

/**
 * Constructs exact pre/post selections on the existing two-cell records fixture.
 * @param doc - The actual transaction's document.
 * @param kind - The semantic selection family under test.
 * @param post - Whether to use the distinct final direction or target.
 * @returns The original user selection, independent of history restoration.
 * @throws {RangeError} If the fixture no longer contains the specified positions.
 */
function tableSelection(doc: PMNode, kind: SelectionCase, post: boolean): Selection {
  switch (kind) {
    case 'text': return TextSelection.create(doc, post ? 9 : 6, post ? 6 : 9);
    case 'node': return NodeSelection.create(doc, post ? 14 : 4);
    case 'cell': return new CellSelection(doc.resolve(post ? 13 : 3), doc.resolve(post ? 3 : 13));
    // Existing wholeTables normalization requires the table's outer text end.
    case 'body-start': return bodyEdgeBetween(doc, post ? 21 : bodyEdgePos(doc, 'start'), post ? bodyEdgePos(doc, 'start') : 21);
    case 'body-end': return bodyEdgeBetween(doc, post ? bodyEdgePos(doc, 'end') : 6, post ? 6 : bodyEdgePos(doc, 'end'));
    case 'all': return new AllSelection(doc);
  }
}

/**
 * Reads the actual binding rather than constructing a second history or index.
 * @param editor - The production records editor.
 * @returns Its current common frame.
 * @throws {Error} If the records binding is missing.
 */
function frameOf(editor: ReturnType<typeof buildDocumentEditor>): BodyProjection {
  const binding = bodyBindingOf(editor.prosemirrorState);
  if (binding === null) throw new Error('Expected the production records binding');
  return binding.read(editor.prosemirrorState);
}

/**
 * Checks complete live content while preserving the original independent source.
 * @param doc - The actual native document after a records user batch.
 * @param expected - The independently specified complete user-visible text.
 * @param originalUnits - Original A/B identities captured before fresh-run input.
 * @throws {Error} If the current native records tree is incomplete.
 */
function assertFreshRunContent(doc: Y.Doc, expected: string, originalUnits: readonly string[]): void {
  const current = readBodyTree(doc);
  expect(current.status).toBe('ready');
  if (current.status !== 'ready') throw new Error('Expected complete native body after fresh-run input');
  const units = current.view.owners.flatMap((owner) => owner.units);
  expect(units.map((unit) => String(unit.value)).join('')).toBe(expected);
  expect(documentBodySource(doc, 'S:A').toString()).toBe('AB');
  expect(units.filter((unit) => unit.source === 'S:A').map((unit) => unit.id)).toEqual(originalUnits);
}

/**
 * Observes the existing public contribution handover during source projection.
 * @param capture - The same payload owner used by a draft or upload contributor.
 * @param output - Retains the exact names for later independent resolution.
 * @param restore - Updates that contributor's current payload after handover.
 * @returns A real plugin extension using namesOnUndoStack, without a mock bridge.
 * @throws {Error} If extension construction fails.
 */
function contribution(capture: (state: EditorState) => BodySelectionName | null, output: BodySelectionName[], restore: (value: BodySelectionName) => void = () => undefined): ExtensionFactoryInstance {
  const names = namesOnUndoStack(capture);
  return createExtension(() => ({
    key: 'historyPreciseNamesContributor',
    prosemirrorPlugins: [new Plugin({
      state: {
        init: () => null,
        apply: (transaction) => {
          if (transaction.getMeta(BODY_TRANSACTION_SOURCE) === 'projection') {
            const value = names.handedFor(transaction);
            if (value !== null) {
              output.push(value);
              restore(value);
            }
          }
          return null;
        },
      },
      view: (view) => ({ destroy: names.attach(view) }),
    })],
  }))();
}

/**
 * Requires precise selection restoration in the current final frame.
 * @param editor - The editor after native history has published.
 * @param name - The actual contribution received ahead of that projection.
 * @param anchor - Independently specified current PM anchor.
 * @param head - Independently specified current PM head.
 * @throws {Error} If a required native name cannot resolve.
 */
function assertContribution(editor: ReturnType<typeof buildDocumentEditor>, name: BodySelectionName, anchor: number, head: number): void {
  const frame = frameOf(editor);
  const resolved = resolveBodySelection(frame.index, name);
  expect(resolved.status).toBe('resolved');
  if (resolved.status !== 'resolved') throw new Error('Expected the original contributor payload to resolve');
  expect(resolved.selection.toJSON()).toEqual({ type: 'text', anchor, head });
  expect(resolved.selection.$anchor.doc).toBe(editor.prosemirrorState.doc);
  expect(resolved.epoch).toBe(frame.epoch);
}

afterEach(() => {
  act(() => mounted.splice(0).forEach((editor) => editor.unmount()));
  managers.splice(0).forEach((manager) => manager.destroy());
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  hosts.splice(0).forEach((host) => host.remove());
  cleanupCodecFixtures();
});

describe('native records history through createDocumentUndo', () => {
  it('scopes the existing manager to the Doc including sources registered later', () => {
    const doc = codecFixture([{ id: 'A', text: 'AB' }]);
    const { manager, origin } = history(doc);
    registerDocumentBodyRecords(doc, {
      records: [
        { id: 'B', kind: 'owner', type: 'paragraph', attrs: {}, wrapperAttrs: { id: 'B' }, parent: 'group', order: 'B', facet: 'F:B', base: true },
        { id: 'F:B', kind: 'facet', owner: 'B', parent: 'B', order: 'z' },
      ],
      sources: [{ id: 'S:B', facet: 'F:B', head: 'head:B', tail: 'tail:B' }],
    });
    const text = documentBodySource(doc, 'S:B');
    doc.transact(() => text.insert(1, 'CD', { ctx: 'base' }), origin);
    expect(manager.undoStack).toHaveLength(1);
    manager.undo();
    expect(text.toString()).toBe('');
    expect(text.length).toBe(2);
    expect(documentBodyRecords(doc).records.has('B')).toBe(true);
    manager.redo();
    expect(text.toString()).toBe('CD');
  });

  it('captures only this handle origin and keeps inverse transactions on the native redo stack', () => {
    const doc = codecFixture([{ id: 'A', text: 'AB' }]);
    const first = history(doc);
    const second = history(doc);
    const text = documentBodySource(doc, 'S:A');
    expect(first.origin).not.toBe(second.origin);
    doc.transact(() => text.insert(2, 'X', { ctx: 'base' }), first.origin);
    doc.transact(() => text.insert(3, 'Y', { ctx: 'base' }), second.origin);
    expect(first.manager.undoStack).toHaveLength(1);
    expect(second.manager.undoStack).toHaveLength(1);
    first.manager.undo();
    expect(text.toString()).toBe('AYB');
    expect(first.manager.redoStack).toHaveLength(1);
    expect(second.manager.undoStack).toHaveLength(1);
    second.manager.undo();
    expect(text.toString()).toBe('AB');
    first.manager.redo();
    expect(text.toString()).toBe('AXB');
  });

  it('keeps immutable registration, machine changes, comments and remote updates outside local text history', () => {
    const doc = codecFixture([{ id: 'A', text: 'AB' }]);
    const { manager, origin } = history(doc);
    const text = documentBodySource(doc, 'S:A');
    registerDocumentBodyRecords(doc, { contexts: [{ id: 'later-context', dependencies: [] }] });
    doc.transact(() => documentCommentThreads(doc).set('thread', { text: 'Comment', resolved: false }), { source: 'comment' });
    doc.transact(() => text.insert(3, 'M', { ctx: 'later-context' }), { source: 'machine' });
    const peer = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      documentBodySource(peer, 'S:A').insert(4, 'R', { ctx: 'base' });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    } finally {
      peer.destroy();
    }
    expect(manager.undoStack).toHaveLength(0);
    doc.transact(() => text.insert(2, 'U', { ctx: 'base' }), origin);
    manager.undo();
    expect(text.toString()).toBe('ABMR');
    expect(documentCommentThreads(doc).toJSON()).toEqual({ thread: { text: 'Comment', resolved: false } });
    expect(documentBodyRecords(doc).contexts.has('later-context')).toBe(true);
  });

  it('restores a deleted native character through Yjs redone identity', () => {
    const doc = codecFixture([{ id: 'A', text: 'ABC' }]);
    const { manager, origin } = history(doc);
    const text = documentBodySource(doc, 'S:A');
    const original = Y.createRelativePositionFromTypeIndex(text, 2);
    doc.transact(() => text.delete(2, 1), origin);
    expect(text.toString()).toBe('AC');
    manager.undo();
    expect(text.toString()).toBe('ABC');
    const restored = Y.createAbsolutePositionFromRelativePosition(original, doc, true);
    expect(restored?.type).toBe(text);
    expect(restored?.index).toBe(2);
    manager.redo();
    expect(text.toString()).toBe('AC');
  });

  it('uses the shared destroy cleanup while the Doc and runtime remain alive', () => {
    const doc = codecFixture([{ id: 'A', text: 'AB' }]);
    const runtime = createDocumentBodyRuntime(doc, () => undefined);
    runtimes.push(runtime);
    const baseline = listeners(doc);
    const { manager } = createDocumentUndo(doc, { origin: {}, runtime });
    expect(listeners(doc).get('destroy')).toBe((baseline.get('destroy') ?? 0) + 1);
    manager.destroy();
    expect(listeners(doc)).toEqual(baseline);
    expect(runtime.read().status).toBe('active');
  });
});

describe('records history through the real editor extension', () => {
  it('keeps the earliest root pre-selection and latest captured post-selection across a real append', () => {
    const append = createExtension(() => ({
      key: 'historyTestAppend',
      prosemirrorPlugins: [new Plugin({
        appendTransaction: (transactions, _previous, state) => transactions.some((transaction) => transaction.getMeta('historyTestRoot') === true)
          ? state.tr.insertText('!', 5) : null,
      })],
    }))();
    const { editor, manager, doc, origin } = open([append]);
    let userWrites = 0;
    doc.on('update', (_update, transactionOrigin) => { if (transactionOrigin === origin) userWrites += 1; });
    const view = editor.prosemirrorView;
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4))));
    act(() => view.dispatch(view.state.tr.insertText('X', 4).setMeta('historyTestRoot', true)));
    expect(view.state.doc.textContent).toBe('AX!B');
    expect(userWrites).toBe(1);
    act(() => view.dispatch(view.state.tr.insertText('Y', view.state.selection.head)));
    const post = { anchor: view.state.selection.anchor, head: view.state.selection.head };
    expect(manager.undoStack).toHaveLength(1);
    expect(userWrites).toBe(2);
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3))));
    act(() => { editor.undo(); });
    expect(view.state.doc.textContent).toBe('AB');
    expect({ anchor: view.state.selection.anchor, head: view.state.selection.head }).toEqual({ anchor: 4, head: 4 });
    act(() => { editor.redo(); });
    expect(view.state.doc.textContent).toBe('AX!YB');
    expect({ anchor: view.state.selection.anchor, head: view.state.selection.head }).toEqual(post);
  });

  it('excludes a machine root together with the append it triggers', () => {
    const append = createExtension(() => ({
      key: 'historyMachineAppend',
      prosemirrorPlugins: [new Plugin({
        appendTransaction: (transactions, _previous, state) => transactions.some((transaction) => transaction.getMeta('historyMachineRoot') === true)
          ? state.tr.insertText('!', 5) : null,
      })],
    }))();
    const { editor, manager } = open([append]);
    const view = editor.prosemirrorView;
    act(() => view.dispatch(view.state.tr.insertText('M', 4).setMeta('addToHistory', false).setMeta('historyMachineRoot', true)));
    expect(view.state.doc.textContent).toBe('AM!B');
    expect(manager.undoStack).toHaveLength(0);
  });

  it('rechecks runtime and current binding admission at the final undo and redo commands', () => {
    const { editor, doc, runtime, manager } = open();
    const view = editor.prosemirrorView;
    act(() => view.dispatch(view.state.tr.insertText('X', 4)));
    expect(manager.undoStack).toHaveLength(1);
    const before = Y.encodeStateAsUpdate(doc);
    act(() => runtime.wait(['source:pending']));
    act(() => { editor.undo(); });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(manager.undoStack).toHaveLength(1);
    act(() => runtime.resume());
    act(() => { editor.undo(); });
    expect(view.state.doc.textContent).toBe('AB');
    expect(manager.redoStack).toHaveLength(1);
    const undone = Y.encodeStateAsUpdate(doc);
    act(() => runtime.wait(['fact:pending']));
    act(() => { editor.redo(); });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(undone);
    expect(manager.redoStack).toHaveLength(1);
    act(() => runtime.resume());
    act(() => { editor.redo(); });
    expect(view.state.doc.textContent).toBe('AXB');
  });

  it('reuses the existing names contributor for early native undo and redo handover', () => {
    const handed: BodySelectionName[] = [];
    const names = namesOnUndoStack<BodySelectionName>((state) => {
      const binding = bodyBindingOf(state);
      return binding === null ? null : nameBodySelection(binding.read(state).index, state.selection);
    });
    const contributor = createExtension(() => ({
      key: 'historyExistingNamesContributor',
      prosemirrorPlugins: [new Plugin({
        state: {
          init: () => null,
          apply: (transaction) => {
            if (transaction.getMeta(BODY_TRANSACTION_SOURCE) === 'projection') {
              const value = names.handedFor(transaction);
              if (value !== null) handed.push(value);
            }
            return null;
          },
        },
        view: (view) => ({ destroy: names.attach(view) }),
      })],
    }))();
    const { editor } = open([contributor]);
    const view = editor.prosemirrorView;
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4))));
    act(() => view.dispatch(view.state.tr.insertText('X', 4)));
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3))));
    act(() => { editor.undo(); });
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ document: NAME, kind: 'text' });
    act(() => { editor.redo(); });
    expect(handed).toHaveLength(2);
    expect(handed[1]).toMatchObject({ document: NAME, kind: 'text' });
    expect(view.state.doc.textContent).toBe('AXB');
  });
});

describe('precise native history selection and runtime contracts', () => {
  const cases: readonly SelectionCase[] = ['text', 'node', 'cell', 'body-start', 'body-end', 'all'];
  it.each(cases)('restores %s pre and post semantics around real native format undo and redo', (kind) => {
    const { editor, doc, manager } = open([], codecTableFixture());
    const view = editor.prosemirrorView;
    const source = documentBodySource(doc, 'S:L');
    const beforeDelta: unknown = source.toDelta();
    const originalUnits = frameOf(editor).view.units.map((unit) => unit.id);
    const pre = tableSelection(view.state.doc, kind, false).toJSON();
    act(() => view.dispatch(view.state.tr.setSelection(tableSelection(view.state.doc, kind, false))));
    const edit = view.state.tr.addMark(6, 7, view.state.schema.mark('bold'));
    edit.setSelection(tableSelection(edit.doc, kind, true));
    const post = edit.selection.toJSON();
    act(() => view.dispatch(edit));
    expect(manager.undoStack).toHaveLength(1);
    expect(source.toString()).toBe('left');
    expect(view.state.doc.textContent).toBe('leftright');
    expect(view.state.doc.nodeAt(6)!.marks.map((mark) => mark.type.name)).toContain('bold');
    const formattedDelta: unknown = source.toDelta();
    const afterEdit = Y.encodeStateAsUpdate(doc);
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7))));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(afterEdit);
    act(() => { editor.undo(); });
    expect(manager.undoStack).toHaveLength(0);
    expect(manager.redoStack).toHaveLength(1);
    expect(view.state.selection.toJSON()).toEqual(pre);
    expect(view.state.selection.$anchor.doc).toBe(view.state.doc);
    expect(view.state.doc.nodeAt(6)!.marks.map((mark) => mark.type.name)).not.toContain('bold');
    expect(source.toDelta()).toEqual(beforeDelta);
    expect(frameOf(editor).view.units.map((unit) => unit.id)).toEqual(originalUnits);
    act(() => { editor.redo(); });
    expect(manager.undoStack).toHaveLength(1);
    expect(manager.redoStack).toHaveLength(0);
    expect(view.state.selection.toJSON()).toEqual(post);
    expect(view.state.selection.$anchor.doc).toBe(view.state.doc);
    expect(source.toDelta()).toEqual(formattedDelta);
    expect(frameOf(editor).view.units.map((unit) => unit.id)).toEqual(originalUnits);
  });

  for (const modern of [true, false]) {
    for (const direction of ['undo', 'redo'] as const) {
      it.each(['waiting', 'failed', 'disposed', 'permission'] as const)(`rejects %s at the actual ${modern ? 'modern command' : 'compatibility direct manager'} ${direction} entry`, (status) => {
        const { editor, doc, runtime, manager } = open([], undefined, modern);
        const view = editor.prosemirrorView;
        const originalUnits = frameOf(editor).view.units.map((unit) => unit.id);
        act(() => view.dispatch(view.state.tr.insertText('X', 4)));
        if (direction === 'redo') act(() => { editor.undo(); });
        assertFreshRunContent(doc, direction === 'redo' ? 'AB' : 'AXB', originalUnits);
        const before = Y.encodeStateAsUpdate(doc);
        const previousDoc: unknown = view.state.doc.toJSON();
        const previousSelection: unknown = view.state.selection.toJSON();
        const undoCount = manager.undoStack.length;
        const redoCount = manager.redoStack.length;
        act(() => {
          if (status === 'permission') editor.isEditable = false;
          else if (status === 'waiting') runtime.wait(['context:pending']);
          else if (status === 'disposed') runtime.dispose();
          else runtime.fail({ phase: 'history-test', error: new Error('Original binding failure'), batch: null, epoch: frameOf(editor).epoch,
            accepted: view.state.doc, selection: view.state.selection, journal: null, lastGood: frameOf(editor), writeStarted: false, writeReturned: false });
        });
        let result = true;
        act(() => { result = editor[direction](); });
        expect(result).toBe(false);
        expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
        expect(manager.undoStack).toHaveLength(undoCount);
        expect(manager.redoStack).toHaveLength(redoCount);
        expect(view.state.doc.toJSON()).toEqual(previousDoc);
        expect(view.state.selection.toJSON()).toEqual(previousSelection);
      });
    }
  }

  it('retains native history and source bytes across ordinary view teardown and remount', () => {
    const { editor, doc, runtime, manager } = open();
    const originalUnits = frameOf(editor).view.units.map((unit) => unit.id);
    act(() => editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.insertText('X', 4)));
    assertFreshRunContent(doc, 'AXB', originalUnits);
    const before = Y.encodeStateAsUpdate(doc);
    act(() => editor.unmount());
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(manager.undoStack).toHaveLength(1);
    expect(manager.redoStack).toHaveLength(0);
    expect(runtime.read().status).toBe('active');
    const nextHost = document.createElement('div');
    document.body.appendChild(nextHost);
    hosts.push(nextHost);
    act(() => editor.mount(nextHost));
    expect(editor.prosemirrorState.doc.textContent).toBe('AXB');
    act(() => { editor.undo(); });
    expect(editor.prosemirrorState.doc.textContent).toBe('AB');
    assertFreshRunContent(doc, 'AB', originalUnits);
    expect(manager.redoStack).toHaveLength(1);
    act(() => { editor.redo(); });
    expect(editor.prosemirrorState.doc.textContent).toBe('AXB');
    assertFreshRunContent(doc, 'AXB', originalUnits);
  });

  it('keeps earliest captured contributor payload and opposite inverse payload on exact characters', () => {
    const handed: BodySelectionName[] = [];
    let current: BodySelectionName | null = null;
    const extension = contribution(() => current, handed, (value) => { current = value; });
    const { editor, doc, manager } = open([extension]);
    const view = editor.prosemirrorView;
    const originalUnits = frameOf(editor).view.units.map((unit) => unit.id);
    current = nameBodySelection(frameOf(editor).index, TextSelection.create(view.state.doc, 4, 5));
    act(() => view.dispatch(view.state.tr.insertText('X', 4)));
    current = nameBodySelection(frameOf(editor).index, TextSelection.create(view.state.doc, 4, 5));
    act(() => view.dispatch(view.state.tr.insertText('Y', 5)));
    current = nameBodySelection(frameOf(editor).index, TextSelection.create(view.state.doc, 5, 6));
    expect(manager.undoStack).toHaveLength(1);
    assertFreshRunContent(doc, 'AXYB', originalUnits);
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3))));
    act(() => { editor.undo(); });
    expect(handed).toHaveLength(1);
    expect(view.state.doc.textContent).toBe('AB');
    assertFreshRunContent(doc, 'AB', originalUnits);
    assertContribution(editor, handed[0], 4, 5);
    expect(view.state.doc.textBetween(4, 5)).toBe('B');
    act(() => { editor.redo(); });
    expect(handed).toHaveLength(2);
    expect(view.state.doc.textContent).toBe('AXYB');
    assertContribution(editor, handed[1], 5, 6);
    expect(view.state.doc.textBetween(5, 6)).toBe('Y');
    act(() => { editor.undo(); });
    expect(handed).toHaveLength(3);
    assertContribution(editor, handed[2], 4, 5);
    act(() => { editor.redo(); });
    expect(handed).toHaveLength(4);
    assertContribution(editor, handed[3], 5, 6);
    assertFreshRunContent(doc, 'AXYB', originalUnits);
    const peer = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      documentBodySource(peer, 'S:A').insert(1, 'Z', { ctx: 'base' });
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer)));
    } finally {
      peer.destroy();
    }
    expect(view.state.doc.textContent).toBe('ZAXYB');
    expect(handed).toHaveLength(4);
    expect(manager.undoStack).toHaveLength(1);
  });

  it('names accepted new characters from their actual state before native history capture', () => {
    const handed: BodySelectionName[] = [];
    const observed: { readonly accepted: PMNode; readonly indexed: PMNode }[] = [];
    const extension = contribution((state) => {
      if (state.doc.textContent !== 'AXB') return null;
      const binding = bodyBindingOf(state);
      if (binding === null) throw new Error('Missing accepted-state binding');
      const frame = binding.read(state);
      observed.push({ accepted: state.doc, indexed: frame.index.doc });
      return nameBodySelection(frame.index, TextSelection.create(state.doc, 4, 5));
    }, handed);
    const { editor, doc, manager } = open([extension]);
    const view = editor.prosemirrorView;
    const originalUnits = frameOf(editor).view.units.map((unit) => unit.id);
    act(() => view.dispatch(view.state.tr.insertText('X', 4)));
    expect(view.state.doc.textContent).toBe('AXB');
    assertFreshRunContent(doc, 'AXB', originalUnits);
    expect(manager.undoStack).toHaveLength(1);
    expect(observed.some((frame) => frame.accepted.textContent === 'AXB')).toBe(true);
    for (const frame of observed) expect(frame.indexed).toBe(frame.accepted);
    act(() => { editor.undo(); });
    expect(handed).toHaveLength(1);
    expect(view.state.doc.textContent).toBe('AB');
    assertContribution(editor, handed[0], 4, 4);
    act(() => { editor.redo(); });
    expect(handed).toHaveLength(2);
    expect(view.state.doc.textContent).toBe('AXB');
    assertContribution(editor, handed[1], 4, 5);
  });
});
