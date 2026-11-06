// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 web test spec section 10, W-146 and W-147: the shared ProseMirror
 * size filter on the BlockNote document body, bound on the y-prosemirror sync
 * key. The editor is opened through the cache a document Space mounts
 * (`getDocumentEditor`), on the registered Y.Doc of a document Space whose
 * provider receives the `doc:size` pushes. The two TipTap editors are in
 * `features/collab-editor/__tests__/space-size-filter.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { AttrStep, Step, StepResult, type Mappable } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey as yProsemirrorSyncKey } from 'y-prosemirror';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { documentBodyFragment, formatBytes, spaceContentDocName, SPACE_DELETE_MIN_BYTES } from '@breatic/shared';
import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { estimateSliceBytes } from '@web/data/yjs/space-write';
import { ySyncPluginKey as yTiptapSyncKey } from '@web/features/collab-editor/collab-plugin-keys';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { deleteRow } from '@web/spaces/document/document-handle-commands';
import { push, resetProviderSpies, type ProviderSpy } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN,
  F_AT_CEILING,
  F_FULL,
  F_FULL_NEAR,
  F_OVER,
  F_WARNING,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = spaceContentDocName(PID, SID, 'document');

type BodyEditor = ReturnType<typeof buildDocumentEditor>;

/** A block as `replaceBlocks` takes it. */
type BlockInput = Record<string, unknown>;

/** The open body and the document behind it. */
interface Open {
  readonly editor: BodyEditor;
  readonly view: EditorView;
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly provider: ProviderSpy;
}

const extraEditors: BodyEditor[] = [];

/**
 * Opens the document body the way a document Space does and writes the
 * initial blocks before any size push (state `unknown`, everything allowed).
 * @param blocks - The initial blocks.
 * @returns The open body.
 */
function open(blocks: BlockInput[] = [{ type: 'paragraph', content: 'hello world' }]): Open {
  const doc = getDoc(NAME);
  const provider = acquireDocProvider(NAME, doc) as unknown as ProviderSpy;
  const handle = getDocumentEditor(doc, NAME, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  const editor = handle.editor as unknown as BodyEditor;
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, view: editor.prosemirrorView!, doc, fragment: documentBodyFragment(doc), provider };
}

/**
 * The position of a character inside the first text node that contains the
 * needle.
 * @param doc - The ProseMirror document.
 * @param needle - Text to find.
 * @param offset - Characters into the needle.
 * @returns The document position.
 * @throws {Error} When the text is absent.
 */
function posOf(doc: PMNode, needle: string, offset = 0): number {
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
 * Every `blockContainer` with its position.
 * @param doc - The ProseMirror document.
 * @returns The containers in document order.
 */
function containers(doc: PMNode): Array<{ node: PMNode; pos: number }> {
  const out: Array<{ node: PMNode; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer') out.push({ node, pos });
    return true;
  });
  return out;
}

/**
 * Whether the text run starting at the needle carries bold.
 * @param state - Editor state.
 * @param needle - Text inside the run.
 * @returns True when bold is on it.
 */
function isBold(state: EditorState, needle: string): boolean {
  const pos = posOf(state.doc, needle);
  return state.doc.resolve(pos + 1).marks().some((mark) => mark.type.name === 'bold');
}

/**
 * Everything a blocked edit must leave unchanged.
 * @param o - The open body.
 * @returns PM document, Y fragment and the whole Y.Doc encoding.
 */
function snapshot(o: Open): { pm: unknown; y: string; update: Uint8Array } {
  return { pm: o.view.state.doc.toJSON(), y: o.fragment.toString(), update: Y.encodeStateAsUpdate(o.doc) };
}

/**
 * Asserts nothing changed since `before`.
 * @param o - The open body.
 * @param before - The earlier snapshot.
 */
function expectUnchanged(o: Open, before: ReturnType<typeof snapshot>): void {
  const after = snapshot(o);
  expect(after.pm).toEqual(before.pm);
  expect(after.y).toBe(before.y);
  expect(after.update).toEqual(before.update);
}

/**
 * Asserts exactly one warning toast with this text and no error toast.
 * @param text - Expected toast text.
 */
function expectOneWarning(text: string): void {
  expect(toast.warning).toHaveBeenCalledTimes(1);
  expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toBe(text);
  expect(toast.error).not.toHaveBeenCalled();
}

/** Asserts no toast at all. */
function expectNoToast(): void {
  expect(toast.warning).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
}

/**
 * Sends a size push for the document Space.
 * @param o - The open body.
 * @param fixture - The push.
 */
function size(o: Open, fixture: DocSizePush): void {
  push(o.provider, fixture);
}

/**
 * Places the caret, or selects a range.
 * @param o - The open body.
 * @param from - Anchor.
 * @param to - Head.
 */
function select(o: Open, from: number, to = from): void {
  o.view.dispatch(o.view.state.tr.setSelection(TextSelection.create(o.view.state.doc, from, to)));
}

/**
 * Deletes the character before a position the way a browser Backspace inside
 * a text run reaches ProseMirror: one empty-slice ReplaceStep.
 * @param o - The open body.
 * @param at - The caret position.
 */
function backspace(o: Open, at: number): void {
  o.view.dispatch(o.view.state.tr.delete(at - 1, at));
}

/**
 * Bolds `hello` while nothing has been pushed yet.
 * @param o - The open body.
 */
function boldHello(o: Open): void {
  const from = posOf(o.view.state.doc, 'hello');
  o.view.dispatch(o.view.state.tr.addMark(from, from + 5, o.view.state.schema.marks['bold']!.create()));
  expect(isBold(o.view.state, 'hello')).toBe(true);
}

/**
 * Pastes plain text at the selection as the one-step transaction the filter
 * judges. Not `view.pasteText`: BlockNote's paste handler parses the clipboard
 * first, and on 786k characters that takes minutes in jsdom before any
 * transaction exists.
 * @param o - The open body.
 * @param text - The pasted text.
 */
function pastePlain(o: Open, text: string): void {
  o.view.dispatch(o.view.state.tr.replaceSelection(new Slice(Fragment.from(o.view.state.schema.text(text)), 0, 0)));
}

beforeEach(() => {
  changeLocale('en');
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  extraEditors.splice(0).forEach((editor) => { editor.unmount(); });
  _resetDocumentEditorCacheForTests();
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
  document.body.innerHTML = '';
});

describe('the document body size filter (y-prosemirror key)', () => {
  it('W-98: lets a remote transaction through while full', () => {
    const o = open();
    size(o, F_FULL);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(o.doc));
    const other = buildDocumentEditor({ fragment: documentBodyFragment(remote), extensions: [] });
    const root = document.createElement('div');
    document.body.appendChild(root);
    other.mount(root);
    extraEditors.push(other);
    other.insertBlocks([{ type: 'paragraph', content: 'remote' }] as never, other.document.at(-1)!, 'after');
    Y.applyUpdate(o.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(o.doc)));

    expect(o.view.state.doc.textContent).toBe('hello worldremote');
    expectNoToast();
  });

  it('W-99: does not treat the y-tiptap sync key as its own', () => {
    const o = open();
    size(o, F_FULL);
    const before = snapshot(o);
    o.view.dispatch(o.view.state.tr.insertText('Z', posOf(o.view.state.doc, 'hello', 5)).setMeta(yTiptapSyncKey, { isChangeOrigin: true }));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });

  it('W-100: blocks typing while full', () => {
    const o = open();
    size(o, F_FULL);
    select(o, posOf(o.view.state.doc, 'hello', 5));
    const before = snapshot(o);
    o.view.dispatch(o.view.state.tr.insertText('a'));
    expectUnchanged(o, before);
    expect(o.view.state.doc.textContent).toBe('hello world');
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });

  describe('W-101: while full, growth that does not grow content.size is blocked', () => {
    it('(a) bolding `hello`', () => {
      const o = open();
      size(o, F_FULL);
      const before = snapshot(o);
      const from = posOf(o.view.state.doc, 'hello');
      o.view.dispatch(o.view.state.tr.addMark(from, from + 5, o.view.state.schema.marks['bold']!.create()));
      expectUnchanged(o, before);
      expect(isBold(o.view.state, 'hello')).toBe(false);
      expectOneWarning(COPY_EN.T_ADD_BLOCKED);
    });

    it('(b) centring the paragraph', () => {
      const o = open();
      size(o, F_FULL);
      const before = snapshot(o);
      const id = (o.editor.document[0] as { id: string }).id;
      o.editor.updateBlock(id, { props: { textAlignment: 'center' } } as never);
      expectUnchanged(o, before);
      expect((o.editor.document[0] as { props: { textAlignment: string } }).props.textAlignment).toBe('left');
      expectOneWarning(COPY_EN.T_ADD_BLOCKED);
    });

    it('(c) replacing everything with three paragraphs', () => {
      const o = open();
      size(o, F_FULL);
      const before = snapshot(o);
      o.editor.replaceBlocks(o.editor.document, [
        { type: 'paragraph', content: 'a' },
        { type: 'paragraph', content: 'b' },
        { type: 'paragraph', content: 'c' },
      ] as never);
      expectUnchanged(o, before);
      expect(o.view.state.doc.textContent).toBe('hello world');
      expectOneWarning(COPY_EN.T_ADD_BLOCKED);
    });
  });

  describe('W-102: while full, removing a mark and deleting are allowed', () => {
    it('(a) unbolding `hello`', () => {
      const o = open();
      boldHello(o);
      size(o, F_FULL);
      const yBefore = o.fragment.toString();
      const from = posOf(o.view.state.doc, 'hello');
      o.view.dispatch(o.view.state.tr.removeMark(from, from + 5, o.view.state.schema.marks['bold']!));
      expect(isBold(o.view.state, 'hello')).toBe(false);
      expect(o.fragment.toString()).not.toBe(yBefore);
      expectNoToast();
    });

    it('(b) Backspace at the end', () => {
      const o = open();
      size(o, F_FULL);
      const yBefore = o.fragment.toString();
      backspace(o, posOf(o.view.state.doc, 'hello world', 11));
      expect(o.view.state.doc.textContent).toBe('hello worl');
      expect(o.fragment.toString()).not.toBe(yBefore);
      expect(o.fragment.toString()).toContain('hello worl');
      expect(o.fragment.toString()).not.toContain('hello world');
      expectNoToast();
    });
  });

  describe('W-103: under the room, a paste over its UTF-8 estimate is blocked', () => {
    it('(a) 786433 ASCII characters', () => {
      const o = open();
      size(o, F_WARNING);
      select(o, posOf(o.view.state.doc, 'hello', 5));
      const before = snapshot(o);
      pastePlain(o, 'a'.repeat(786433));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM('768 KiB'));
    });

    it('(b) 262145 three-byte characters: fewer characters than the room, more bytes', () => {
      const o = open();
      size(o, F_WARNING);
      select(o, posOf(o.view.state.doc, 'hello', 5));
      const before = snapshot(o);
      pastePlain(o, '中'.repeat(262145));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM('768 KiB'));
    });

    it('(c) 1000 characters fit', () => {
      const o = open();
      size(o, F_WARNING);
      select(o, posOf(o.view.state.doc, 'hello', 5));
      pastePlain(o, 'a'.repeat(1000));
      expect(o.view.state.doc.textContent).toBe(`hello${'a'.repeat(1000)} world`);
      expect(o.fragment.toString()).toContain('a'.repeat(1000));
      expectNoToast();
    });

    it('(d) a room equal to the slice estimate admits it, one byte less blocks it', () => {
      const o = open();
      const slice = new Slice(Fragment.from(o.view.state.schema.text('a'.repeat(1000))), 0, 0);
      const estimate = estimateSliceBytes(slice);
      expect(estimate).toBeGreaterThanOrEqual(1000);

      size(o, { ...F_WARNING, room: estimate - 1 });
      select(o, posOf(o.view.state.doc, 'hello', 5));
      const before = snapshot(o);
      o.view.dispatch(o.view.state.tr.replaceSelection(slice));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM(formatBytes(estimate - 1)));

      vi.mocked(toast.warning).mockClear();
      size(o, { ...F_WARNING, room: estimate });
      select(o, posOf(o.view.state.doc, 'hello', 5));
      o.view.dispatch(o.view.state.tr.replaceSelection(slice));
      expect(o.view.state.doc.textContent).toBe(`hello${'a'.repeat(1000)} world`);
      expectNoToast();
    });
  });

  describe('W-104: a mark costs 32 bytes per affected text node', () => {
    it('room 1: bolding `hello` is blocked', () => {
      const o = open();
      size(o, F_WARNING_TIGHT);
      const before = snapshot(o);
      const from = posOf(o.view.state.doc, 'hello');
      o.view.dispatch(o.view.state.tr.addMark(from, from + 5, o.view.state.schema.marks['bold']!.create()));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM('1 B'));
    });

    it('room 786432: bolding `hello` applies', () => {
      const o = open();
      size(o, F_WARNING);
      const from = posOf(o.view.state.doc, 'hello');
      o.view.dispatch(o.view.state.tr.addMark(from, from + 5, o.view.state.schema.marks['bold']!.create()));
      expect(isBold(o.view.state, 'hello')).toBe(true);
      expectNoToast();
    });
  });

  describe('attribute and node-mark steps are judged by what they write', () => {
    /**
     * The paragraph node inside the first block.
     * @param o - The open body.
     * @returns Its position.
     */
    function paragraphAt(o: Open): number {
      return containers(o.view.state.doc)[0]!.pos + 1;
    }

    /** A step type the filter does not know, carrying a payload it writes. */
    class CarryingStep extends Step {
      /**
       * @param inner - The change it makes.
       * @param carried - What it carries.
       */
      constructor(private readonly inner: AttrStep, private readonly carried: string) {
        super();
      }

      /**
       * Applies the inner change.
       * @param doc - The document.
       * @returns The result.
       */
      apply(doc: PMNode): StepResult {
        return this.inner.apply(doc);
      }

      /**
       * Inverts the inner change.
       * @param doc - The document before the step.
       * @returns The inverse step.
       */
      invert(doc: PMNode): Step {
        return this.inner.invert(doc);
      }

      /**
       * Positions do not move.
       * @param _mapping - Unused.
       * @returns This step.
       */
      map(_mapping: Mappable): Step {
        return this;
      }

      /**
       * Serialises the step with its payload.
       * @returns The JSON.
       */
      toJSON(): { stepType: string; carried: string } {
        return { stepType: 'carrying', carried: this.carried };
      }
    }

    it('refuses a long attribute value the room cannot take', () => {
      const o = open();
      size(o, { ...F_WARNING, room: 1000 });
      const before = snapshot(o);
      o.view.dispatch(o.view.state.tr.setNodeAttribute(paragraphAt(o), 'textAlignment', 'x'.repeat(5000)));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM(formatBytes(1000)));
    });

    it('writes an attribute value no longer than the one it replaces at full', () => {
      const o = open([{ type: 'paragraph', content: 'hello world', props: { textAlignment: 'center' } }] as BlockInput[]);
      size(o, F_FULL);
      o.view.dispatch(o.view.state.tr.setNodeAttribute(paragraphAt(o), 'textAlignment', 'left'));
      expect(o.view.state.doc.nodeAt(paragraphAt(o))!.attrs['textAlignment']).toBe('left');
      expectNoToast();
    });

    it('unticks a check list item at full, which takes the same bytes as ticking it', () => {
      const o = open([{ type: 'checkListItem', content: 'task', props: { checked: true } }] as BlockInput[]);
      size(o, F_FULL);
      const id = (o.editor.document[0] as { id: string }).id;
      o.editor.updateBlock(id, { props: { checked: false } } as never);
      expect((o.editor.document[0] as { props: { checked: boolean } }).props.checked).toBe(false);
      expectNoToast();
    });

    it('refuses a same-type markup change whose attributes the room cannot take', () => {
      const o = open();
      size(o, { ...F_WARNING, room: 1000 });
      const before = snapshot(o);
      const at = paragraphAt(o);
      const attrs = o.view.state.doc.nodeAt(at)!.attrs;
      o.view.dispatch(o.view.state.tr.setNodeMarkup(at, undefined, { ...attrs, textAlignment: 'x'.repeat(5000) }));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM(formatBytes(1000)));
    });

    it('lets a same-type markup change that writes no more through at full', () => {
      const o = open([{ type: 'paragraph', content: 'hello world', props: { textAlignment: 'center' } }] as BlockInput[]);
      size(o, F_FULL);
      const at = paragraphAt(o);
      const attrs = o.view.state.doc.nodeAt(at)!.attrs;
      o.view.dispatch(o.view.state.tr.setNodeMarkup(at, undefined, { ...attrs, textAlignment: 'left' }));
      expect(o.view.state.doc.nodeAt(paragraphAt(o))!.attrs['textAlignment']).toBe('left');
      expectNoToast();
    });

    it('refuses a step of another type by what it carries', () => {
      const o = open();
      size(o, { ...F_WARNING, room: 1000 });
      const before = snapshot(o);
      o.view.dispatch(o.view.state.tr.step(new CarryingStep(new AttrStep(paragraphAt(o), 'textAlignment', 'center'), 'x'.repeat(5000))));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM(formatBytes(1000)));
    });
  });

  it('W-105(a): over the ceiling, Backspace is blocked', () => {
    const o = open();
    size(o, F_OVER);
    const before = snapshot(o);
    backspace(o, posOf(o.view.state.doc, 'hello world', 11));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
  });

  it.each([
    ['W-105(b): exactly at the ceiling', F_AT_CEILING],
    ['W-105(c): overwrite room 0 but not over the ceiling', F_FULL_NEAR],
  ])('%s, Backspace deletes', (_title, fixture) => {
    const o = open();
    size(o, fixture);
    backspace(o, posOf(o.view.state.doc, 'hello world', 11));
    expect(o.view.state.doc.textContent).toBe('hello worl');
    expectNoToast();
  });

  describe('W-106: over the ceiling, deleted bytes against SPACE_DELETE_MIN_BYTES', () => {
    const m = SPACE_DELETE_MIN_BYTES;
    const k = Math.ceil(m / 3);

    it('(a) m - 1 ASCII characters are blocked', () => {
      const o = open([{ type: 'paragraph', content: 'x'.repeat(m + 10) }]);
      size(o, F_OVER);
      const before = snapshot(o);
      const start = posOf(o.view.state.doc, 'x');
      o.view.dispatch(o.view.state.tr.delete(start, start + m - 1));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
    });

    it('(b) m ASCII characters are deleted', () => {
      const o = open([{ type: 'paragraph', content: 'x'.repeat(m + 10) }]);
      size(o, F_OVER);
      const start = posOf(o.view.state.doc, 'x');
      o.view.dispatch(o.view.state.tr.delete(start, start + m));
      expect(o.view.state.doc.textContent).toBe('x'.repeat(10));
      expectNoToast();
    });

    it('(c) k three-byte characters (3k >= m) are deleted', () => {
      const o = open([{ type: 'paragraph', content: '中'.repeat(k) }]);
      size(o, F_OVER);
      const start = posOf(o.view.state.doc, '中');
      o.view.dispatch(o.view.state.tr.delete(start, start + k));
      expect(o.view.state.doc.textContent).toBe('');
      expectNoToast();
    });

    it('(d) k - 1 three-byte characters (3(k - 1) < m) are blocked', () => {
      expect(3 * (k - 1)).toBeLessThan(m);
      const o = open([{ type: 'paragraph', content: '中'.repeat(k) }]);
      size(o, F_OVER);
      const before = snapshot(o);
      const start = posOf(o.view.state.doc, '中');
      o.view.dispatch(o.view.state.tr.delete(start, start + k - 1));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
    });
  });

  describe('W-107: over the ceiling, removing a whole block is allowed', () => {
    it('(a) a two-byte paragraph removed as a block', () => {
      const o = open([{ type: 'paragraph', content: 'ab' }, { type: 'paragraph', content: 'hello world' }]);
      size(o, F_OVER);
      const block = containers(o.view.state.doc)[0]!;
      o.view.dispatch(o.view.state.tr.delete(block.pos, block.pos + block.node.nodeSize));
      expect(o.view.state.doc.textContent).toBe('hello world');
      expect(containers(o.view.state.doc)).toHaveLength(1);
      expectNoToast();
    });

    it('(b) an empty paragraph removed as a block', () => {
      const o = open([{ type: 'paragraph', content: '' }, { type: 'paragraph', content: 'hello world' }]);
      size(o, F_OVER);
      const block = containers(o.view.state.doc)[0]!;
      o.view.dispatch(o.view.state.tr.delete(block.pos, block.pos + block.node.nodeSize));
      expect(o.view.state.doc.textContent).toBe('hello world');
      expect(containers(o.view.state.doc)).toHaveLength(1);
      expectNoToast();
    });

    it('(c) an image block deleted from the block menu', () => {
      const o = open([
        { type: 'image', props: { url: 'https://example.com/a.png' } },
        { type: 'paragraph', content: 'hello world' },
      ]);
      size(o, F_OVER);
      const imageId = (o.editor.document[0] as { id: string }).id;
      deleteRow(o.editor as never, imageId);
      expect(o.editor.document.map((block) => (block as { type: string }).type)).toEqual(['paragraph']);
      expectNoToast();
    });

    it('(d) one transaction removing block `ab` and one character of the next block', () => {
      const o = open([{ type: 'paragraph', content: 'ab' }, { type: 'paragraph', content: 'hello world' }]);
      size(o, F_OVER);
      const block = containers(o.view.state.doc)[0]!;
      const last = posOf(o.view.state.doc, 'hello world', 11);
      // Later position first, so the block's range is still exact.
      const tr = o.view.state.tr.delete(last - 1, last).delete(block.pos, block.pos + block.node.nodeSize);
      o.view.dispatch(tr);
      expect(o.view.state.doc.textContent).toBe('hello worl');
      expect(containers(o.view.state.doc)).toHaveLength(1);
      expectNoToast();
    });
  });

  it('W-108: over the ceiling, unbolding is judged as an overwrite and blocked', () => {
    const o = open();
    boldHello(o);
    size(o, F_OVER);
    const before = snapshot(o);
    const from = posOf(o.view.state.doc, 'hello');
    o.view.dispatch(o.view.state.tr.removeMark(from, from + 5, o.view.state.schema.marks['bold']!));
    expectUnchanged(o, before);
    expect(isBold(o.view.state, 'hello')).toBe(true);
    expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
  });

  it('W-109: a blocked composition leaves screen and state equal', async () => {
    const o = open();
    size(o, F_FULL);
    const at = posOf(o.view.state.doc, 'hello', 5);
    select(o, at);
    const before = snapshot(o);
    o.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const walker = document.createTreeWalker(o.view.dom, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeValue === 'hello world') node.nodeValue = 'hello你 world';
    }
    o.view.dispatch(o.view.state.tr.insertText('你', at).setMeta('composition', 1));
    o.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(o.view.dom.textContent).not.toContain('你');
    expect(o.view.dom.textContent).toBe(o.view.state.doc.textContent);
    expect(o.fragment.toString()).toBe(before.y);
    expect(Y.encodeStateAsUpdate(o.doc)).toEqual(before.update);
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });

  it('W-110: one blocked step blocks the whole transaction', () => {
    const o = open();
    size(o, F_FULL);
    const before = snapshot(o);
    const world = posOf(o.view.state.doc, 'world');
    const start = posOf(o.view.state.doc, 'hello');
    // Delete `world` (empty slice), then insert more text than it held at the start.
    o.view.dispatch(o.view.state.tr.delete(world, world + 5).insertText('X'.repeat(20), start));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });

  describe('W-146: over the ceiling, deleted bytes add up over the whole transaction', () => {
    const m = SPACE_DELETE_MIN_BYTES;

    /**
     * Opens two paragraphs of m `x` each.
     * @returns The open body and where each paragraph's text starts.
     */
    function openTwo(): { o: Open; s1: number; s2: number } {
      const o = open([
        { type: 'paragraph', content: 'x'.repeat(m) },
        { type: 'paragraph', content: 'x'.repeat(m) },
      ]);
      const [first, second] = containers(o.view.state.doc);
      // blockContainer > paragraph > text: the text starts two positions in.
      return { o, s1: first!.pos + 2, s2: second!.pos + 2 };
    }

    /**
     * Asserts both paragraphs are still there with their text.
     * @param o - The open body.
     * @param before - The snapshot before the edit.
     */
    function expectBothIntact(o: Open, before: ReturnType<typeof snapshot>): void {
      expectUnchanged(o, before);
      expect(containers(o.view.state.doc)).toHaveLength(2);
      expect(o.view.state.doc.textContent).toBe('x'.repeat(2 * m));
      expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
    }

    it('(a) two steps of ceil(m / 2) bytes each, in two paragraphs, are deleted', () => {
      const { o, s1, s2 } = openTwo();
      size(o, F_OVER);
      const half = Math.ceil(m / 2);
      o.view.dispatch(o.view.state.tr.delete(s2, s2 + half).delete(s1, s1 + half));
      expect(o.view.state.doc.textContent).toBe('x'.repeat(2 * (m - half)));
      expect(containers(o.view.state.doc)).toHaveLength(2);
      expectNoToast();
    });

    it('(b) two steps adding up to m - 1 bytes are blocked', () => {
      const { o, s1, s2 } = openTwo();
      size(o, F_OVER);
      const before = snapshot(o);
      o.view.dispatch(o.view.state.tr.delete(s2, s2 + Math.ceil((m - 1) / 2)).delete(s1, s1 + Math.floor((m - 1) / 2)));
      expectBothIntact(o, before);
    });

    it.each([
      ['(c) k + j = m - 1', (): number => m - 1],
      ['(d) k + j = m', (): number => m],
      ['(e) k + j = 2m', (): number => 2 * m],
    ])('%s: one step joining the two paragraphs is blocked', (_title, total) => {
      const { o, s1, s2 } = openTwo();
      size(o, F_OVER);
      const before = snapshot(o);
      const bytes = total();
      const k = Math.min(m, Math.floor(bytes / 2));
      const j = bytes - k;
      o.view.dispatch(o.view.state.tr.delete(s1 + m - k, s2 + j));
      expectBothIntact(o, before);
    });

    it('(f) Backspace at the start of the second paragraph (a join, 0 bytes) is blocked', () => {
      const { o, s2 } = openTwo();
      size(o, F_OVER);
      select(o, s2);
      const before = snapshot(o);
      o.view.someProp('handleKeyDown', (f) =>
        f(o.view, new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
      expectBothIntact(o, before);
    });
  });

  describe('an edit that rewrites existing content is an overwrite', () => {
    /**
     * Selects `count` characters from the start of the first text.
     * @param o - The open body.
     * @param count - How many.
     * @returns The selection's start.
     */
    function selectStart(o: Open, count: number): number {
      const from = posOf(o.view.state.doc, 'hello');
      select(o, from, from + count);
      return from;
    }

    it('(a) typing over a selected passage while full replaces it', () => {
      const o = open([{ type: 'paragraph', content: 'hello world, a long passage' }]);
      size(o, F_FULL);
      selectStart(o, 20);
      o.view.dispatch(o.view.state.tr.insertText('a'));
      expect(o.view.state.doc.textContent).toBe('apassage');
      expect(o.fragment.toString()).not.toContain('hello');
      expectNoToast();
    });

    it('(b) Backspace at the start of a heading turns it into a paragraph while full', () => {
      const o = open([{ type: 'heading', props: { level: 1 }, content: 'hello title' }]);
      size(o, F_FULL);
      select(o, posOf(o.view.state.doc, 'hello'));
      o.view.someProp('handleKeyDown', (f) =>
        f(o.view, new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
      expect((o.editor.document[0] as { type: string }).type).toBe('paragraph');
      expect(o.view.state.doc.textContent).toBe('hello title');
      expectNoToast();
    });

    it('(c) with no overwrite room left, typing over a selection is blocked as an overwrite', () => {
      const o = open([{ type: 'paragraph', content: 'hello world, a long passage' }]);
      size(o, F_FULL_NEAR);
      selectStart(o, 20);
      const before = snapshot(o);
      o.view.dispatch(o.view.state.tr.insertText('a'));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_OVERWRITE_BLOCKED);
    });

    it('(d) over the ceiling, a heading turned into a paragraph is blocked as an overwrite', () => {
      const o = open([{ type: 'heading', props: { level: 1 }, content: 'hello title' }]);
      size(o, F_OVER);
      select(o, posOf(o.view.state.doc, 'hello'));
      const before = snapshot(o);
      o.view.someProp('handleKeyDown', (f) =>
        f(o.view, new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_OVERWRITE_BLOCKED);
    });

    it('(f) moving a paragraph down while full goes through', () => {
      const o = open([
        { type: 'paragraph', content: 'one' },
        { type: 'paragraph', content: 'two' },
        { type: 'paragraph', content: 'three' },
      ]);
      size(o, F_FULL);
      select(o, posOf(o.view.state.doc, 'one'));
      o.view.someProp('handleKeyDown', (f) =>
        f(o.view, new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
      expect(o.view.state.doc.textContent).toBe('twoonethree');
      expectNoToast();
    });

    it('(g) replacing a block with a shorter one while full goes through', () => {
      const o = open([{ type: 'paragraph', content: 'a long paragraph that gets shorter' }]);
      size(o, F_FULL);
      const id = (o.editor.document[0] as { id: string }).id;
      o.editor.replaceBlocks([id], [{ type: 'paragraph', content: 'short' }] as never);
      expect(o.view.state.doc.textContent).toBe('short');
      expectNoToast();
    });

    it('(h) while full, pasting text over a paragraph break is blocked as an add', () => {
      const o = open([{ type: 'paragraph', content: 'ab' }, { type: 'paragraph', content: 'cd' }]);
      size(o, F_FULL);
      select(o, posOf(o.view.state.doc, 'ab', 2), posOf(o.view.state.doc, 'cd'));
      const before = snapshot(o);
      pastePlain(o, 'x'.repeat(400));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_ADD_BLOCKED);
    });

    it('(i) in warning, text pasted over a paragraph break counts against the room', () => {
      const o = open([{ type: 'paragraph', content: 'ab' }, { type: 'paragraph', content: 'cd' }]);
      size(o, { ...F_WARNING, room: 100 });
      select(o, posOf(o.view.state.doc, 'ab', 2), posOf(o.view.state.doc, 'cd'));
      const before = snapshot(o);
      pastePlain(o, 'x'.repeat(400));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM(formatBytes(100)));
    });

    it('(j) a link with a long address costs its attributes against the room', () => {
      const o = open();
      size(o, { ...F_WARNING, room: 200 });
      const from = posOf(o.view.state.doc, 'hello');
      const before = snapshot(o);
      const link = o.view.state.schema.marks['link']!.create({ href: `https://example.com/${'p'.repeat(400)}` });
      o.view.dispatch(o.view.state.tr.addMark(from, from + 5, link));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_NO_ROOM(formatBytes(200)));
    });

    it('(e) while full, replacing a selection with more than it holds is blocked as an add', () => {
      const o = open();
      size(o, F_FULL);
      selectStart(o, 2);
      const before = snapshot(o);
      pastePlain(o, 'a much longer replacement');
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_ADD_BLOCKED);
    });
  });

  describe('W-147: its own sync key admits a transaction, isChangeOrigin or not', () => {
    it('a local insert carrying the y-prosemirror key meta without isChangeOrigin goes through', () => {
      const o = open();
      size(o, F_FULL);
      o.view.dispatch(o.view.state.tr.insertText('Z', posOf(o.view.state.doc, 'hello', 5)).setMeta(yProsemirrorSyncKey, { addToHistory: false }));
      expect(o.view.state.doc.textContent).toBe('helloZ world');
      expectNoToast();
    });

    it('the same insert with no sync key meta is blocked', () => {
      const o = open();
      size(o, F_FULL);
      const before = snapshot(o);
      o.view.dispatch(o.view.state.tr.insertText('Z', posOf(o.view.state.doc, 'hello', 5)));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_ADD_BLOCKED);
    });
  });
});
