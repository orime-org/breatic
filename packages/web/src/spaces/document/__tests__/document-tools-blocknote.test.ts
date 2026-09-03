// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A19: the bubble bar's five inline tools, on BlockNote.
 *
 * Each tool answers three questions — is it on, can it run here, run it — and
 * the flat model answers them through three different doors. Being ON comes
 * from `getActiveStyles()`, because a style is a property of the selection
 * rather than a mark the caller names. Running and dry-running go through
 * `exec` / `canExec`, which take a bare ProseMirror command.
 *
 * The pressed state is worth its own cases: it drives `aria-pressed` and the
 * button's variant, and nothing pinned it before this file.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  MARK_TOOLS,
  INLINE_TOOLS,
} from '@web/spaces/document/document-tools';

const ALL_TOOLS = [...MARK_TOOLS, ...INLINE_TOOLS];

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one sentence, with a range of it selected.
 * @param block - The block to write.
 * @returns The editor.
 */
function open(
  block: Record<string, unknown> = { type: 'paragraph', content: 'hello world' },
): ReturnType<typeof buildDocumentEditor> {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [block] as never);
  return editor;
}

/** Selects the given range in the open editor. */
function select(
  editor: ReturnType<typeof buildDocumentEditor>,
  from: number,
  to: number,
): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
}

describe('every inline tool', () => {
  it('covers the five the bar draws, each named after a style', () => {
    // The style schema names and the tool ids are the same five words, which
    // is what lets the pressed state read straight off `getActiveStyles()`.
    expect(ALL_TOOLS.map((tool) => tool.id).sort()).toEqual([
      'bold',
      'code',
      'italic',
      'strike',
      'underline',
    ]);
  });

  it('reads as off over plain text, and on once run', () => {
    const editor = open();
    select(editor, 3, 8);

    for (const tool of ALL_TOOLS) {
      expect(tool.isActive(editor)).toBe(false);
    }

    for (const tool of ALL_TOOLS) {
      select(editor, 3, 8);
      tool.run(editor);
      expect(tool.isActive(editor)).toBe(true);
    }
  });

  it('turns back off when run a second time', () => {
    const editor = open();

    for (const tool of ALL_TOOLS) {
      select(editor, 3, 8);
      tool.run(editor);
      expect(tool.isActive(editor)).toBe(true);
      select(editor, 3, 8);
      tool.run(editor);
      expect(tool.isActive(editor)).toBe(false);
    }
  });

  it('can run over a range of text', () => {
    const editor = open();
    select(editor, 3, 8);

    for (const tool of ALL_TOOLS) {
      expect(tool.canRun(editor)).toBe(true);
    }
  });

  it('cannot run where there is no text to mark', () => {
    // A code block holds text the marks do not apply to; the bar greys the
    // buttons rather than letting a press do nothing.
    const editor = open({ type: 'codeBlock', content: 'const a = 1' });
    select(editor, 3, 8);

    for (const tool of ALL_TOOLS) {
      expect(tool.canRun(editor)).toBe(false);
    }
  });
});
