// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec sections 10 to 13: the editors behind the
 * ProseMirror size filter and the delete executor, opened the way the spec
 * asks (0.1): the editor is mounted first, the content arrives as a remote
 * update built on another document, and the binding holds no `XmlText`
 * mapping before the case starts.
 *
 * The test file that imports this mocks `@web/lib/toast`; the assertions here
 * read that mock. Sizes are set through `setDocSize` (design 5.1, the only
 * writer), never through estimates.
 */

import { Editor, type Extensions } from '@tiptap/core';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  ySyncPluginKey as bodySyncKey,
  yXmlFragmentToProseMirrorRootNode as bodyRootNode,
} from 'y-prosemirror';
import { yXmlFragmentToProseMirrorRootNode as tiptapRootNode } from '@tiptap/y-tiptap';
import { Awareness } from 'y-protocols/awareness';
import { expect, vi } from 'vitest';
import * as Y from 'yjs';

import {
  CANVAS_NODES_KEY,
  documentBodyFragment,
  spaceContentDocName,
  updateShape,
} from '@breatic/shared';
import { clearAllDocSizes, setDocSize, startDocResync } from '@web/data/yjs/doc-size';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { P_FULL, P_NORMAL, P_OVER, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { ySyncPluginKey as tiptapSyncKey } from '@web/features/collab-editor/collab-plugin-keys';
import { PromptDocument, PromptNote } from '@web/features/prompt-note/prompt-note';
import { toast } from '@web/lib/toast';
import { buildTextNodeExtensions } from '@web/spaces/canvas/nodes/TextNodeEditor';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ReferenceMention, referenceMentionContent } from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';

export const PID = '11111111-1111-4111-8111-111111111111';
export const SID = '22222222-2222-4222-8222-222222222222';
/** The document Space whose body the BlockNote editor edits. */
export const DOCUMENT_NAME = spaceContentDocName(PID, SID, 'document');
/** The canvas Space whose nodes hold the TipTap fragments. */
export const CANVAS_NAME = spaceContentDocName(PID, SID, 'canvas');

/** Copy literals of spec 0.5, English. */
export { COPY_V2_EN as COPY } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

/** The state codes of spec 0.3. */
export type SizeCode = 'U' | 'N' | 'W' | 'F' | 'O' | 'Z';

/**
 * Puts a document into one of the spec's states.
 * @param name - The document name.
 * @param code - The state: never pushed, normal, warning, full, over the ceiling, resyncing.
 */
export function enterState(name: string, code: SizeCode): void {
  const pushes = { N: P_NORMAL, W: P_WARNING, F: P_FULL, O: P_OVER, Z: P_FULL } as const;
  if (code === 'U') return;
  setDocSize(name, { type: 'doc:size', ...pushes[code] });
  if (code === 'Z') startDocResync(name);
}

/**
 * Lets the executor's microtask and any zero-delay timer run.
 * @returns Resolves after both.
 */
export async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

/** The local updates one document emitted while a case ran. */
export interface Capture {
  /** Every local update so far, in order. */
  readonly updates: Uint8Array[];
  /** Stops listening. */
  stop: () => void;
  /** The spec 0.4 shape of everything captured, against the structs before the capture. */
  shape: () => Shape;
  /** The merged update, or null when nothing was captured. */
  merged: () => Uint8Array | null;
  /** The encoded document when the capture began. */
  readonly before: Uint8Array;
}

/** Spec 0.4 shape notation. */
export type Shape = 'S' | 'D' | 'R' | '∅';

/**
 * Starts collecting the local updates a document emits (spec 0.4).
 * @param doc - The document.
 * @returns The capture.
 */
export function capture(doc: Y.Doc): Capture {
  const mirror = new Y.Doc({ gc: false });
  const before = Y.encodeStateAsUpdate(doc);
  Y.applyUpdate(mirror, before);
  const updates: Uint8Array[] = [];
  /**
   * Keeps local updates only.
   * @param update - The update.
   * @param _origin - Its origin.
   * @param _doc - The document.
   * @param tr - The Yjs transaction.
   */
  const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void => {
    if (tr.local) updates.push(update);
  };
  doc.on('update', onUpdate);
  const merged = (): Uint8Array | null => (updates.length === 0 ? null : Y.mergeUpdates(updates));
  return {
    updates,
    before,
    stop: () => {
      doc.off('update', onUpdate);
    },
    merged,
    shape: () => {
      const u = merged();
      if (u === null) return '∅';
      const shape = updateShape(u, mirror.store);
      if (!shape.pureDelete) return 'S';
      return shape.wholeTypesOnly ? 'R' : 'D';
    },
  };
}

/**
 * Asserts the document is byte for byte what it was when the capture began, and nothing was written.
 * @param doc - The document.
 * @param cap - The capture.
 */
export function expectUntouched(doc: Y.Doc, cap: Capture): void {
  expect(cap.updates).toHaveLength(0);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(cap.before);
}

/**
 * Asserts exactly these warning toasts and no error toast (spec 0.6).
 * @param texts - The expected first arguments, in order.
 */
export function expectWarnings(...texts: string[]): void {
  expect(toast.warning).toHaveBeenCalledTimes(texts.length);
  texts.forEach((text, k) => {
    expect(vi.mocked(toast.warning).mock.calls[k]?.[0]).toBe(text);
  });
  expect(toast.error).not.toHaveBeenCalled();
}

/** Clears the toast mock between steps of one case. */
export function clearToasts(): void {
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
}

/**
 * Asserts the binding has written no text of its own: every `XmlText` reached
 * the editor from Yjs, so no mapping entry holds an array (spec 0.1).
 * @param view - The editor view.
 * @param key - The editor's sync plugin key.
 */
export function expectNoTextMappings(view: EditorView, key: PluginKey): void {
  const binding = (key.getState(view.state) as { binding: { mapping: Map<unknown, unknown> } }).binding;
  expect([...binding.mapping.values()].filter((value) => Array.isArray(value))).toHaveLength(0);
}

/**
 * Whether the platform's Mod key is Meta, as prosemirror-keymap decides it.
 * @returns True on a Mac platform string.
 */
function modIsMeta(): boolean {
  return /Mac|iP(hone|[oa]d)/.test(navigator.platform);
}

/** Modifier keys of one press. */
export interface Mods {
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/**
 * Presses a key as a real keydown on the editor's DOM, so ProseMirror runs
 * every plugin's `handleDOMEvents.keydown` and then its `handleKeyDown` chain
 * (tiptap-prosemirror skill: never `keyboardShortcut`).
 * @param view - The view.
 * @param key - The key value.
 * @param mods - Modifiers.
 * @returns Whether some handler took the key.
 */
export function press(view: EditorView, key: string, mods: Mods = {}): boolean {
  const meta = modIsMeta();
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
    metaKey: mods.mod === true && meta,
    ctrlKey: mods.mod === true && !meta,
  });
  view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Backspace with a collapsed caret inside a text run: no keymap takes it, and
 * the browser's own deletion reaches ProseMirror as a one-character delete.
 * @param view - The view.
 */
export function backspaceChar(view: EditorView): void {
  if (press(view, 'Backspace')) return;
  const { from } = view.state.selection;
  view.dispatch(view.state.tr.delete(from - 1, from));
}

/**
 * Types text at the selection the way the DOM observer hands input over.
 * @param view - The view.
 * @param text - What is typed.
 */
export function typeText(view: EditorView, text: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp('handleTextInput', (f) => f(view, from, to, text, () => view.state.tr.insertText(text, from, to)));
  if (handled !== true) view.dispatch(view.state.tr.insertText(text, from, to));
}

/**
 * Cuts the selection through the `cut` DOM event, with a clipboard that takes anything.
 * @param view - The view.
 */
export function cut(view: EditorView): void {
  // BlockNote leaves a cut to the browser when the DOM selection's focus sits
  // in a non-editable element; jsdom's DOM selection is not the editor's.
  window.getSelection()?.removeAllRanges();
  const event = new Event('cut', { bubbles: true, cancelable: true });
  const store = new Map<string, string>();
  Object.defineProperty(event, 'clipboardData', {
    value: {
      clearData: () => {
        store.clear();
      },
      setData: (type: string, value: string) => {
        store.set(type, value);
      },
      getData: (type: string) => store.get(type) ?? '',
      types: [],
    },
  });
  view.dom.dispatchEvent(event);
}

/**
 * Selects a range.
 * @param view - The view.
 * @param from - Anchor.
 * @param to - Head.
 */
export function select(view: EditorView, from: number, to = from): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/**
 * The position of a character inside the first text node holding the needle.
 * @param doc - The document.
 * @param needle - Text to find.
 * @param offset - Characters into the needle.
 * @returns The position.
 * @throws {Error} When the text is absent.
 */
export function posOf(doc: PMNode, needle: string, offset = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(needle)) found = pos + node.text!.indexOf(needle) + offset;
    return true;
  });
  if (found < 0) throw new Error(`text not found: ${needle}`);
  return found;
}

/**
 * The positions of every node of one type.
 * @param doc - The document.
 * @param type - The node type name.
 * @returns The positions before each, in order.
 */
export function nodesOf(doc: PMNode, type: string): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) out.push(pos);
    return true;
  });
  return out;
}

/**
 * Asserts the caret is collapsed at, or `TextSelection.near` either way of,
 * a position (executor template X item 6).
 * @param view - The view.
 * @param pos - The deletion's start in the document before it.
 */
export function expectCaretNear(view: EditorView, pos: number): void {
  const { doc, selection } = view.state;
  const at = doc.resolve(Math.min(pos, doc.content.size));
  // `near` falls back to a node selection where no text position exists (a lone image).
  const allowed = new Set([pos, TextSelection.near(at, 1).from, TextSelection.near(at, -1).from]);
  if (selection instanceof TextSelection) expect(selection.empty).toBe(true);
  expect([...allowed]).toContain(selection.from);
}

// ---------------------------------------------------------------------------
// The document body (BlockNote, y-prosemirror).

/** A block as `replaceBlocks` takes it. */
export type BlockInput = Record<string, unknown>;

/** The BlockNote editor `buildDocumentEditor` returns. */
export type BodyEditor = ReturnType<typeof buildDocumentEditor>;

/** The open document body. */
export interface OpenBody {
  readonly handle: DocumentEditorHandle;
  readonly editor: BodyEditor;
  readonly view: EditorView;
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly syncKey: PluginKey;
  /** Ids of the top-level blocks right after the remote load. */
  readonly ids: string[];
}

/**
 * Mounts the body editor of the document Space on its registered document
 * (state `unknown`), with nothing in it yet.
 * @returns The open body, empty.
 */
export function mountBody(): OpenBody {
  const doc = getDoc(DOCUMENT_NAME);
  const handle = getDocumentEditor(doc, DOCUMENT_NAME, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  const editor = handle.editor;
  return { handle, editor, view: editor.prosemirrorView, doc, fragment: documentBodyFragment(doc), syncKey: bodySyncKey, ids: [] };
}

/**
 * Builds content on another document with another body editor and applies it
 * to the open body as a remote update.
 * @param body - The open body.
 * @param blocks - The blocks the peer writes.
 */
export function loadBodyRemotely(body: OpenBody, blocks: BlockInput[]): void {
  const source = new Y.Doc();
  Y.applyUpdate(source, Y.encodeStateAsUpdate(body.doc));
  const peer = buildDocumentEditor({ fragment: documentBodyFragment(source) });
  const root = document.createElement('div');
  peer.mount(root);
  peer.replaceBlocks(peer.document, blocks as never);
  Y.applyUpdate(body.doc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(body.doc)), 'remote');
  peer.unmount();
  source.destroy();
}

/**
 * Applies an update a peer made on its own copy of the document.
 * @param doc - The document.
 * @param change - What the peer does to its copy.
 */
export function remoteChange(doc: Y.Doc, change: (peer: Y.Doc) => void): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const vector = Y.encodeStateVector(doc);
  change(peer);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, vector), 'remote');
  peer.destroy();
}

/**
 * A peer appends one paragraph block to the body (written by a peer editor).
 * @param doc - The document Space's document.
 * @param text - The paragraph's text.
 */
export function remoteBodyParagraph(doc: Y.Doc, text: string): void {
  remoteChange(doc, (peer) => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(peer) });
    editor.mount(document.createElement('div'));
    const last = editor.document.at(-1)!;
    editor.insertBlocks([{ type: 'paragraph', content: text }] as never, last, 'after');
    editor.unmount();
  });
}

/**
 * Opens the body with blocks loaded as a remote update, and checks the spec 0.1 preconditions.
 * @param blocks - The initial blocks.
 * @returns The open body.
 */
export function openBody(blocks: BlockInput[]): OpenBody {
  const body = mountBody();
  loadBodyRemotely(body, blocks);
  // The body acts on copy, cut and paste only while it holds the focus.
  body.view.dom.focus();
  expectNoTextMappings(body.view, body.syncKey);
  return { ...body, ids: body.editor.document.map((block) => block.id) };
}

/** A block simplified to `[type, text]` or `[type, text, children]` (template X item 2). */
export type Row = [string, string] | [string, string, Row[]];

/**
 * The body's blocks as `[type, text, children]`, read from the ProseMirror document.
 * @param doc - The body's ProseMirror document.
 * @returns The rows.
 */
export function rows(doc: PMNode): Row[] {
  /**
   * One block group's rows.
   * @param group - The group.
   * @returns Its rows.
   */
  const ofGroup = (group: PMNode): Row[] => {
    const out: Row[] = [];
    group.forEach((child) => {
      // A table sits in the group itself, not in a blockContainer.
      if (child.type.name !== 'blockContainer') {
        out.push([child.type.name, child.textContent]);
        return;
      }
      const content = child.firstChild!;
      const kids = child.childCount > 1 ? ofGroup(child.child(1)) : null;
      out.push(kids === null ? [content.type.name, content.textContent] : [content.type.name, content.textContent, kids]);
    });
    return out;
  };
  return ofGroup(doc.firstChild!);
}

/**
 * Asserts the body editor and its Yjs fragment show the same document (design 5.3 redraw).
 * @param body - The open body.
 */
export function expectBodyInStep(body: OpenBody): void {
  expect(bodyRootNode(body.fragment, body.view.state.schema).eq(body.view.state.doc)).toBe(true);
}

// ---------------------------------------------------------------------------
// The canvas TipTap editors (y-tiptap): text node body, prompt, lyrics.

/** Which canvas fragment an editor edits. */
export type TiptapKind = 'textBody' | 'prompt' | 'lyrics';

export const NODE_ID = 'node-1';
export const MODE = 'text-to-image';

export const CHIP_A: ReferenceRailItem = { refId: 'a->me', sourceNodeId: 'a', sourceNodeType: 'image', sourceNodeName: 'A', thumbnail: 'a.png' };
export const CHIP_B: ReferenceRailItem = { refId: 'b->me', sourceNodeId: 'b', sourceNodeType: 'image', sourceNodeName: 'B', thumbnail: 'b.png' };

/** The open TipTap editor. */
export interface OpenTiptap {
  readonly kind: TiptapKind;
  readonly editor: Editor;
  readonly view: EditorView;
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly syncKey: PluginKey;
}

/**
 * The fragment of one kind inside a node's data, read the way the canvas reads it.
 * @param doc - The canvas document.
 * @param kind - Which fragment.
 * @returns The fragment.
 * @throws {Error} When the node does not hold it.
 */
function fragmentOf(doc: Y.Doc, kind: TiptapKind): Y.XmlFragment {
  const data = doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get(NODE_ID)?.get('data');
  if (!(data instanceof Y.Map)) throw new Error('node data missing');
  const found = kind === 'textBody' ? data.get('body') : (data.get(kind === 'prompt' ? 'prompts' : 'lyrics') as Y.Map<unknown>).get(MODE);
  if (!(found instanceof Y.XmlFragment)) throw new Error(`${kind} fragment missing`);
  return found;
}

/**
 * The extension list one kind of editor is built with: the text node's own
 * builder, and for the prompt and lyrics the list `PromptEditor` composes
 * (both editors are a `PromptEditor`), with the reference chip extension that
 * installs the chip whitespace plugin.
 * @param kind - Which editor.
 * @param fragment - The fragment it edits.
 * @returns The extensions.
 */
export function tiptapExtensions(kind: TiptapKind, fragment: Y.XmlFragment): Extensions {
  if (kind === 'textBody') return buildTextNodeExtensions({ fragment, placeholder: '' });
  const pool = [CHIP_A, CHIP_B];
  return [
    PromptDocument,
    Paragraph,
    Text,
    PromptNote,
    ...buildCollabExtensions({ fragment }),
    ReferenceMention.configure({
      suggestion: makeReferenceSuggestion({ getPool: () => pool, emptyLabel: 'No references' }),
      getPool: () => pool,
    }),
  ];
}

const tiptapEditors: Editor[] = [];

/**
 * Opens one TipTap editor on a node of the registered canvas document, with
 * its content written by a peer editor and applied as a remote update, and
 * checks the spec 0.1 preconditions.
 * @param kind - Which editor.
 * @param content - The ProseMirror JSON of the document the peer writes.
 * @returns The open editor.
 */
export function openTiptap(kind: TiptapKind, content: Record<string, unknown>): OpenTiptap {
  const doc = getDoc(CANVAS_NAME);
  // The node arrives first, from a peer, with its fragments seeded empty.
  remoteChange(doc, (peer) => {
    const data = new Y.Map<unknown>();
    data.set('body', new Y.XmlFragment());
    const prompts = new Y.Map<unknown>();
    prompts.set(MODE, new Y.XmlFragment());
    data.set('prompts', prompts);
    const lyrics = new Y.Map<unknown>();
    lyrics.set(MODE, new Y.XmlFragment());
    data.set('lyrics', lyrics);
    const node = new Y.Map<unknown>();
    node.set('id', NODE_ID);
    node.set('data', data);
    peer.getMap(CANVAS_NODES_KEY).set(NODE_ID, node);
  });
  const fragment = fragmentOf(doc, kind);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: tiptapExtensions(kind, fragment) });
  tiptapEditors.push(editor);
  // Then the words, written by a peer's own editor of the same kind.
  remoteChange(doc, (peer) => {
    const peerEditor = new Editor({ element: document.createElement('div'), extensions: tiptapExtensions(kind, fragmentOf(peer, kind)) });
    peerEditor.commands.setContent(content);
    peerEditor.destroy();
  });
  const open: OpenTiptap = { kind, editor, view: editor.view, doc, fragment, syncKey: tiptapSyncKey };
  expectNoTextMappings(open.view, open.syncKey);
  return open;
}

/**
 * A peer edits the same fragment with its own editor of the same kind, and
 * the change arrives as a remote update.
 * @param open - The open editor.
 * @param edit - What the peer's editor does.
 */
export function remoteTiptapEdit(open: OpenTiptap, edit: (peer: Editor) => void): void {
  remoteChange(open.doc, (peer) => {
    const peerEditor = new Editor({ element: document.createElement('div'), extensions: tiptapExtensions(open.kind, fragmentOf(peer, open.kind)) });
    edit(peerEditor);
    peerEditor.destroy();
  });
}

/**
 * A peer edits the same fragment's Yjs types directly, and the change arrives as a remote update.
 * @param open - The open editor.
 * @param edit - What the peer does to its copy of the fragment.
 */
export function remoteTiptapYjs(open: OpenTiptap, edit: (fragment: Y.XmlFragment) => void): void {
  remoteChange(open.doc, (peer) => {
    edit(fragmentOf(peer, open.kind));
  });
}

/**
 * A document of plain paragraphs, as ProseMirror JSON.
 * @param texts - One paragraph each; an empty string is an empty paragraph.
 * @returns The JSON.
 */
export function paragraphs(...texts: string[]): Record<string, unknown> {
  return {
    type: 'doc',
    content: texts.map((text) => (text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

/**
 * One paragraph of text and chips, as ProseMirror JSON.
 * @param parts - Text runs and chips in order.
 * @returns The JSON.
 */
export function chipParagraph(...parts: Array<string | ReferenceRailItem>): Record<string, unknown> {
  return {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: parts.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : referenceMentionContent(part))),
    }],
  };
}

/**
 * Asserts a TipTap editor and its Yjs fragment show the same document.
 * @param open - The open editor.
 */
export function expectTiptapInStep(open: OpenTiptap): void {
  expect(tiptapRootNode(open.fragment, open.view.state.schema).eq(open.view.state.doc)).toBe(true);
}

/**
 * The paragraphs' texts of a TipTap document.
 * @param doc - The document.
 * @returns One string per paragraph.
 */
export function paragraphTexts(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((node) => {
    if (node.type.name === 'paragraph') out.push(node.textContent);
  });
  return out;
}

/** Tears down every editor, document and size state the harness made. */
export function resetHarness(): void {
  tiptapEditors.splice(0).forEach((editor) => {
    editor.destroy();
  });
  _resetDocumentEditorCacheForTests();
  clearAllDocSizes();
  _resetForTests();
  document.body.innerHTML = '';
}
