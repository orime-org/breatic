// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { documentBodyFragment, documentBodySource } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { selectWordlessBlock } from '@web/spaces/document/document-block-place';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { nameBodySelection, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import type { BodySelectionName } from '@web/spaces/document/document-body-positions-types';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { documentCaretExtension } from '@web/spaces/document/document-caret';
import type { DocumentBodyCursor } from '@web/spaces/document/document-caret-types';
import { cleanupCodecFixtures, codecFixture, codecNativeTokens, codecSchema } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

type MediaType = 'image' | 'video' | 'audio';

const NAME = 'document:media-selection';
const editors: ReturnType<typeof buildDocumentEditor>[] = [];
const histories: Y.UndoManager[] = [];
const runtimes: ReturnType<typeof createDocumentBodyRuntime>[] = [];
const providers: Awareness[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  act(() => editors.splice(0).forEach((editor) => editor.unmount()));
  histories.splice(0).forEach((history) => history.destroy());
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  providers.splice(0).forEach((awareness) => awareness.destroy());
  hosts.splice(0).forEach((host) => host.remove());
  cleanupCodecFixtures();
  vi.restoreAllMocks();
});

/**
 * Creates real records for one wordless media owner and a following native text owner.
 * @param type - The actual production media content type.
 * @returns A complete native document without a fabricated content-node identity.
 * @throws {Error} If the shared records boundary rejects the fixture.
 */
function mediaFixture(type: MediaType): Y.Doc {
  return codecFixture([
    { id: 'media', type, text: '', attrs: { url: `https://example.com/original.${type}`, name: 'original', caption: 'before' } },
    { id: 'tail', text: 'TAIL' },
  ]);
}

/**
 * Reads the actual legal codec frame with the real BlockNote schema.
 * @param doc - The native records fixture.
 * @param schema - The actual production schema.
 * @returns The complete final projection.
 * @throws {Error} If the fixture has incomplete native dependencies.
 */
function project(doc: Y.Doc, schema: Schema): BodyProjection {
  const result = projectBodyTree(doc, schema, { document: NAME, epoch: 1 });
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('Expected complete media projection');
  return result.projection;
}

/**
 * Finds the real media content position independently of the common index under test.
 * @param doc - The actual immutable PM document.
 * @param type - The expected media content type.
 * @returns The original content-node position.
 * @throws {Error} If the actual schema projection lacks the requested media.
 */
function mediaPosition(doc: PMNode, type: MediaType): number {
  let position = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === type) position = pos;
  });
  if (position < 0) throw new Error('Expected an actual media content node');
  return position;
}

/**
 * Names and restores a JSON-serialized final selection without changing the selected node.
 * @param frame - The actual codec or binding frame.
 * @param selection - The independently constructed PM node selection.
 * @returns The actual stable common selection name.
 * @throws {Error} If common-name resolution fails.
 */
function roundtrip(frame: BodyProjection, selection: NodeSelection): BodySelectionName {
  const name = nameBodySelection(frame.index, selection);
  expect(name).toMatchObject({ version: 1, document: NAME, kind: 'node', node: 'media' });
  const wire = JSON.parse(JSON.stringify(name)) as BodySelectionName;
  const restored = resolveBodySelection(frame.index, wire);
  expect(restored.status).toBe('resolved');
  if (restored.status !== 'resolved') throw new Error('Expected exact common node selection restoration');
  expect(restored.selection).toBeInstanceOf(NodeSelection);
  expect(restored.selection.toJSON()).toEqual(selection.toJSON());
  expect((restored.selection as NodeSelection).node.toJSON()).toEqual(selection.node.toJSON());
  expect(restored.selection.$anchor.doc).toBe(frame.doc);
  return name;
}

/**
 * Mounts the real factory, original native history, shared runtime and optional actual caret plugin.
 * @param type - The production media content type.
 * @param caret - Whether to attach the real awareness-backed caret entry.
 * @returns The original handle resources and production editor.
 * @throws {Error} If actual assembly or mounting fails.
 */
function open(type: MediaType, caret = false): {
  doc: Y.Doc; editor: ReturnType<typeof buildDocumentEditor>; manager: Y.UndoManager;
  runtime: ReturnType<typeof createDocumentBodyRuntime>; awareness: Awareness | null;
} {
  const doc = mediaFixture(type);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const undo = createDocumentUndo(doc, { origin, runtime });
  const awareness = caret ? new Awareness(doc) : null;
  if (awareness !== null) {
    providers.push(awareness);
    awareness.setLocalStateField('user', { focused: true });
  }
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    body: { document: NAME, origin, runtime, history: undo.manager },
    extensions: [undo.extension, ...awareness === null ? [] : [documentCaretExtension(awareness, undefined, { document: NAME, runtime })]],
  });
  const host = document.createElement('div');
  editors.push(editor);
  histories.push(undo.manager);
  runtimes.push(runtime);
  hosts.push(host);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  return { doc, editor, manager: undo.manager, runtime, awareness };
}

/**
 * Reads the current frame from the actual bound editor instead of constructing another index.
 * @param editor - The actual mounted records editor.
 * @returns Its exact current common frame.
 * @throws {Error} If the production binding is missing.
 */
function frameOf(editor: ReturnType<typeof buildDocumentEditor>): BodyProjection {
  const binding = bodyBindingOf(editor.prosemirrorState);
  if (binding === null) throw new Error('Expected the actual records binding');
  return binding.read(editor.prosemirrorState);
}

describe('media content-node names through common positions history and caret', () => {
  it.each(['image', 'video', 'audio'] as const)('roundtrips exact %s content and wrapper NodeSelections as distinct names', (type) => {
    const doc = mediaFixture(type);
    const frame = project(doc, codecSchema());
    const contentPos = mediaPosition(frame.doc, type);
    const content = NodeSelection.create(frame.doc, contentPos);
    const wrapper = NodeSelection.create(frame.doc, contentPos - 1);
    const before = Y.encodeStateAsUpdate(doc);
    expect(content.node.type.name).toBe(type);
    expect(wrapper.node.type.name).toBe('blockContainer');
    expect(content.toJSON()).toEqual({ type: 'node', anchor: contentPos });
    expect(wrapper.toJSON()).toEqual({ type: 'node', anchor: contentPos - 1 });
    const wrapperName = roundtrip(frame, wrapper);
    const contentName = roundtrip(frame, content);
    expect(contentName).not.toEqual(wrapperName);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['image', 'video', 'audio'] as const)('restores the exact %s content selection around one native caption undo and redo', (type) => {
    const { doc, editor, manager, runtime } = open(type);
    const view = editor.prosemirrorView;
    const contentPos = mediaPosition(view.state.doc, type);
    const content = NodeSelection.create(view.state.doc, contentPos);
    const before = view.state.doc.toJSON();
    const native = codecNativeTokens(doc, 'tail', 4);
    const source = documentBodySource(doc, 'S:media');
    const originalDelta: unknown = source.toDelta();
    expect(content.node.attrs['caption']).toBe('before');
    act(() => view.dispatch(view.state.tr.setSelection(content)));
    const edit = view.state.tr.setNodeMarkup(contentPos, undefined, { ...content.node.attrs, caption: 'after' });
    edit.setSelection(NodeSelection.create(edit.doc, contentPos));
    act(() => view.dispatch(edit));
    expect(runtime.read().status).toBe('active');
    expect(manager.undoStack).toHaveLength(1);
    expect(view.state.doc.nodeAt(contentPos)!.attrs['caption']).toBe('after');
    expect(view.state.selection.toJSON()).toEqual(content.toJSON());
    const after = view.state.doc.toJSON();
    const tail = frameOf(editor).index.units.find((unit) => unit.owner === 'tail')!.pos;
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, tail))));
    act(() => { editor.undo(); });
    expect(manager.undoStack).toHaveLength(0);
    expect(manager.redoStack).toHaveLength(1);
    expect(view.state.doc.toJSON()).toEqual(before);
    expect(view.state.selection.toJSON()).toEqual(content.toJSON());
    expect((view.state.selection as NodeSelection).node.type.name).toBe(type);
    act(() => { editor.redo(); });
    expect(manager.undoStack).toHaveLength(1);
    expect(manager.redoStack).toHaveLength(0);
    expect(view.state.doc.toJSON()).toEqual(after);
    expect(view.state.selection.toJSON()).toEqual(content.toJSON());
    expect((view.state.selection as NodeSelection).node.type.name).toBe(type);
    expect(codecNativeTokens(doc, 'tail', 4)).toEqual(native);
    expect(source.toDelta()).toEqual(originalDelta);
  });

  it.each(['image', 'video', 'audio'] as const)('publishes a final serializable %s content selection from the actual media press helper', async (type) => {
    const { doc, editor, awareness, manager, runtime } = open(type, true);
    if (awareness === null) throw new Error('Expected the actual caret awareness');
    const view = editor.prosemirrorView;
    const contentPos = mediaPosition(view.state.doc, type);
    const expected = NodeSelection.create(view.state.doc, contentPos);
    const row = view.dom.querySelector(`[data-content-type="${type}"]`);
    expect(row).toBeInstanceOf(Element);
    if (row === null) throw new Error('Expected the actual mounted media content element');
    const before = Y.encodeStateAsUpdate(doc);
    const report = vi.spyOn(console, 'error');
    await act(async () => {
      selectWordlessBlock(view, row);
      view.focus();
      await Promise.resolve();
    });
    expect(view.state.selection.toJSON()).toEqual(expected.toJSON());
    expect((view.state.selection as NodeSelection).node.type.name).toBe(type);
    expect(view.hasFocus()).toBe(true);
    const cursor: unknown = awareness.getLocalState()?.['cursor'];
    expect(cursor).toMatchObject({ format: 'breatic.document.records', version: 1, document: NAME, selection: { kind: 'node', node: 'media' } });
    if (cursor === null || typeof cursor !== 'object' || !('selection' in cursor)) throw new Error('The media content selection must be published');
    const wire = JSON.parse(JSON.stringify(cursor)) as DocumentBodyCursor;
    const resolved = resolveBodySelection(frameOf(editor).index, wire.selection);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('The final serialized media name must resolve');
    expect(resolved.selection.toJSON()).toEqual(expected.toJSON());
    expect((resolved.selection as NodeSelection).node.type.name).toBe(type);
    expect(report).not.toHaveBeenCalledWith('document_caret_publication_failed', expect.anything());
    expect(runtime.read().status).toBe('active');
    expect(manager.undoStack).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});
