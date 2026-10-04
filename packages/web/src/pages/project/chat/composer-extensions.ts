// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Extension, type AnyExtension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { splitBlock } from '@tiptap/pm/commands';
import { history, redo, undo } from '@tiptap/pm/history';
import { Plugin, type Transaction } from '@tiptap/pm/state';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import { CHAT_MESSAGE_MAX_CHARS } from '@breatic/shared';

import { MACHINE_EDIT_META } from '@web/features/reference-mention/reference-mention-local-input';
import { ChatReference } from '@web/pages/project/chat/chat-reference';
import { draftLength, stalePositions } from '@web/pages/project/chat/composer-draft';
import type { TrayItem } from '@web/stores/chat-attachments';

/** Undo and redo for a box with no collaboration behind it. */
const ComposerHistory = Extension.create({
  name: 'composerHistory',
  addProseMirrorPlugins() {
    return [history()];
  },
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => undo(this.editor.state, this.editor.view.dispatch),
      'Mod-Shift-z': () => redo(this.editor.state, this.editor.view.dispatch),
      'Mod-y': () => redo(this.editor.state, this.editor.view.dispatch),
    };
  },
});

/** What the chat box reads live and reports. */
export interface ComposerWiring {
  /** Reads the placeholder sentence. */
  placeholder: () => string;
  /** Reads what is attached now. */
  attachments: () => ReadonlyArray<TrayItem>;
  /** The `@` list. */
  suggestion: Omit<SuggestionOptions<TrayItem>, 'editor'>;
  /** Enter without Shift, outside an IME composition, with no `@` list taking it. */
  onEnter: () => void;
  /** The limit turned an edit away. */
  onRefusedAtLimit: () => void;
}

/**
 * The box's own rules: the `@` list, Enter sends, the limit holds, and a
 * block whose attachment has gone does not come back. The plugins run in the
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
          // An undo or a draft written in can bring back a block whose
          // attachment has since gone; it goes again straight away.
          appendTransaction: (trs, _old, state): Transaction | null => {
            if (!trs.some((tr) => tr.docChanged)) return null;
            const stale = stalePositions(state.doc, wiring.attachments());
            if (stale.length === 0) return null;
            const tr = state.tr;
            for (const pos of stale) tr.delete(pos, pos + 1);
            return tr.setMeta('addToHistory', false);
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
          // reader counts them. Follow-ups other plugins append (the spaces
          // kept around a block) and writes the reader did not make are let
          // through; an edit that shortens is always fine.
          filterTransaction: (tr: Transaction, state): boolean => {
            if (!tr.docChanged || tr.getMeta('appendedTransaction') || tr.getMeta(MACHINE_EDIT_META)) return true;
            const after = draftLength(tr.doc, wiring.attachments());
            if (after <= CHAT_MESSAGE_MAX_CHARS || after <= draftLength(state.doc, wiring.attachments())) return true;
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
    ComposerHistory,
    Placeholder.configure({ placeholder: wiring.placeholder }),
    ChatReference.configure({
      isAttached: (id) => wiring.attachments().some((a) => a.id === id),
    }),
    composerRules(wiring),
  ];
}
