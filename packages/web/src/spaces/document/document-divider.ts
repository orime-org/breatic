// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The divider's name, and the `---` rule that places one.
 *
 * The rule, like the handle menu's Divider entry (`insertRowForMenu` with the
 * divider as its lead), leaves the caret on the line right under the new
 * divider, so whatever the reader types next is a line of its own (user
 * 2026-09-30).
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

import { QUOTED } from '@web/spaces/document/document-list-block';

/** The divider's block type, which is also its node name. */
export const DIVIDER = 'divider';

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
