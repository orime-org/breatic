// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A7: typing `> ` opens a quote where the caret is.
 *
 * A quote is a prop any block carries rather than a block type, so what this
 * rule has to leave alone is everything else about the block: its type and
 * every other prop it was carrying. A heading typed `> ` into stays that
 * heading, at that level, numbered if it was numbered.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** One block, as this file reads it back. */
interface ReadBlock {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * Opens an editor on one block and types the shorthand into it.
 * @param block - The block to start from.
 * @returns Every block afterwards.
 */
function typeShorthandInto(
  block: Readonly<Record<string, unknown>>,
): ReadBlock[] {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [block] as never);

  const opened = editor.document as unknown as { id: string }[];
  editor.setTextCursorPosition(opened[0]!.id, 'start');

  const view = editor.prosemirrorView!;
  // The marker goes in as text at the caret; the space that closes the
  // pattern goes through `handleTextInput`, which is the prop the input-rules
  // plugin watches. A `tr.insertText` for the space reaches no rule at all.
  view.dispatch(view.state.tr.insertText('>', view.state.selection.from));
  const at = view.state.selection.from;
  view.someProp('handleTextInput', (handler) =>
    handler(view, at, at, ' ', () => view.state.tr),
  );

  return editor.document as unknown as ReadBlock[];
}

describe('typing `> ` at the start of a block', () => {
  it('quotes a paragraph and leaves it a paragraph', () => {
    const blocks = typeShorthandInto({ type: 'paragraph', content: '' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('paragraph');
    expect(blocks[0]!.props['quoted']).toBe(true);
  });

  it('keeps a heading at its own level', () => {
    const blocks = typeShorthandInto({
      type: 'heading',
      props: { level: 2 },
      content: '',
    });
    expect(blocks[0]!.type).toBe('heading');
    expect(blocks[0]!.props['level']).toBe(2);
    expect(blocks[0]!.props['quoted']).toBe(true);
  });

  it('keeps a numbered heading numbered', () => {
    const blocks = typeShorthandInto({
      type: 'heading',
      props: { level: 1, numbered: true },
      content: '',
    });
    expect(blocks[0]!.type).toBe('heading');
    expect(blocks[0]!.props['numbered']).toBe(true);
    expect(blocks[0]!.props['quoted']).toBe(true);
  });

  it('keeps a checked to-do item checked', () => {
    const blocks = typeShorthandInto({
      type: 'checkListItem',
      props: { checked: true },
      content: '',
    });
    expect(blocks[0]!.type).toBe('checkListItem');
    expect(blocks[0]!.props['checked']).toBe(true);
    expect(blocks[0]!.props['quoted']).toBe(true);
  });

  it('leaves a block that is already quoted alone', () => {
    const blocks = typeShorthandInto({
      type: 'bulletListItem',
      props: { quoted: true },
      content: '',
    });
    expect(blocks[0]!.type).toBe('bulletListItem');
    expect(blocks[0]!.props['quoted']).toBe(true);
  });
});
