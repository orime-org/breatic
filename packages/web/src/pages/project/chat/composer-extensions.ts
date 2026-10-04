// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Extension, type AnyExtension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';
import { splitBlock } from '@tiptap/pm/commands';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import { CHAT_MESSAGE_MAX_CHARS } from '@breatic/shared';

import { MACHINE_EDIT_META } from '@web/features/reference-mention/reference-mention-local-input';
import { ChatReference } from '@web/pages/project/chat/chat-reference';
import { draftLength, followAttachments } from '@web/pages/project/chat/composer-draft';
import type { TrayItem } from '@web/stores/chat-attachments';

/** What the chat box reads live and reports. */
export interface ComposerWiring {
  /** Reads the placeholder sentence. */
  placeholder: () => string;
  /** Reads what is attached now. */
  attachments: () => ReadonlyArray<TrayItem>;
  /** The name an attachment shows, in the language now on screen. */
  labelOf: (item: TrayItem) => string;
  /** The `@` list. */
  suggestion: Omit<SuggestionOptions<TrayItem>, 'editor'>;
  /** Enter without Shift, outside an IME composition, with no `@` list taking it. */
  onEnter: () => void;
  /** The limit turned an edit away. */
  onRefusedAtLimit: () => void;
}

/**
 * Meta on a transaction that changes nothing in the box but says what is
 * attached, or the language, has changed; the box's rules bring the blocks in
 * line with it.
 */
export const ATTACHMENTS_CHANGED_META = 'composerAttachmentsChanged';

/** True while {@link settledLength} applies a transaction aside; the limit lets it through. */
let measuring = false;

/**
 * The length the reader will see once the box has applied an edit and
 * everything its rules add after it: ProseMirror refuses or keeps a
 * transaction before those follow-ups exist, so the edit is applied aside to
 * measure them.
 * @param state - The box's state before the edit.
 * @param tr - The edit.
 * @param attached - What is attached; only their ids are read.
 * @returns The settled length.
 */
export function settledLength(
  state: EditorState,
  tr: Transaction,
  attached: ReadonlyArray<{ readonly id: string }>,
): number {
  measuring = true;
  try {
    return draftLength(state.applyTransaction(tr).state.doc, attached);
  } finally {
    measuring = false;
  }
}

/**
 * The box's own rules: the `@` list, Enter sends, the limit holds, and every
 * block follows what is attached -- whichever way it got into the box. The plugins run in the
 * order listed, so the `@` list sees a key before Enter is settled; the
 * priority puts both ahead of TipTap's default keymap (100), which would
 * otherwise break the line.
 * @param wiring - The box's live inputs.
 * @returns The extension.
 */
function composerRules(wiring: ComposerWiring): AnyExtension {
  return Extension.create({
    name: 'composerRules',
    priority: 150,
    addProseMirrorPlugins() {
      return [
        Suggestion<TrayItem>({ editor: this.editor, ...wiring.suggestion }),
        new Plugin({
          // Typing, a pick, a paste, a drop, an undo or a draft written in can
          // each bring a block in, and the tray or the language can change
          // under the blocks already there: every block is checked here,
          // after any of them.
          appendTransaction: (trs, _old, state): Transaction | null => {
            if (!trs.some((tr) => tr.docChanged || tr.getMeta(ATTACHMENTS_CHANGED_META))) return null;
            const tr = followAttachments(state, wiring.attachments(), wiring.labelOf);
            return tr ? tr.setMeta('addToHistory', false) : null;
          },
          props: {
            handleKeyDown: (view, event): boolean => {
              if (event.key !== 'Enter' || event.isComposing) return false;
              event.preventDefault();
              if (event.shiftKey) splitBlock(view.state, view.dispatch);
              else wiring.onEnter();
              return true;
            },
          },
          // Refuses an edit that would take the words past the limit, as the
          // reader counts them once the box has settled it (the spaces kept
          // around a block included). Writes the reader did not make are let
          // through; an edit that shortens is always fine.
          filterTransaction: (tr: Transaction, state): boolean => {
            if (measuring || !tr.docChanged || tr.getMeta(MACHINE_EDIT_META)) return true;
            const attached = wiring.attachments();
            const after = settledLength(state, tr, attached);
            if (after <= CHAT_MESSAGE_MAX_CHARS || after <= draftLength(state.doc, attached)) return true;
            wiring.onRefusedAtLimit();
            return false;
          },
        }),
      ];
    },
  });
}

/**
 * What the chat box is built from: plain paragraphs, undo, the placeholder,
 * reference blocks and the box's own rules. No formatting: what is sent is
 * plain words.
 * @param wiring - The box's live inputs.
 * @returns The extensions.
 */
export function composerExtensions(wiring: ComposerWiring): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    UndoRedo,
    Placeholder.configure({ placeholder: wiring.placeholder }),
    ChatReference.configure({
      isAttached: (id) => wiring.attachments().some((a) => a.id === id),
    }),
    composerRules(wiring),
  ];
}
