// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 web test spec section 10: the shared ProseMirror size filter on
 * the two TipTap editors bound through `buildCollabExtensions` (the canvas text
 * node body and the prompt), both on the y-tiptap sync key. The BlockNote
 * document body (y-prosemirror key) is in
 * `spaces/document/__tests__/document-body-size-filter.test.ts`.
 *
 * Neither TipTap schema has a mark, so the bold cases (W-101, W-102(a), W-104,
 * W-108) are covered only on the document body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { Editor, type Extensions } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey as yProsemirrorSyncKey } from 'y-prosemirror';
import * as Y from 'yjs';

vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { formatBytes, spaceContentDocName, SPACE_DELETE_MIN_BYTES } from '@breatic/shared';
import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { estimateSliceBytes } from '@web/data/yjs/space-write';
import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { ySyncPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import { buildTextNodeExtensions } from '@web/spaces/canvas/nodes/TextNodeEditor';
import {
  push,
  resetProviderSpies,
  type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN,
  F_AT_CEILING,
  F_FULL,
  F_FULL_NEAR,
  F_OVER,
  F_WARNING,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = spaceContentDocName(PID, SID, 'canvas');

/** One open TipTap editor over the registered canvas document. */
interface Open {
  readonly editor: Editor;
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly fragmentName: string;
  readonly provider: ProviderSpy;
}

/**
 * The two TipTap editors, each built the way production builds it.
 *
 * ASSUMED interface: the spec does not fix how the document name reaches the
 * size filter. These builders pass it as `docName` next to the fragment; the
 * fragment also lives in `getDoc(NAME)`, so an implementation that resolves
 * the name from the fragment's document works as well. Change only here.
 */
const EDITORS: ReadonlyArray<{ kind: string; build: (fragment: Y.XmlFragment) => Extensions }> = [
  {
    kind: 'canvas text node',
    build: (fragment) =>
      buildTextNodeExtensions({ fragment, docName: NAME, placeholder: '' } as Parameters<typeof buildTextNodeExtensions>[0]),
  },
  {
    // The prompt editor composes its list inline in `PromptEditor`; its
    // collaboration half (where the filter lives) is this call.
    kind: 'prompt',
    build: (fragment) => [
      Document,
      Paragraph,
      Text,
      ...buildCollabExtensions({ fragment, docName: NAME } as Parameters<typeof buildCollabExtensions>[0]),
    ],
  },
];

const opened: Editor[] = [];

/**
 * Opens an editor holding one paragraph `text`, written before any size push
 * (state `unknown`, everything allowed), with the canvas provider acquired.
 * @param build - The editor's extension builder.
 * @param text - Initial paragraph text.
 * @returns The editor and its document.
 */
function open(build: (fragment: Y.XmlFragment) => Extensions, text = 'hello world'): Open {
  const doc = getDoc(NAME);
  const provider = acquireDocProvider(NAME, doc) as unknown as ProviderSpy;
  const fragmentName = `size-filter-${opened.length}`;
  const fragment = doc.getXmlFragment(fragmentName);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: build(fragment) });
  opened.push(editor);
  editor.commands.setContent(`<p>${text}</p>`);
  return { editor, doc, fragment, fragmentName, provider };
}

/**
 * Selects a range in the editor.
 * @param editor - The editor.
 * @param from - Anchor.
 * @param to - Head.
 */
function select(editor: Editor, from: number, to = from): void {
  const { view } = editor;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/**
 * Deletes the character before the caret the way a browser Backspace reaches
 * ProseMirror inside a text run: the keymap declines a collapsed caret in
 * text and the DOM change is read back as one empty-slice ReplaceStep.
 * @param editor - The editor.
 * @param at - The caret position.
 */
function backspace(editor: Editor, at: number): void {
  editor.view.dispatch(editor.state.tr.delete(at - 1, at));
}

/**
 * Everything a blocked edit must leave unchanged.
 * @param o - The open editor.
 * @returns PM text, Y fragment and the whole Y.Doc encoding.
 */
function snapshot(o: Open): { text: string; y: string; update: Uint8Array } {
  return { text: o.editor.state.doc.textContent, y: o.fragment.toString(), update: Y.encodeStateAsUpdate(o.doc) };
}

/**
 * Asserts nothing changed since `before`.
 * @param o - The open editor.
 * @param before - The earlier snapshot.
 */
function expectUnchanged(o: Open, before: ReturnType<typeof snapshot>): void {
  const after = snapshot(o);
  expect(after.text).toBe(before.text);
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
 * Sends a size push for the canvas document.
 * @param o - The open editor.
 * @param fixture - The push.
 */
function size(o: Open, fixture: DocSizePush): void {
  push(o.provider, fixture);
}

beforeEach(() => {
  changeLocale('en');
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  opened.splice(0).forEach((editor) => { editor.destroy(); });
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
  document.body.innerHTML = '';
});

describe.each(EDITORS)('size filter on the $kind editor', ({ build }) => {
  it('W-98: lets a remote transaction through while full', () => {
    const o = open(build);
    size(o, F_FULL);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(o.doc));
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('remote')]);
    const remoteFragment = remote.getXmlFragment(o.fragmentName);
    remoteFragment.insert(remoteFragment.length, [paragraph]);
    Y.applyUpdate(o.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(o.doc)));

    expect(o.editor.state.doc.textContent).toBe('hello worldremote');
    expectNoToast();
  });

  it('W-100: blocks typing while full', () => {
    const o = open(build);
    size(o, F_FULL);
    select(o.editor, 6);
    const before = snapshot(o);
    o.editor.view.dispatch(o.editor.state.tr.insertText('a'));
    expectUnchanged(o, before);
    expect(o.editor.state.doc.textContent).toBe('hello world');
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });

  it('W-102(b): lets Backspace delete while full', () => {
    const o = open(build);
    size(o, F_FULL);
    const yBefore = o.fragment.toString();
    backspace(o.editor, 12);
    expect(o.editor.state.doc.textContent).toBe('hello worl');
    expect(o.fragment.toString()).not.toBe(yBefore);
    expect(o.fragment.toString()).toContain('hello worl');
    expect(o.fragment.toString()).not.toContain('hello world');
    expectNoToast();
  });

  it('W-109: a blocked composition leaves screen and state equal', async () => {
    const o = open(build);
    size(o, F_FULL);
    select(o.editor, 6);
    const before = snapshot(o);
    const { view } = o.editor;
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeValue === 'hello world') node.nodeValue = 'hello你 world';
    }
    view.dispatch(view.state.tr.insertText('你', 6).setMeta('composition', 1));
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(view.dom.textContent).not.toContain('你');
    expect(view.dom.textContent).toBe(view.state.doc.textContent);
    expect(o.fragment.toString()).toBe(before.y);
    expect(Y.encodeStateAsUpdate(o.doc)).toEqual(before.update);
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });

  it('W-147: lets a local transaction carrying its own sync key meta through, without isChangeOrigin', () => {
    const o = open(build);
    size(o, F_FULL);
    const { view } = o.editor;
    view.dispatch(view.state.tr.insertText('Z', 6).setMeta(ySyncPluginKey, { addToHistory: false }));
    expect(view.state.doc.textContent).toBe('helloZ world');
    expectNoToast();
  });

  it('W-147: blocks the same transaction without any sync key meta', () => {
    const o = open(build);
    size(o, F_FULL);
    const before = snapshot(o);
    const { view } = o.editor;
    view.dispatch(view.state.tr.insertText('Z', 6));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });
});

describe('size filter on the canvas text node editor', () => {
  const build = EDITORS[0]!.build;

  it('W-99: does not treat the y-prosemirror sync key as its own', () => {
    const o = open(build);
    size(o, F_FULL);
    const before = snapshot(o);
    const { view } = o.editor;
    view.dispatch(view.state.tr.insertText('Z', 6).setMeta(yProsemirrorSyncKey, { isChangeOrigin: true }));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });

  it('W-103(a): blocks a paste over the room by UTF-8 bytes', () => {
    const o = open(build);
    size(o, F_WARNING);
    select(o.editor, 6);
    const before = snapshot(o);
    o.editor.view.pasteText('a'.repeat(786433));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_NO_ROOM('768 KiB'));
  });

  it('W-103(b): counts bytes, not characters', () => {
    const o = open(build);
    size(o, F_WARNING);
    select(o.editor, 6);
    const before = snapshot(o);
    // 262145 characters, 786435 UTF-8 bytes: under the room by characters, over by bytes.
    o.editor.view.pasteText('中'.repeat(262145));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_NO_ROOM('768 KiB'));
  });

  it('W-103(c): lets a paste that fits through', () => {
    const o = open(build);
    size(o, F_WARNING);
    select(o.editor, 6);
    o.editor.view.pasteText('a'.repeat(1000));
    expect(o.editor.state.doc.textContent).toBe(`hello${'a'.repeat(1000)} world`);
    expect(o.fragment.toString()).toContain('a'.repeat(1000));
    expectNoToast();
  });

  it('W-103(d): the room equal to the slice estimate admits it, one byte less blocks it', () => {
    const o = open(build);
    const slice = new Slice(Fragment.from(o.editor.schema.text('a'.repeat(1000))), 0, 0);
    const estimate = estimateSliceBytes(slice);
    expect(estimate).toBeGreaterThanOrEqual(1000);

    size(o, { ...F_WARNING, room: estimate - 1 });
    select(o.editor, 6);
    const before = snapshot(o);
    o.editor.view.dispatch(o.editor.state.tr.replaceSelection(slice));
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_NO_ROOM(formatBytes(estimate - 1)));

    vi.mocked(toast.warning).mockClear();
    size(o, { ...F_WARNING, room: estimate });
    select(o.editor, 6);
    o.editor.view.dispatch(o.editor.state.tr.replaceSelection(slice));
    expect(o.editor.state.doc.textContent).toBe(`hello${'a'.repeat(1000)} world`);
    expectNoToast();
  });

  it('W-105(a): over the ceiling, Backspace is blocked', () => {
    const o = open(build);
    size(o, F_OVER);
    const before = snapshot(o);
    backspace(o.editor, 12);
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
  });

  it.each([
    ['W-105(b): exactly at the ceiling', F_AT_CEILING],
    ['W-105(c): overwrite room 0 but not over the ceiling', F_FULL_NEAR],
  ])('%s, Backspace deletes', (_title, fixture) => {
    const o = open(build);
    size(o, fixture);
    backspace(o.editor, 12);
    expect(o.editor.state.doc.textContent).toBe('hello worl');
    expectNoToast();
  });

  describe('W-106: over the ceiling, deleted bytes against SPACE_DELETE_MIN_BYTES', () => {
    const m = SPACE_DELETE_MIN_BYTES;
    const k = Math.ceil(m / 3);

    it('(a) m - 1 ASCII characters are blocked', () => {
      const o = open(build, 'x'.repeat(m + 10));
      size(o, F_OVER);
      const before = snapshot(o);
      o.editor.view.dispatch(o.editor.state.tr.delete(1, 1 + m - 1));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
    });

    it('(b) m ASCII characters are deleted', () => {
      const o = open(build, 'x'.repeat(m + 10));
      size(o, F_OVER);
      o.editor.view.dispatch(o.editor.state.tr.delete(1, 1 + m));
      expect(o.editor.state.doc.textContent).toBe('x'.repeat(10));
      expectNoToast();
    });

    it('(c) k three-byte characters (3k >= m) are deleted', () => {
      const o = open(build, '中'.repeat(k));
      size(o, F_OVER);
      o.editor.view.dispatch(o.editor.state.tr.delete(1, 1 + k));
      expect(o.editor.state.doc.textContent).toBe('');
      expectNoToast();
    });

    it('(d) k - 1 three-byte characters (3(k - 1) < m) are blocked', () => {
      expect(3 * (k - 1)).toBeLessThan(m);
      const o = open(build, '中'.repeat(k));
      size(o, F_OVER);
      const before = snapshot(o);
      o.editor.view.dispatch(o.editor.state.tr.delete(1, 1 + k - 1));
      expectUnchanged(o, before);
      expectOneWarning(COPY_EN.T_OVER_CEILING_DELETE);
    });
  });

  it('W-110: one blocked step blocks the whole transaction', () => {
    const o = open(build);
    size(o, F_FULL);
    const before = snapshot(o);
    // Delete `world` (empty slice), then insert X at the start.
    const tr = o.editor.state.tr.delete(7, 12).insertText('X', 1);
    o.editor.view.dispatch(tr);
    expectUnchanged(o, before);
    expectOneWarning(COPY_EN.T_ADD_BLOCKED);
  });
});
