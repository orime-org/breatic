// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A19 的订阅那半: reading a derived value off a living editor.
 *
 * The bar's controls are all the same shape — look at the editor, derive
 * something small, redraw when it moves. What they derive is rarely a scalar:
 * which rows are ticked and which are out of reach are both sets, rebuilt on
 * every read. A subscription that handed those straight to React would report
 * a change every time it was asked, because a fresh Set is never the same
 * object as the last one.
 *
 * So the value is compared and the previous one kept where they match, which
 * is what the tiptap hook this replaces did with `fast-equals`. The comparison
 * is the caller's to choose: a boolean wants identity, a set wants membership.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one sentence.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  return openWithDoc().editor;
}

/**
 * Opens an editor holding one sentence, keeping the shared document.
 * @returns The editor and its document.
 */
function openWithDoc(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'hello world' },
  ] as never);
  return { editor, doc };
}

/**
 * The first text node in the shared document.
 * @param node - Where to look.
 * @returns That node.
 */
function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (let i = 0; i < node.length; i += 1) {
    const child: unknown = node.get(i);
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement) {
      return firstText(child);
    }
  }
  throw new Error('no text node in the body');
}

describe('reading a value off the editor', () => {
  it('answers with what the reader derives', () => {
    const editor = open();
    const rendered = renderHook(() =>
      useEditorSnapshot(editor, (e) => e.prosemirrorState.doc.textContent),
    );

    expect(rendered.result.current).toBe('hello world');
  });

  it('follows a change to the document', () => {
    const editor = open();
    const rendered = renderHook(() =>
      useEditorSnapshot(editor, (e) => e.prosemirrorState.doc.textContent),
    );

    act(() => {
      editor.replaceBlocks(editor.document, [
        { type: 'paragraph', content: 'written since' },
      ] as never);
    });

    expect(rendered.result.current).toBe('written since');
  });

  it('follows a co-editor’s change, which moves no selection here', async () => {
    // The case that tells the two subscriptions apart. A local edit moves the
    // selection too, so it would be caught either way; a co-editor's does not,
    // and the bar depends on seeing it — a row can go out of reach because
    // someone else took the quote away.
    const { editor, doc } = openWithDoc();
    const rendered = renderHook(() =>
      useEditorSnapshot(editor, (e) => e.prosemirrorState.doc.textContent),
    );
    expect(rendered.result.current).toBe('hello world');

    await act(async () => {
      const text = firstText(documentBodyFragment(doc));
      doc.transact(() => {
        text.insert(text.length, ' and more');
      }, 'a-collaborator');
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
    });

    expect(rendered.result.current).toBe('hello world and more');
  });

  it('follows a change to the selection alone', () => {
    const editor = open();
    const rendered = renderHook(() =>
      useEditorSnapshot(editor, (e) => e.prosemirrorState.selection.from),
    );
    const first = rendered.result.current;

    act(() => {
      const view = editor.prosemirrorView!;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 5, 8)),
      );
    });

    expect(rendered.result.current).not.toBe(first);
    expect(rendered.result.current).toBe(5);
  });

  it('keeps the previous value when the comparison says nothing moved', () => {
    // The case a set-valued reader depends on: a fresh object every read must
    // not read as a change, or the control redraws on every keystroke.
    const editor = open();
    const read = vi.fn((): Set<string> => new Set(['a', 'b']));
    const rendered = renderHook(() =>
      useEditorSnapshot(editor, read, sameMembers),
    );
    const first = rendered.result.current;

    act(() => {
      editor.replaceBlocks(editor.document, [
        { type: 'paragraph', content: 'written since' },
      ] as never);
    });

    expect(rendered.result.current).toBe(first);
  });

  it('hands back the new value once the comparison says it moved', () => {
    const editor = open();
    let members = ['a'];
    const rendered = renderHook(() =>
      useEditorSnapshot(editor, () => new Set(members), sameMembers),
    );
    const first = rendered.result.current;

    members = ['a', 'b'];
    act(() => {
      editor.replaceBlocks(editor.document, [
        { type: 'paragraph', content: 'written since' },
      ] as never);
    });

    expect(rendered.result.current).not.toBe(first);
    expect([...rendered.result.current]).toEqual(['a', 'b']);
  });
});

/**
 * Whether two sets hold the same members.
 * @param a - One set.
 * @param b - The other.
 * @returns True when they match.
 */
function sameMembers(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((member) => b.has(member));
}
