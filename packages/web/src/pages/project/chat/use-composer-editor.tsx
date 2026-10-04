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

import type { Editor } from '@tiptap/core';
import { useEditor } from '@tiptap/react';
import * as React from 'react';
import { CHAT_MESSAGE_MAX_CHARS, getLocale, t as sharedT } from '@breatic/shared';
import { EditorState } from '@tiptap/pm/state';

import { makeMentionSuggestion } from '@web/features/reference-mention/mention-suggestion';
import { dispatchMachineEdit } from '@web/features/reference-mention/reference-mention-local-input';
import { useTranslation } from '@web/i18n/use-translation';
import { attachmentLabel } from '@web/pages/project/chat/attachment-label';
import { chatReferenceContent } from '@web/pages/project/chat/chat-reference';
import { ATTACHMENTS_CHANGED_META, composerExtensions } from '@web/pages/project/chat/composer-extensions';
import { draftContent, draftLength, draftOf } from '@web/pages/project/chat/composer-draft';
import { parseClipboardNodes, type ClipboardNode } from '@web/spaces/canvas/node-clipboard';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';
import type { TrayItem } from '@web/stores/chat-attachments';

/** What the box is told and what it reports. */
export interface ComposerEditorInput {
  /** The conversation the box writes into; its undo history is its own. */
  conversationId: string | null;
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
 * The chat box's editor.
 * @param input - What the box is told and what it reports.
 * @returns The editor, once it exists.
 */
export function useComposerEditor(input: ComposerEditorInput): Editor | null {
  const t = useTranslation();
  // The language now on screen. `t` itself never changes when it does, so the
  // effects that must follow the language list this instead.
  const locale = getLocale();
  // Read through one ref: the editor is built once, and all of these change
  // under it.
  const live = React.useRef(input);
  live.current = input;
  // The open `@` list writes its refresh here. What it lists is the tray, and
  // the tray changes with no edit in the box: an upload finishing, an item
  // added from the canvas or taken out.
  const refreshList = React.useRef<(() => void) | null>(null);
  // The draft this editor last reported, so the panel handing the same string
  // back is not mistaken for a write from outside.
  const reported = React.useRef(input.draft);
  // What the box was last given from outside it.
  const given = React.useRef<Given>({
    conversationId: input.conversationId,
    draft: input.draft,
    attachments: null,
    locale: null,
  });

  const editor = useEditor(
    {
      immediatelyRender: true,
      extensions: [
        ...composerExtensions({
          placeholder: () => t('chat.composer.placeholder'),
          attachments: () => live.current.attachments,
          labelOf,
          onEnter: () => live.current.onEnter(),
          onRefusedAtLimit: () => live.current.onRefusedAtLimit(),
          suggestion: makeMentionSuggestion<TrayItem>({
            resolveList: (query) => {
              const ready = live.current.attachments.filter((a) => a.status === 'ready');
              const q = query.toLowerCase();
              return {
                items: ready.filter((a) => labelOf(a).toLowerCase().includes(q)),
                emptyLabel: t(ready.length === 0 ? 'chat.composer.atEmpty' : 'chat.composer.atNoMatch'),
              };
            },
            content: (item) => chatReferenceContent(item.id),
            itemKey: (item) => item.id,
            renderItem: (item) => <AttachmentRow item={item} label={labelOf(item)} />,
            // Above the `@`: the box sits at the bottom of the column.
            placement: 'top-start',
            refreshRef: refreshList,
          }),
        }),
      ],
      content: draftContent(input.draft),
      editorProps: {
        attributes: {
          'data-testid': 'chat-composer-box',
          role: 'textbox',
          'aria-multiline': 'true',
          class:
            'block w-full whitespace-pre-wrap break-words px-3 pb-1 pt-2.5 text-sm leading-normal text-foreground outline-none',
        },
        handleDOMEvents: {
          // Read-only, ProseMirror skips its own paste handling, and the event
          // would go on to the page: the canvas takes canvas nodes pasted
          // outside a field. The box keeps it, as a read-only field does.
          paste: (view, event): boolean => {
            if (view.editable) return false;
            event.preventDefault();
            event.stopPropagation();
            return true;
          },
        },
        handlePaste: (view, event, slice): boolean => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length > 0) {
            // Pasted files are attached, as if picked with the attach button,
            // and the clipboard's text is left out of the box: copying a file
            // also puts its name there.
            live.current.onPasteFiles(files);
            return true;
          }
          // The canvas's own clipboard text becomes an attachment; text that
          // only looks like it is pasted as the words it is.
          const nodes = parseClipboardNodes(event.clipboardData?.getData('text/plain') ?? '');
          if (nodes !== null) {
            live.current.onPasteCanvas(nodes);
            return true;
          }
          // A paste is measured as what it would insert -- blocks count once,
          // as everywhere in the box -- and one that does not fit is cut down
          // to what is left, as plain words, with the limit said out loud.
          const attached = live.current.attachments;
          const after = draftLength(view.state.tr.replaceSelection(slice).doc, attached);
          if (after <= CHAT_MESSAGE_MAX_CHARS) return false;
          const room = CHAT_MESSAGE_MAX_CHARS - draftLength(view.state.tr.deleteSelection().doc, attached);
          live.current.onRefusedAtLimit();
          const words = slice.content.textBetween(0, slice.content.size, '\n');
          const cut = fitInto(words, room);
          if (cut) view.dispatch(view.state.tr.insertText(cut));
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

  // Everything the box takes from outside -- the conversation, its draft, the
  // tray, the language -- can change in one render: the server's first word
  // empties the draft and the tray together, and a switch brings the other
  // conversation's draft and tray. They are applied here, in this order, so the
  // attachment rule only ever runs on the document for the draft now given.
  // Before paint, so a block never shows without its name.
  React.useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const was = given.current;
    given.current = { conversationId: input.conversationId, draft: input.draft, attachments: input.attachments, locale };
    const trayOrLanguage = input.attachments !== was.attachments || locale !== was.locale;
    if (input.conversationId !== was.conversationId) {
      reported.current = input.draft;
      // Another conversation: the same box takes a fresh state, so the
      // keyboard stays where it is and nothing typed in the last one can be
      // undone here.
      editor.view.updateState(EditorState.create({ doc: editor.schema.nodeFromJSON(draftContent(input.draft)), plugins: editor.state.plugins }));
      dispatchMachineEdit(editor.view, editor.state.tr.setMeta(ATTACHMENTS_CHANGED_META, true));
    } else if (input.draft !== was.draft && input.draft !== reported.current) {
      // A draft written from outside: the server's first word emptying the
      // box, a quick action, a draft restored. The attachment rule runs on it.
      reported.current = input.draft;
      dispatchMachineEdit(editor.view, editor.state.tr.replaceWith(0, editor.state.doc.content.size, editor.schema.nodeFromJSON(draftContent(input.draft)).content));
    } else if (trayOrLanguage) {
      dispatchMachineEdit(editor.view, editor.state.tr.setMeta(ATTACHMENTS_CHANGED_META, true));
    }
    // An open list reads the tray and the language live.
    if (trayOrLanguage) refreshList.current?.();
  }, [editor, input.conversationId, input.draft, input.attachments, locale]);

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
 * The longest start of the words that fits in the room, cut between
 * characters. The limit counts as `String.length` does, so an emoji takes two.
 * @param words - What would be inserted.
 * @param room - How much the limit has left.
 * @returns What fits.
 */
function fitInto(words: string, room: number): string {
  let cut = '';
  for (const char of words) {
    if (cut.length + char.length > room) break;
    cut += char;
  }
  return cut;
}

/** What the box was last given from outside it. */
interface Given {
  conversationId: string | null;
  draft: string;
  /** Null until the first time, so the blocks a draft starts with get their names. */
  attachments: ReadonlyArray<TrayItem> | null;
  locale: string | null;
}

/**
 * What an attachment's block and row show, in the language now on screen.
 * @param item - The tray item.
 * @returns Its label.
 */
function labelOf(item: TrayItem): string {
  return attachmentLabel(sharedT, item);
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
