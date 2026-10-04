// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat box's editor: plain paragraphs with reference blocks, the draft
 * kept as one string outside it.
 *
 * Every write the reader did not make — a draft written from outside, a block
 * taken out because its attachment left, a name brought up to date — goes
 * through `dispatchMachineEdit`, so it stays out of undo and never opens the
 * `@` list.
 */

import { Extension, type Editor } from '@tiptap/core';
import { splitBlock } from '@tiptap/pm/commands';
import { Plugin, type Transaction } from '@tiptap/pm/state';
import { useEditor } from '@tiptap/react';
import * as React from 'react';
import { CHAT_MESSAGE_MAX_CHARS, messageLength } from '@breatic/shared';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { makeMentionSuggestion } from '@web/features/reference-mention/mention-suggestion';
import {
  dispatchMachineEdit,
  MACHINE_EDIT_META,
} from '@web/features/reference-mention/reference-mention-local-input';
import { useTranslation } from '@web/i18n/use-translation';
import { attachmentLabel } from '@web/pages/project/chat/attachment-label';
import {
  CHAT_REFERENCE_LABEL_ATTR,
  CHAT_REFERENCE_PRIORITY,
  chatReferenceContent,
} from '@web/pages/project/chat/chat-reference';
import { composerExtensions } from '@web/pages/project/chat/composer-extensions';
import { draftContent, draftOf } from '@web/pages/project/chat/composer-draft';
import { parseClipboardNodes, type ClipboardNode } from '@web/spaces/canvas/node-clipboard';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';
import type { TrayItem } from '@web/stores/chat-attachments';

/** Below the reference block's priority, above TipTap's default of 100. */
const COMPOSER_RULES_PRIORITY = CHAT_REFERENCE_PRIORITY - 50;

/** What the box is told and what it reports. */
export interface ComposerEditorInput {
  /** The draft as the panel holds it. */
  draft: string;
  /** What is attached to the next message. */
  attachments: ReadonlyArray<TrayItem>;
  /** Nothing goes in while the turn is being sent or the panel is moving. */
  readOnly: boolean;
  /** The box's accessible name. */
  ariaLabel: string;
  /** The id of the line describing the box, while there is one. */
  describedBy: string | undefined;
  /** Called with the draft after each edit. */
  onChange: (next: string) => void;
  /** Enter without Shift, outside an IME composition and with no `@` list open. */
  onEnter: () => void;
  /** Called with pasted files. */
  onPasteFiles: (files: File[]) => void;
  /** Called with canvas nodes pasted as the canvas's own clipboard text. */
  onPasteCanvas: (nodes: ClipboardNode[]) => void;
  /** Called when the limit turned something away. */
  onRefusedAtLimit: () => void;
}

/**
 * How long the draft in a document is, a reference counting as one.
 * @param doc - The document.
 * @param attachments - What is attached.
 * @returns The length the reader sees.
 */
function lengthOf(doc: Editor['state']['doc'], attachments: ReadonlyArray<TrayItem>): number {
  return messageLength(attachments, draftOf(doc));
}

/**
 * The chat box's editor.
 * @param input - What the box is told and what it reports.
 * @returns The editor, once it exists.
 */
export function useComposerEditor(input: ComposerEditorInput): Editor | null {
  const t = useTranslation();
  // Read through one ref: the editor is built once, and all of these change
  // under it.
  const live = React.useRef({ ...input, t });
  live.current = { ...input, t };
  // The draft this editor last reported, so the panel handing the same string
  // back is not mistaken for a write from outside.
  const reported = React.useRef(input.draft);
  /**
   * What the block for an item shows, in the language now on screen.
   * @param item - The tray item.
   * @returns Its label.
   */
  const labelNow = (item: TrayItem): string => attachmentLabel(live.current.t, item);

  const editor = useEditor(
    {
      immediatelyRender: true,
      extensions: [
        ...composerExtensions({
          placeholder: () => live.current.t('chat.composer.placeholder'),
          isAttached: (id) => live.current.attachments.some((a) => a.id === id),
          suggestion: makeMentionSuggestion<TrayItem>({
            resolveList: (query) => {
              const ready = live.current.attachments.filter((a) => a.status === 'ready');
              const q = query.toLowerCase();
              return {
                items: ready.filter((a) => labelNow(a).toLowerCase().includes(q)),
                emptyLabel: live.current.t(ready.length === 0 ? 'chat.composer.atEmpty' : 'chat.composer.atNoMatch'),
              };
            },
            content: (item) => chatReferenceContent(item.id, labelNow(item)),
            itemKey: (item) => item.id,
            renderItem: (item) => <AttachmentRow item={item} label={labelNow(item)} />,
            // Above the `@`: the box sits at the bottom of the column.
            placement: 'top-start',
          }),
        }),
        Extension.create({
          name: 'composerRules',
          // Between the reference block and TipTap's own keymap: the `@` list
          // sees a key first, and Enter is settled here before the default
          // keymap would break the line.
          priority: COMPOSER_RULES_PRIORITY,
          addProseMirrorPlugins() {
            return [
              new Plugin({
                // An undo or a draft written in can bring back a block whose
                // attachment has since gone; it goes again straight away.
                appendTransaction: (trs, _old, state): Transaction | null => {
                  if (!trs.some((tr) => tr.docChanged)) return null;
                  const stale = stalePositions(state.doc, live.current.attachments);
                  if (stale.length === 0) return null;
                  const tr = state.tr;
                  for (const pos of stale) tr.delete(pos, pos + 1);
                  return tr.setMeta('addToHistory', false);
                },
                props: {
                  // Runs after the `@` list's own key handling: a list on
                  // screen takes Enter first, and once it is closed or hidden
                  // Enter is the box's again.
                  handleKeyDown: (view, event): boolean => {
                    if (event.key !== 'Enter' || event.isComposing) return false;
                    event.preventDefault();
                    if (event.shiftKey) splitBlock(view.state, view.dispatch);
                    else live.current.onEnter();
                    return true;
                  },
                },
                // Refuses an edit that would take the words past the limit, as
                // the reader counts them. Follow-ups other plugins append (the
                // spaces kept around a block) and writes the reader did not
                // make are let through; an edit that shortens is always fine.
                filterTransaction: (tr: Transaction, state): boolean => {
                  if (!tr.docChanged || tr.getMeta('appendedTransaction') || tr.getMeta(MACHINE_EDIT_META)) {
                    return true;
                  }
                  const after = lengthOf(tr.doc, live.current.attachments);
                  if (after <= CHAT_MESSAGE_MAX_CHARS || after <= lengthOf(state.doc, live.current.attachments)) {
                    return true;
                  }
                  live.current.onRefusedAtLimit();
                  return false;
                },
              }),
            ];
          },
        }),
      ],
      content: draftContent(input.draft, (id) => nameIn(live.current.attachments, id, labelNow)),
      editorProps: {
        attributes: {
          'data-testid': 'chat-composer-textarea',
          role: 'textbox',
          'aria-multiline': 'true',
          class:
            'block w-full whitespace-pre-wrap break-words px-3 pb-1 pt-2.5 text-sm leading-normal text-foreground outline-none',
        },
        handlePaste: (view, event): boolean => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length > 0) {
            // Pasted files are attached, as if picked with the attach button,
            // and the clipboard's text is left out of the box: copying a file
            // also puts its name there.
            if (!live.current.readOnly) live.current.onPasteFiles(files);
            return true;
          }
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (text === '') return false;
          // The canvas's own clipboard text becomes an attachment; text that
          // only looks like it is pasted as the words it is.
          const nodes = parseClipboardNodes(text);
          if (nodes !== null) {
            if (!live.current.readOnly) live.current.onPasteCanvas(nodes);
            return true;
          }
          // A paste is cut down to what is left under the limit, and saying
          // so is the only way the reader learns the rest did not go in.
          const { from, to } = view.state.selection;
          const room =
            CHAT_MESSAGE_MAX_CHARS -
            lengthOf(view.state.doc, live.current.attachments) +
            view.state.doc.textBetween(from, to, '\n', ' ').length;
          if (text.length <= room) return false;
          live.current.onRefusedAtLimit();
          if (room > 0) view.dispatch(view.state.tr.insertText(text.slice(0, room), from, to));
          return true;
        },
      },
      onUpdate: ({ editor: e }) => {
        const next = draftOf(e.state.doc);
        if (next === reported.current) return;
        reported.current = next;
        live.current.onChange(next);
      },
    },
    [],
  );

  // A draft written from outside: the server's first word emptying the box,
  // a quick action, a draft restored.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed || input.draft === reported.current) return;
    reported.current = input.draft;
    const doc = editor.schema.nodeFromJSON(
      draftContent(input.draft, (id) => nameIn(live.current.attachments, id, labelNow)),
    );
    dispatchMachineEdit(editor.view, editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content));
  }, [editor, input.draft]);

  // Blocks follow the attachments: one whose attachment left goes, and one
  // whose attachment was replaced shows the new name.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    syncBlocks(editor, input.attachments, (item) => attachmentLabel(t, item));
  }, [editor, input.attachments, t]);

  // Read-only keeps the keyboard: ProseMirror drops `contenteditable` and
  // nothing else, so the box needs a tab stop of its own to keep focus.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!input.readOnly);
    const dom = editor.view.dom;
    if (input.readOnly) {
      dom.setAttribute('tabindex', '0');
      dom.setAttribute('aria-readonly', 'true');
    } else {
      dom.removeAttribute('tabindex');
      dom.removeAttribute('aria-readonly');
    }
  }, [editor, input.readOnly]);

  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    dom.setAttribute('aria-label', input.ariaLabel);
    if (input.describedBy) dom.setAttribute('aria-describedby', input.describedBy);
    else dom.removeAttribute('aria-describedby');
  }, [editor, input.ariaLabel, input.describedBy]);

  return editor;
}

/**
 * The name a block for an attachment id shows, or empty for one not attached.
 * @param attachments - What is attached.
 * @param id - The attachment id.
 * @param labelOf - The name an item shows.
 * @returns The name.
 */
function nameIn(
  attachments: ReadonlyArray<TrayItem>,
  id: string,
  labelOf: (item: TrayItem) => string,
): string {
  const item = attachments.find((a) => a.id === id);
  return item ? labelOf(item) : '';
}

/**
 * Where the blocks are whose attachment is not attached. A block goes on its
 * own: the spaces around it are the reader's words.
 * @param doc - The box's document.
 * @param attachments - What is attached.
 * @returns Their positions, last first.
 */
function stalePositions(doc: Editor['state']['doc'], attachments: ReadonlyArray<TrayItem>): number[] {
  const ids = new Set(attachments.map((a) => a.id));
  const stale: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === REFERENCE_MENTION_NODE && !ids.has(String(node.attrs[MENTION_SOURCE_ID_ATTR]))) {
      stale.push(pos);
    }
  });
  // Last first, so each delete leaves the earlier positions where they were.
  return stale.reverse();
}

/**
 * Takes out blocks whose attachment left and renames the rest, in one write
 * the reader did not make.
 * @param editor - The box.
 * @param attachments - What is attached now.
 * @param labelOf - The name an item shows.
 */
function syncBlocks(
  editor: Editor,
  attachments: ReadonlyArray<TrayItem>,
  labelOf: (item: TrayItem) => string,
): void {
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const stale = stalePositions(editor.state.doc, attachments);
  const renames: { pos: number; label: string }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== REFERENCE_MENTION_NODE) return;
    const item = byId.get(String(node.attrs[MENTION_SOURCE_ID_ATTR]));
    if (item && node.attrs[CHAT_REFERENCE_LABEL_ATTR] !== labelOf(item)) {
      renames.push({ pos, label: labelOf(item) });
    }
  });
  if (stale.length === 0 && renames.length === 0) return;
  const tr = editor.state.tr;
  for (const { pos, label } of renames) tr.setNodeAttribute(pos, CHAT_REFERENCE_LABEL_ATTR, label);
  for (const pos of stale) tr.delete(pos, pos + 1);
  dispatchMachineEdit(editor.view, tr);
}

/**
 * One row of the `@` list: the icon of the item's kind, then its name. A piece
 * of the canvas takes the group's icon, being several nodes held together.
 * @param root0 - Component props.
 * @param root0.item - The tray item.
 * @param root0.label - What it is called.
 * @returns The row's content.
 */
function AttachmentRow({ item, label }: { item: TrayItem; label: string }): React.JSX.Element {
  const Icon = getNodeIcon(item.type === 'canvas' ? 'group' : item.type);
  return (
    <>
      <Icon className='h-3 w-3 shrink-0 text-muted-foreground' aria-hidden='true' />
      <span className='truncate'>{label}</span>
    </>
  );
}
