// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ArrowUp, Loader2, Plus, Square } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { EditorContent } from '@tiptap/react';
import { CHAT_MESSAGE_MAX_CHARS, messageLength } from '@breatic/shared';
import { useTranslation } from '@web/i18n/use-translation';
import { AttachmentChip } from '@web/pages/project/chat/AttachmentChip';
import { SpaceContextChip } from '@web/pages/project/chat/SpaceContextChip';
import type { SpaceContextChipProps } from '@web/pages/project/chat/SpaceContextChip';
import { ChatAttachmentsContext } from '@web/pages/project/chat/chat-reference';
import { useAtLimitNotice } from '@web/pages/project/chat/use-at-limit-notice';
import { useComposerEditor } from '@web/pages/project/chat/use-composer-editor';
import { ModelPicker } from '@web/pages/project/chat/ModelPicker';
import { NO_ATTACHMENTS, type TrayItem } from '@web/stores/chat-attachments';
import type { TurnPhase } from '@web/stores/conversation-runtime';
import type { ClipboardPayload } from '@web/spaces/canvas/node-clipboard';


interface ChatComposerProps {
  /** The conversation the box writes into. */
  conversationId?: string | null;
  /** The Project the conversation is in; with a conversation, the model picker is shown (#1363). */
  projectId?: string;
  draft: string;
  /**
   * How far along the turn is, which decides what stands where Send does.
   *
   * `sending` is the wait between the press and the server's answer to the
   * send. Neither button belongs there: sending again would ask the same
   * thing twice, and a stop button would offer to stop a run this end has no
   * word of yet. While a run is `running`, stop and send stand side by side.
   */
  turnPhase?: TurnPhase;
  /** A stop is on its way to the server (inner#1717). */
  stopping?: boolean;
  /**
   * The panel is on its way to another conversation.
   *
   * What is on screen is about to be replaced, so anything typed now would be
   * written into the conversation being left -- it and the reply would vanish
   * when the new one lands, while that turn kept running. The box is held
   * still for that stretch, plainly rather than silently: one that looks
   * usable and does nothing when pressed reads as broken.
   */
  navigating?: boolean;
  /** What is attached to the next message, in order. */
  attachments?: ReadonlyArray<TrayItem>;
  /** What the file picker offers, as an `accept` value. */
  attachAccept?: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  /** Called with the files the user picked. */
  onAttachFiles?: (files: File[]) => void;
  /** Called with canvas nodes pasted into the box. */
  onPasteCanvas?: (payload: ClipboardPayload) => void;
  /** Called with an item's id to take it out. */
  onRemoveAttachment?: (id: string) => void;
  /** The open Space's chip beside the plus sign; none is drawn without one. */
  space?: SpaceContextChipProps;
}

/**
 * Bottom-of-panel chat composer: one card in three rows sharing one border.
 *
 *   ┌───────────────────────────────────┐
 *   │ [item] [item] …                   │  what is attached, only when something is
 *   │ ─────────────────────────────────── │
 *   │ describe what you want…            │  the box
 *   │ [+] [Space]                 [↑]    │  attach, the open Space, and send / wait / stop
 *   └───────────────────────────────────┘
 *
 * Behaviour:
 *   - Enter without Shift submits; Shift+Enter newlines
 *   - `@` lists the attached items; picking one puts a reference to it in
 *     the words
 *   - Send is available only when there is something typed, the turn is idle,
 *     and every attached item is ready: what is sent is what is shown
 *   - The bottom-right corner has 4 states: disabled send, ready send,
 *     waiting (a spinner, nothing to press), streaming (Abort)
 * @param root0 - The component props.
 * @param root0.conversationId - The conversation the box writes into.
 * @param root0.projectId - The Project it is in, for the model picker.
 * @param root0.draft - The current draft text in the input.
 * @param root0.turnPhase - How far along the turn is: idle, sending, running.
 * @param root0.stopping - A stop is on its way to the server.
 * @param root0.navigating - The panel is on its way to another conversation.
 * @param root0.attachments - What is attached to the next message.
 * @param root0.attachAccept - What the file picker offers.
 * @param root0.onChange - Called with the next draft text on each edit.
 * @param root0.onSubmit - Called to send the draft message.
 * @param root0.onAbort - Called to abort the in-flight streaming response.
 * @param root0.onAttachFiles - Called with the files the user picked.
 * @param root0.onPasteCanvas - Called with the canvas clipboard payload pasted into the box.
 * @param root0.onRemoveAttachment - Called with an item's id to take it out.
 * @param root0.space - The open Space's chip beside the plus sign, if one is open.
 * @returns The composer card with attachments, the box, and action buttons.
 */
function ChatComposerInner({
  conversationId = null,
  projectId,
  draft,
  turnPhase = 'idle',
  stopping = false,
  navigating = false,
  attachments = NO_ATTACHMENTS,
  attachAccept,
  onChange,
  onSubmit,
  onAbort,
  onAttachFiles,
  onPasteCanvas,
  onRemoveAttachment,
  space,
}: ChatComposerProps): React.JSX.Element {
  const t = useTranslation();
  // Held still for the same stretch the box is: between the press and the
  // first frame the attached items are the ones being sent, and while the
  // panel changes conversation they belong to the one being left.
  const frozen = turnPhase === 'sending' || navigating;
  const allReady = attachments.every((item) => item.status === 'ready');
  // A run answering does not hold the box: what is sent meanwhile waits for
  // the run's next step (inner#1717).
  const ready = draft.trim().length > 0 && turnPhase !== 'sending' && !navigating && allReady;
  const picker = React.useRef<HTMLInputElement>(null);
  const tray = React.useRef<HTMLDivElement>(null);

  const atLimit = useAtLimitNotice(messageLength(attachments, draft), CHAT_MESSAGE_MAX_CHARS);
  // Read through a ref: the editor is built once, and Enter reaches it there.
  const submitRef = React.useRef<() => void>(() => undefined);
  const editor = useComposerEditor({
    conversationId,
    draft,
    attachments,
    readOnly: frozen,
    ariaLabel: t('chat.composer.inputAria'),
    onChange,
    onEnter: () => submitRef.current(),
    onPasteFiles: (files) => onAttachFiles?.(files),
    onPasteCanvas: (payload) => onPasteCanvas?.(payload),
    onRefusedAtLimit: atLimit.sayAgain,
  });

  /**
   * Submit the draft message when the composer is in a ready state, and hand
   * the keyboard over on the way out.
   */
  const submit = (): void => {
    if (!ready) return;
    onSubmit();
    handOverTheKeyboard();
  };
  submitRef.current = submit;

  /** Stop the turn, and hand the keyboard over on the way out. */
  const abort = (): void => {
    onAbort?.();
    handOverTheKeyboard();
  };

  /**
   * Put the keyboard in the box: the button pressed unmounts (send gives way
   * to the wait, stop leaves when the run ends), and focus would fall to the
   * body. The box is where the user acts next anyway.
   */
  const handOverTheKeyboard = (): void => {
    // The editor's own focus puts the caret back where the user left it; a
    // bare DOM focus lets the browser put it at the start.
    editor?.view.focus();
  };

  /**
   * Take an item out. When the keyboard stands on it, hand the keyboard to the
   * next item, the previous one, or the box -- before the row unmounts and
   * focus falls to the body.
   */
  const removeAttachment = React.useCallback(
    (id: string): void => {
      const row = tray.current?.querySelector(`[data-attachment-id="${CSS.escape(id)}"]`);
      if (row?.contains(document.activeElement)) {
        const neighbour = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector('button');
        if (neighbour) neighbour.focus();
        else editor?.view.focus();
      }
      onRemoveAttachment?.(id);
    },
    [onRemoveAttachment, editor],
  );

  return (
    <div
      data-testid='chat-composer'
      className='m-[var(--space-5)] flex flex-col overflow-hidden rounded-md border border-border bg-card transition-colors has-[.ProseMirror-focused]:border-active-border'
    >
      {/* Only what is being referenced, and only when something is. Holding a
          control here is what made this a row that could never go away, and
          an empty row at the top of the composer is a row of the
          conversation the user does not get. */}
      {attachments.length > 0 ? (
        <div className='flex min-h-[var(--btn-chrome)] flex-nowrap items-center gap-1.5 border-b border-border px-2 py-1'>
          <div
            className='flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5'
            ref={tray}
            data-testid='chat-composer-chips'
            role='list'
            aria-label={t('chat.composer.chipsAria')}
          >
            {attachments.map((item) => (
              <AttachmentChip
                key={item.id}
                id={item.id}
                type={item.type}
                name={item.name}
                chip={item.chip}
                status={item.status}
                {...(item.failure ? { failure: item.failure } : {})}
                {...(onRemoveAttachment ? { onRemove: removeAttachment } : {})}
                removeDisabled={frozen}
                testId={`chat-chip-${item.id}`}
              />
            ))}
          </div>
        </div>
      ) : null}
      {/* Ten lines of writing, then it scrolls -- past that the conversation
          would be the smaller half of the column. The scrolling is the
          panel's own: a box left to scroll itself draws the browser's
          scrollbar, which is a different shape in every engine. */}
      <ScrollArea viewportClassName='max-h-[210px]'>
        <ChatAttachmentsContext.Provider value={attachments}>
          <EditorContent editor={editor} />
        </ChatAttachmentsContext.Provider>
      </ScrollArea>
      <div className='flex items-center justify-between gap-2 px-2 pb-2 pt-1.5'>
        {/* Takes what the model picker leaves, but never less than the +
            button, the gap and the Space chip's floor (SpaceContextChip:
            3em of its text-xs plus 2.125rem), so a tight footer truncates the
            model name and the chip never spills under the picker. */}
        <div className='flex min-w-[calc(var(--btn-inline)+0.375rem+3em+2.125rem)] flex-1 items-center gap-1.5 text-xs'>
          <input
            ref={picker}
            type='file'
            multiple
            hidden
            {...(attachAccept ? { accept: attachAccept } : {})}
            data-testid='chat-composer-file-input'
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              // Emptied so picking the same file again fires a change.
              e.target.value = '';
              if (files.length > 0) onAttachFiles?.(files);
            }}
          />
          <Button
            type='button'
            variant='chrome-ghost'
            size={null}
            aria-label={t('chat.composer.attach')}
            disabled={frozen || !onAttachFiles}
            onClick={() => picker.current?.click()}
            data-testid='chat-composer-attach'
            className='h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 bg-transparent'
          >
            <Plus className='h-4 w-4' />
          </Button>
          {space ? <SpaceContextChip {...space} /> : null}
        </div>
        <div className='flex min-w-0 shrink items-center gap-1'>
          {conversationId !== null && projectId !== undefined ? (
            <ModelPicker conversationId={conversationId} projectId={projectId} />
          ) : null}
          {turnPhase === 'sending' ? (
          // The press landed and the server has not spoken yet. Something has
          // to stand here or the press reads as having done nothing -- but it
          // is not a control: there is nothing to press that would help, so
          // there is nothing to reach with the keyboard either. Kept out of
          // the tab order for a reason beyond having no use: a moment later
          // this slot is the stop button, and anything focusable here can be
          // tabbed to and then turn into something else underneath whoever
          // is standing on it. What it has to say is said by the live region
          // below, which is where a user hears it anyway.
            <span
              data-testid='chat-composer-sending'
              aria-hidden='true'
              className='inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 items-center justify-center rounded-chrome text-muted-foreground'
            >
              <Loader2 className='h-4 w-4 animate-spin' />
            </span>
          ) : (
            <>
              {turnPhase === 'running' ? (
                <Button
                  type='button'
                  variant={null}
                  size={null}
                  aria-label='Abort'
                  loading={stopping}
                  icon={<Square className='h-4 w-4' />}
                  onClick={abort}
                  data-testid='chat-composer-abort'
                  className='inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 items-center justify-center rounded-chrome border border-status-error-border bg-status-error-bg text-status-error-foreground transition-colors hover:border-status-error'
                />
              ) : null}
              <Button
                type='button'
                variant={null}
                size={null}
                aria-label={t('chat.composer.send')}
                title={t('chat.composer.send')}
                disabled={!ready}
                onClick={submit}
                data-testid='chat-composer-send'
                className={`inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 items-center justify-center rounded-chrome transition-opacity disabled:cursor-not-allowed ${
                ready
                  ? 'bg-foreground text-background transition-colors hover:bg-primary-hover'
                  : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              >
                <ArrowUp className='h-4 w-4' />
              </Button>
            </>
          )}
        </div>
        {/* Here whether or not there is anything to say, so that a user is
            told when it fills rather than when it appears: a live region
            inserted already holding its text is one many screen readers never
            announce. The wait used to be announced by the indicator itself,
            which is exactly that -- and the indicator says nothing now, being
            hidden and out of the tab order. */}
        <span className='sr-only' role='status'>
          {turnPhase === 'sending' ? t('chat.composer.sending') : ''}
        </span>
      </div>
    </div>
  );
}


/**
 * Rendered again only when its own props change.
 *
 * A reply arriving token by token re-renders the panel that owns this, and
 * without this that re-render reaches here as well -- sixty times a second,
 * for a component whose props did not move. Every callback it is handed keeps
 * the same identity across those renders, which is what lets the comparison
 * actually stop anything; `draft` is the one prop that does change, and it
 * changes only when the user types.
 */
export const ChatComposer = React.memo(ChatComposerInner);
