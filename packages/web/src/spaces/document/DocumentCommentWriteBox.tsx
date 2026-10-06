// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The box a comment is written in (#18, A26 · A29).
 *
 * Two places take words for a thread: a reply on a card, and the first
 * comment on a draft card. A26 is one list of rules for both — grows with
 * what is written, four lines and then it scrolls, 300 characters, Enter
 * saves, Shift+Enter is a line inside, an input method composing commits
 * nothing — so the rules live here and each caller says only what its two
 * buttons do.
 *
 * The pair appears once there are words to act on: a control that would send
 * nothing is the one thing a card must not draw (R7).
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useAutosizeTextarea } from '@web/lib/use-autosize-textarea';
import { NOTE_MAX_CHARS } from '@web/spaces/canvas/annotation/caps';
import { useNoteBox } from '@web/spaces/canvas/annotation/note-box-keys';

/** Four lines of the box's own text, which is where it stops growing. */
const BOX_MAX_HEIGHT = 'max-h-[88px]';

interface WriteBoxProps {
  /** Names this box's four testids, as `doc-comment-<name>-input` and so on. */
  name: string;
  /** What has been written. */
  value: string;
  /** The placeholder while it is empty. */
  placeholder: string;
  /** Takes each keystroke. */
  onChange: (next: string) => void;
  /** Sends what was written. */
  onSave: () => void;
  /** Throws it away. */
  onCancel: () => void;
  /** Focuses the box as soon as it is on screen. */
  autoFocus?: boolean;
  /**
   * Where the box sits in whatever holds it. The box brings no space of its
   * own: a reply sits under the comments above it, a draft is the card's only
   * content, and each of those is the holder's to say.
   */
  className?: string;
}

/**
 * The box, with its pair of buttons under it once there are words.
 * @param root0 - What the box holds and what its buttons do.
 * @param root0.name - Names the testids.
 * @param root0.value - What has been written.
 * @param root0.placeholder - The placeholder while it is empty.
 * @param root0.onChange - Takes each keystroke.
 * @param root0.onSave - Sends what was written.
 * @param root0.onCancel - Throws it away.
 * @param root0.autoFocus - Focuses the box on arrival.
 * @param root0.className - Where the box sits in whatever holds it.
 * @returns The box and, once it holds words, the pair.
 */
export function DocumentCommentWriteBox({
  name,
  value,
  placeholder,
  onChange,
  onSave,
  onCancel,
  autoFocus = false,
  className,
}: WriteBoxProps): React.JSX.Element {
  const t = useTranslation();
  const box = React.useRef<HTMLTextAreaElement>(null);
  // A26: the box is exactly as tall as what is written, and the scroller
  // around it is what stops at four lines.
  useAutosizeTextarea(box, value);

  // A box that takes the focus as it arrives is one the reader goes on
  // writing in, so the caret goes after what is already there. Mounting
  // writes the words without moving the caret, which leaves it at the start.
  // On arrival only: later, the caret is wherever the reader put it.
  // The focus does not scroll: the box arrives before its card is set level
  // with its words, and scrolling to it then carries the body away from the
  // words the reader is looking at. The card lands beside those words.
  const focusedOnArrival = React.useRef(autoFocus);
  React.useLayoutEffect(() => {
    const node = box.current;
    if (!focusedOnArrival.current || node === null) return;
    // Spent here: a Space shown again runs this effect again, and that is not
    // the box arriving (inner#1235 A19).
    focusedOnArrival.current = false;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const keys = useNoteBox(
    React.useCallback(
      (action) => {
        if (action.type === 'save') onSave();
        else if (action.type === 'escape') onCancel();
      },
      [onSave, onCancel],
    ),
  );

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {/* The border and the focus colour sit on the scroller, which is the
          element that stays still; the box inside it is always exactly as
          tall as what is written, so what scrolls is the words. */}
      <ScrollArea
        scrollbars='vertical'
        className='rounded-chrome border border-border bg-background transition-colors focus-within:border-active-border'
        viewportClassName={BOX_MAX_HEIGHT}
        data-testid={`doc-comment-${name}-scroller`}
      >
        <Textarea
          ref={box}
          rows={1}
          maxLength={NOTE_MAX_CHARS}
          data-testid={`doc-comment-${name}-input`}
          className='min-h-0 resize-none overflow-hidden rounded-none border-0 bg-transparent px-2 py-1 text-sm focus-visible:border-0 md:text-sm'
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          {...keys.box}
        />
      </ScrollArea>

      {/* The same question the write itself asks before it sends: words that
          are only spaces are not worth sending, and a control that looks live
          and answers nothing is the one thing a card must not draw. */}
      {value.trim().length > 0 && (
        <div className='flex justify-end gap-1.5'>
          <Button
            variant='outline'
            size='sm'
            data-testid={`doc-comment-${name}-cancel`}
            onClick={() => {
              if (keys.composing()) return;
              onCancel();
            }}
          >
            {t('spaces.document.comment.cancel')}
          </Button>
          <Button
            size='sm'
            data-testid={`doc-comment-${name}-save`}
            onClick={() => {
              if (keys.composing()) return;
              onSave();
            }}
          >
            {t('spaces.document.comment.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
