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
import { getLocale, t as sharedT } from '@breatic/shared';
import { Fragment, Slice, type Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

import { makeMentionSuggestion } from '@web/features/reference-mention/mention-suggestion';
import { dispatchMachineEdit } from '@web/features/reference-mention/reference-mention-local-input';
import { useTranslation } from '@web/i18n/use-translation';
import { AttachmentKindIcon } from '@web/pages/project/chat/AttachmentChip';
import { attachmentLabel } from '@web/pages/project/chat/attachment-label';
import { chatReferenceContent } from '@web/pages/project/chat/chat-reference';
import { ATTACHMENTS_CHANGED_META, composerExtensions } from '@web/pages/project/chat/composer-extensions';
import { draftContent, draftOf } from '@web/pages/project/chat/composer-draft';
import { parseClipboardNodes, type ClipboardNode } from '@web/spaces/canvas/node-clipboard';
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
      // Lines go to the clipboard one line break apart, as the draft joins
      // them and as the textarea copied them.
      coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: '\n' } },
      editorProps: {
        attributes: {
          'data-testid': 'chat-composer-box',
          role: 'textbox',
          'aria-multiline': 'true',
          // Always a tab stop, as the textarea was, read-only included. TipTap's
          // own Tabindex drops it with `contenteditable` when the box turns
          // read-only, and a focused element left with neither gives focus to
          // the body; these props are read before any plugin's, so this one holds.
          tabindex: '0',
          class:
            // The placeholder keeps to one line, as the textarea's did: wrapped,
            // its second line hangs below the empty box and makes it scroll.
            'block w-full whitespace-pre-wrap break-words px-3 pb-1 pt-2.5 text-sm leading-normal text-foreground outline-none [&_.is-editor-empty::before]:max-w-full [&_.is-editor-empty::before]:truncate',
        },
        handleDOMEvents: {
          // Copying or cutting nothing leaves the clipboard as it was, as in a
          // textarea; ProseMirror would write an empty string over it.
          copy: (view): boolean => nothingSelected(view.state),
          cut: (view): boolean => nothingSelected(view.state),
          paste: (view, event): boolean => {
            if (view.editable) {
              // Words copied from a page are taken as the page's plain text, as
              // the textarea took them; only the box's own blocks need its HTML.
              const text = plainTextOf(event.clipboardData);
              if (text === null || (event.clipboardData?.files.length ?? 0) > 0) return false;
              view.pasteText(text, event);
            } else {
              // Read-only, ProseMirror skips its own paste handling, and the
              // event would go on to the page: the canvas takes canvas nodes
              // pasted outside a field. The box keeps it, as a read-only field does.
              event.stopPropagation();
            }
            event.preventDefault();
            return true;
          },
        },
        handlePaste: (_view, event): boolean => {
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
          // Everything else is pasted as ProseMirror pastes it; one past the
          // limit has its end cut once it is in (composerRules).
          return false;
        },
        clipboardTextParser: (text, $context): Slice => plainTextSlice(text, $context.doc.type.schema),
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

  // Read-only keeps the keyboard through the tab stop the attributes above give
  // the box for good.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!input.readOnly);
    if (input.readOnly) editor.view.dom.setAttribute('aria-readonly', 'true');
    else editor.view.dom.removeAttribute('aria-readonly');
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
 * Whether the selection holds no words and no block -- what a select-all in an
 * empty box gives.
 * @param state - The box's state.
 * @returns True when there is nothing to copy.
 */
function nothingSelected(state: EditorState): boolean {
  const { from, to } = state.selection;
  return state.doc.textBetween(from, to, '\n', () => '\uFFFC') === '';
}

/**
 * The plain text to take from a paste whose HTML holds none of the box's
 * blocks: the page's own text, its line breaks and indents as the textarea
 * received them.
 * @param data - The clipboard's data.
 * @returns The text, or null when ProseMirror's own reading applies.
 */
function plainTextOf(data: DataTransfer | null): string | null {
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
function plainTextSlice(text: string, schema: Schema): Slice {
  const lines = text.split(/\r\n?|\n/).map((line) => schema.node('paragraph', null, line === '' ? [] : [schema.text(line)]));
  return Slice.maxOpen(Fragment.from(lines));
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
  return (
    <>
      <AttachmentKindIcon type={item.type} />
      <span className='truncate'>{label}</span>
    </>
  );
}
