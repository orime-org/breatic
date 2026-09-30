// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two ways a reader puts a divider into the body.
 *
 * Both leave the caret on the line right under the new divider, so whatever
 * the reader types next is a line of its own (user 2026-09-30).
 *
 * `---` at the head of a line puts the divider ABOVE that line and leaves the
 * line untouched — its type, its words after the caret, its children and its
 * quote. That is the shape Lexical's markdown rule takes when nothing follows
 * the line (`lexical-playground/.../MarkdownTransformers/index.ts`,
 * `parentNode.insertBefore(line)`), taken here for every case so the words
 * after the caret never move into another block.
 */

import { blockToNode, createExtension } from '@blocknote/core';
import { InputRule, inputRules } from '@tiptap/pm/inputrules';
import { TextSelection } from '@tiptap/pm/state';

import {
  type HandleEditor,
  type PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import { QUOTED } from '@web/spaces/document/document-list-block';

/** The block type this file places. */
const DIVIDER = 'divider';

/**
 * Three dashes with nothing before them in the line. ProseMirror matches the
 * text before the caret with the character being typed appended, so this sees
 * the third dash before it lands.
 */
const DASHES = /^---$/;

/**
 * The `---` rule.
 *
 * Written as a ProseMirror input rule rather than an entry in a BlockNote
 * extension's `inputRules`: that wrapper replaces the block wholesale and then
 * always puts the caret at the start of the new block
 * (`ExtensionManager/index.ts:565-583`), which is a node selection on a
 * divider — the dead end the probe measured (reading 1).
 *
 * The match is on the text BEFORE the caret. What follows the caret on that
 * line is the reader's line and stays it.
 */
const dividerRule = new InputRule(DASHES, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  const line = $start.parent;
  // A code block is where dashes are code.
  if (line.type.spec.code === true) return null;
  // `start` has to be the line's own first position: the regex already says
  // nothing precedes the dashes in the matched text, and this rules out a
  // match that began inside an inline node's text.
  if ($start.parentOffset !== 0) return null;

  // blockContent sits in a blockContainer; the divider goes in a container of
  // its own right before this one.
  const containerDepth = $start.depth - 1;
  const container = $start.node(containerDepth);
  if (container.type.name !== 'blockContainer') return null;
  const quoted = line.attrs[QUOTED] === true;

  const tr = state.tr.delete(start, end);
  const before = $start.before(containerDepth);
  tr.insert(
    before,
    blockToNode({ type: DIVIDER, props: { [QUOTED]: quoted } } as never, state.schema),
  );
  // The line's content now starts where the dashes began, shifted by the
  // container just inserted in front of it.
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(start)));
  return tr;
});

/**
 * The extension that carries the `---` rule.
 * @returns The extension, for the assembly to register.
 */
export const documentDividerInputExtension = createExtension(() => ({
  key: 'document-divider-input',
  prosemirrorPlugins: [inputRules({ rules: [dividerRule] })],
}) as never);

/**
 * Puts a divider under the pressed row, an empty line under the divider, and
 * the caret in that line.
 *
 * Placement and quoting follow every other insert-below row
 * (`insertRowForMenu`): before the pressed row's first child when it has
 * children, after it otherwise, and inside the quote the pressed row is in.
 * @param editor - The editor to write to.
 * @param row - The block the menu was opened on.
 * @throws {Error} When the pressed block is no longer in the document.
 */
export function insertDividerForMenu(
  editor: HandleEditor,
  row: PressedBlock,
): void {
  const quoted = row.props?.[QUOTED] === true;
  const firstChild = row.children?.[0];
  const made = editor.insertBlocks(
    [
      { type: DIVIDER, props: { [QUOTED]: quoted } },
      { type: 'paragraph', props: { [QUOTED]: quoted } },
    ] as never,
    firstChild?.id ?? row.id,
    firstChild === undefined ? 'after' : 'before',
  ) as { id: string }[];
  const line = made[1];
  if (line === undefined) {
    throw new Error(`could not place a divider under the block ${row.id}`);
  }
  editor.setTextCursorPosition(line.id, 'start');
}
