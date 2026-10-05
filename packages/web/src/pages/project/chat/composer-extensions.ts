// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Extension, type AnyExtension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';
import { splitBlock } from '@tiptap/pm/commands';
import { Fragment, Slice, type Schema } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import { CHAT_MESSAGE_MAX_CHARS } from '@breatic/shared';

import { dispatchMachineEdit, MACHINE_EDIT_META } from '@web/features/reference-mention/reference-mention-local-input';
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
 * Whether an edit brings in a batch of text at once: a paste, a drop from
 * outside the box, or an input method's composition. A drop that moves what
 * is already in the box deletes its source first, so it has a second step.
 * @param tr - The edit.
 * @returns True for a batch.
 */
function isBatch(tr: Transaction): boolean {
  if (tr.getMeta('composition') !== undefined || tr.getMeta('uiEvent') === 'paste') return true;
  return tr.getMeta('uiEvent') === 'drop' && tr.steps.length === 1;
}

/**
 * Where a batch let past the limit ends, followed through every later edit
 * until the box has cut it; null when there is none.
 */
const overflowKey = new PluginKey<number | null>('composerOverflow');

/**
 * The edit that brings the box back to the limit by cutting what stands just
 * before where a batch ends. Cut between whole characters; a longer cut never
 * measures longer, so the cut is found by halves.
 * @param state - The box's state.
 * @param to - Where the batch ends.
 * @param attached - What is attached; only their ids are read.
 * @returns The edit, or null when the box is within the limit.
 */
function trimToLimit(state: EditorState, to: number, attached: ReadonlyArray<{ readonly id: string }>): Transaction | null {
  /**
   * Whether cutting from a position up to the end leaves the box within the limit.
   * @param from - Where the cut starts.
   * @returns True when it fits.
   */
  const fitsFrom = (from: number): boolean =>
    settledLength(state, state.tr.delete(from, to), attached) <= CHAT_MESSAGE_MAX_CHARS;
  if (fitsFrom(to)) return null;
  let low = 0;
  let high = to;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (fitsFrom(mid)) low = mid;
    else high = mid - 1;
  }
  let from = low;
  // Never leave half of a character that takes two code units.
  const before = state.doc.textBetween(Math.max(0, from - 1), from);
  if (/[\uD800-\uDBFF]/.test(before)) from -= 1;
  return state.tr.delete(from, to);
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
  /**
   * Cuts a batch that went past the limit once the box is no longer composing:
   * the box keeps the longest start of what came in that fits, as the
   * textarea's maxLength did.
   * @param view - The box.
   */
  const cutOverflow = (view: EditorView): void => {
    const end = overflowKey.getState(view.state);
    if (end === null || end === undefined || view.composing || view.isDestroyed) return;
    const trim = trimToLimit(view.state, end, wiring.attachments());
    dispatchMachineEdit(view, (trim?.scrollIntoView() ?? view.state.tr).setMeta(overflowKey, null));
    if (trim !== null) wiring.onRefusedAtLimit();
  };
  return Extension.create({
    name: 'composerRules',
    priority: 150,
    addProseMirrorPlugins() {
      return [
        Suggestion<TrayItem>({ editor: this.editor, ...wiring.suggestion }),
        new Plugin<number | null>({
          key: overflowKey,
          state: {
            init: () => null,
            apply: (tr, end) => {
              const meta = tr.getMeta(overflowKey) as number | null | undefined;
              if (meta !== undefined) return meta;
              return end === null ? null : tr.mapping.map(end);
            },
          },
          // Typing, a pick, a paste, a drop, an undo or a draft written in can
          // each bring a block in, and the tray or the language can change
          // under the blocks already there: every block is checked here,
          // after any of them.
          appendTransaction: (trs, _old, state): Transaction | null => {
            if (!trs.some((tr) => tr.docChanged || tr.getMeta(ATTACHMENTS_CHANGED_META))) return null;
            const tr = followAttachments(state, wiring.attachments(), wiring.labelOf);
            return tr ? tr.setMeta('addToHistory', false) : null;
          },
          // A batch is cut after the edit that brought it in, or, for a
          // composition, as soon as it ends: an input method whose final text
          // is what it showed while composing ends without another edit.
          view: (view) => {
            /** Cuts once ProseMirror has read the composition's last change. */
            const onCompositionEnd = (): void => {
              queueMicrotask(() => cutOverflow(view));
            };
            view.dom.addEventListener('compositionend', onCompositionEnd);
            return {
              update: cutOverflow,
              destroy: () => view.dom.removeEventListener('compositionend', onCompositionEnd),
            };
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
          // through; an edit that shortens is always fine. A batch of text --
          // a paste, a drop from outside, an input method's composition -- comes
          // in whole and is cut afterwards.
          filterTransaction: (tr: Transaction, state): boolean => {
            if (measuring || !tr.docChanged || tr.getMeta(MACHINE_EDIT_META)) return true;
            const attached = wiring.attachments();
            const after = settledLength(state, tr, attached);
            if (after <= CHAT_MESSAGE_MAX_CHARS || after <= draftLength(state.doc, attached)) return true;
            // What the box's plugins add to a batch still waiting to be cut
            // (the spaces around a block it brought) is part of it.
            if (overflowKey.getState(state) != null) return true;
            if (isBatch(tr)) {
              tr.setMeta(overflowKey, tr.selection.to);
              return true;
            }
            wiring.onRefusedAtLimit();
            return false;
          },
        }),
      ];
    },
  });
}

/**
 * The plain text to take from a paste or a drop whose HTML holds none of the
 * box's blocks: the page's own text, its line breaks and indents as the
 * textarea received them.
 * @param data - The clipboard or the drag's data.
 * @returns The text, or null when ProseMirror's own reading applies.
 */
export function plainTextOf(data: DataTransfer | null): string | null {
  const html = data?.getData('text/html') ?? '';
  if (html === '' || html.includes('data-reference-mention')) return null;
  const text = data?.getData('text/plain') ?? '';
  return text === '' ? null : text;
}

/**
 * Plain text as the box holds it: joined to the line it lands on, a paragraph
 * per line, blank lines kept.
 * @param text - The text.
 * @param schema - The box's schema.
 * @returns The slice to insert.
 */
export function plainTextSlice(text: string, schema: Schema): Slice {
  const lines = text.split(/\r\n?|\n/).map((line) => schema.node('paragraph', null, line === '' ? [] : [schema.text(line)]));
  return Slice.maxOpen(Fragment.from(lines));
}

/**
 * Where what is dropped into the box lands, as the textarea put it: on the
 * line under the pointer, or, beside the text (past a line's end, under the
 * last line), at the end of the nearest line; ProseMirror would start a new
 * line there. Its first and last lines join the lines it lands between, words
 * dragged in from a page are taken as its plain text, as a paste is, and a
 * move dropped onto what it was dragged from changes nothing. The rest is
 * ProseMirror's own drop, step for step. Below the reference block's plugins,
 * so a move's source selection is already restored when it runs.
 * @returns The extension.
 */
function composerDrop(): AnyExtension {
  return Extension.create({
    name: 'composerDrop',
    priority: 50,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handleDrop: (view, event, slice, moved): boolean => {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              const $at = view.state.doc.resolve(at.pos);
              const text = moved ? null : plainTextOf(event.dataTransfer);
              const dropped = text === null ? slice : plainTextSlice(text, view.state.schema);
              if (dropped.size === 0) return false;
              const target = $at.parent.inlineContent ? at.pos : Selection.near($at, -1).head;
              // A block pressed and dragged without being selected first is
              // the drag's own node; anything else moves the selection.
              // prosemirror-view sets that node on `dragging` and reads it in
              // its own drop; its type declaration leaves it out.
              const dragged = view.dragging as { node?: NodeSelection } | null;
              const source = moved ? (dragged?.node ?? view.state.selection) : null;
              if (source && target >= source.from && target <= source.to) return true;
              const taken = Slice.maxOpen(dropped.content);
              const tr = view.state.tr;
              source?.replace(tr);
              const pos = tr.mapping.map(target);
              const single = taken.openStart === 0 && taken.openEnd === 0 && taken.content.childCount === 1 ? taken.content.firstChild : null;
              const before = tr.doc;
              if (single) tr.replaceRangeWith(pos, pos, single);
              else tr.replaceRange(pos, pos, taken);
              if (tr.doc.eq(before)) return true;
              const $pos = tr.doc.resolve(pos);
              if (single && NodeSelection.isSelectable(single) && $pos.nodeAfter?.sameMarkup(single)) {
                tr.setSelection(new NodeSelection($pos));
              } else {
                let end = tr.mapping.map(target);
                tr.mapping.maps[tr.mapping.maps.length - 1]?.forEach((_from, _to, _newFrom, newTo) => {
                  end = newTo;
                });
                tr.setSelection(TextSelection.between($pos, tr.doc.resolve(end)));
              }
              view.focus();
              view.dispatch(tr.setMeta('uiEvent', 'drop'));
              return true;
            },
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
    composerDrop(),
  ];
}
