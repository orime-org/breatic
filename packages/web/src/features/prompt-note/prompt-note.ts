// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A note at the top of a prompt (inner#977): how to operate the panel, put
 * there by a proposal or a template, shown to the reader and never sent to
 * the model.
 *
 * A block atom with its words in an attribute. Being an atom, nothing typed
 * or pasted as plain text becomes one, and every reader of the prompt that
 * walks text skips it. With no `parseHTML` rule, markup that looks like one
 * stays words too: only we put notes in, so leaving them out of what the
 * model gets can never drop something the reader wrote.
 */

import { Document } from '@tiptap/extension-document';
import { mergeAttributes, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';

import { coveredNodeDecorations } from '@web/features/reference-mention/reference-mention-range-decoration';

/** The node name a note is stored under, in the editor and in Yjs. */
export const PROMPT_NOTE_NODE = 'promptNote';

/** The attribute holding a note's words. */
export const PROMPT_NOTE_LABEL_ATTR = 'label';

/** Class added to a note a selection covers, picked or swept over (see index.css). */
export const NOTE_SELECTED_CLASS = 'prompt-note--selected';

/**
 * A prompt's document: notes first, then at least one line to write in, so
 * the box is never left holding notes alone with nowhere to put the caret.
 */
export const PromptDocument = Document.extend({
  content: `${PROMPT_NOTE_NODE}* paragraph+`,
});

/** The note node. */
export const PromptNote = Node.create({
  name: PROMPT_NOTE_NODE,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      [PROMPT_NOTE_LABEL_ATTR]: { default: '' },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-prompt-note': '', class: 'prompt-note', contenteditable: 'false' }),
      String(node.attrs[PROMPT_NOTE_LABEL_ATTR] ?? ''),
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) =>
            DecorationSet.create(
              state.doc,
              coveredNodeDecorations(state.doc, state.selection, PROMPT_NOTE_NODE, NOTE_SELECTED_CLASS),
            ),
        },
      }),
    ];
  },
});
