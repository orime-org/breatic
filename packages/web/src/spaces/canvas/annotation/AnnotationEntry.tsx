// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One thing somebody said on a sticky: the annotation itself, or one reply
 * under it.
 *
 * Both are the same shape — who, when, the words, and a menu for the person
 * who wrote them — so they are one component rather than two that drift. What
 * differs is only which write the caller performs when the draft commits.
 *
 * A name, no face (user 2026-09-14). A sticky is 200px wide and a thread runs
 * down it; a portrait beside every line spends that width on the same faces
 * repeating and leaves the words what is left.
 */

import * as React from 'react';
import { MoreHorizontal } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import { useAutosizeTextarea } from '@web/lib/use-autosize-textarea';
import type { DraftAction } from '@web/stores/annotation-draft';
import { AnnotationBody } from '@web/spaces/canvas/annotation/AnnotationBody';
import {
  NOTE_BOX_CLASS,
  NOTE_BOX_MAX_HEIGHT,
  NOTE_REGION_MAX_HEIGHT,
} from '@web/spaces/canvas/annotation/caps';
import { useNoteBox } from '@web/spaces/canvas/annotation/note-box-keys';
import { NoteScroller } from '@web/spaces/canvas/annotation/NoteScroller';
import type { AnnotationRights } from '@web/spaces/canvas/annotation/rights';

export interface AnnotationEntryProps {
  /** The words, as the author typed them. */
  content: string;
  /** When it was posted, epoch ms. */
  createdAt: number;
  /** When it was last rewritten, epoch ms. Absent until somebody edits it. */
  editedAt?: number;
  /** The author's display name, or an empty string while the name loads. */
  authorName: string;
  /** What this person may do to this particular entry. */
  rights: AnnotationRights;
  /** The draft text while this entry is being rewritten, else undefined. */
  editing?: string;
  /** Start rewriting this entry. */
  onEdit: () => void;
  /** Remove this entry. */
  onDelete: () => void;
  /**
   * Advance the draft this box is writing into.
   *
   * The whole vocabulary rather than a hand-picked few (a change, a save, a
   * cancel): the box is the only thing that sees the keystrokes, so anything
   * the keys can mean has to be sayable from here.
   */
  onDraft: (action: DraftAction) => void;
  /**
   * Whether this entry caps and scrolls what is under its header.
   *
   * The annotation does, because nothing else on the sticky would: nothing
   * bounds what somebody may paste, and a note is a landmark on the board.
   * A reply does not — the thread it sits in is already a scroller, and a
   * second one inside it would give the reader two nested scrollbars for one
   * column of words.
   */
  ownScroller?: boolean;
  /** Test hook prefix, so a reply and the annotation are tellable apart. */
  testId: string;
}

/**
 * Draw one annotation or reply.
 * @param props - Everything about this entry and what may be done to it.
 * @returns The entry's header, body, and — while editing — its box.
 */
export function AnnotationEntry(props: AnnotationEntryProps): React.JSX.Element {
  const t = useTranslation();
  // The person asked to rewrite this; the caret belongs in the box they asked
  // for, not wherever the menu item left it. Done with a ref rather than
  // `autoFocus`, which the a11y rule refuses and which fires on mount only.
  const boxRef = React.useRef<HTMLTextAreaElement>(null);
  const {
    content,
    createdAt,
    editedAt,
    authorName,
    rights,
    editing,
    testId,
  } = props;
  // The name answers late, and the id is not a name — showing it would put a
  // uuid where a person belongs. The fallback says what we know: nobody has
  // told us yet.
  const name = authorName.length > 0 ? authorName : t('canvas.annotation.unknownAuthor');
  const showMenu = rights.canEdit || rights.canDelete;
  const open = editing !== undefined;
  // On the transition that OPENS the box, not on every render where it is
  // open. The draft outlives the node's DOM on purpose (the canvas culls
  // offscreen nodes, #1881 E7), so a sticky panned back into view mounts with
  // its box already open — and focusing there takes the caret out of whatever
  // the reader is typing in elsewhere on the board. Measured with two
  // stickies: with an edit box open on one, half a reply typed on the other,
  // and the first panned back, the caret landed in the returning note's box
  // and the reply was discarded on blur.
  //
  // Closing hands the caret back to the menu the box was opened from. Dropped
  // instead, it walks up to `canvas-space`, the nearest thing that takes focus
  // — measured on a board — and that element carries `data-region="space"`, so
  // `regionOwnsKeyboard` hands the canvas the next Backspace, which deletes
  // the selected node. Opening a sticky selects its pin.
  // §6.2's one criterion for the IME, asked by every way out of this box.
  const rewriteBoxKeys = useNoteBox(props.onDraft);
  const wasOpen = React.useRef(open);
  const menuRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (open && !wasOpen.current) boxRef.current?.focus();
    if (!open && wasOpen.current) menuRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // The box is always exactly as tall as what is written in it, so it never
  // scrolls and never draws the browser's scrollbar; the cap and the bar both
  // belong to whichever `ScrollArea` holds this entry.
  useAutosizeTextarea(boxRef, editing ?? '');
  // A press on this entry's padding, on the gap above the box or on Cancel /
  // Save leaves the caret in the box. The rule reaches here from the panel
  // that holds this entry — `AnnotationSticky`'s shell and
  // `AnnotationComposer`'s — which is the outermost surface a press can land
  // on, so it covers this entry's own surfaces along with everything else
  // between them.

  // Which cap this entry's words live under, or none.
  const cap =
    props.ownScroller === true
      ? NOTE_REGION_MAX_HEIGHT
      : open
        ? NOTE_BOX_MAX_HEIGHT
        : null;

  // What a cap applies to: the words, settled or being rewritten. The buttons
  // below stay out of it — swept in, they went below the fold on anything long
  // enough to fill the cap and the reader had to scroll the box they were
  // typing in to find the one that keeps it.
  const words =
    editing === undefined ? (
      <AnnotationBody source={content} />
    ) : (
      <Textarea
        ref={boxRef}
        value={editing}
        rows={2}
        className={NOTE_BOX_CLASS}
        data-testid={`${testId}-input`}
        onChange={(e) => props.onDraft({ type: 'type', text: e.target.value })}
        {...rewriteBoxKeys.box}
      />
    );

  const buttons =
    editing === undefined ? null : (
      <div className='flex justify-end gap-1'>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 text-2xs'
          onClick={() => {
            if (rewriteBoxKeys.composing()) return;
            props.onDraft({ type: 'cancel' });
          }}
          data-testid={`${testId}-cancel`}
        >
          {t('canvas.annotation.cancel')}
        </Button>
        <Button
          size='sm'
          className='h-6 text-2xs'
          // Blanking a note is not deleting it, so the reducer keeps the box
          // open and writes nothing, and the empty box with its Cancel beside
          // it is the account of that. Not HTML `disabled` (#1945: something
          // must happen on this press, so the attribute is the wrong tool) —
          // a disabled control dispatches no pointer events, so the row's
          // press guard cannot see the press and the caret lands on `<body>`,
          // where the canvas answers Backspace by deleting the selected node:
          // this note and its whole thread. Measured: pressing a disabled
          // button leaves `document.activeElement` as BODY, an enabled one
          // leaves it on the textarea.
          onClick={() => {
            if (rewriteBoxKeys.composing()) return;
            props.onDraft({ type: 'save' });
          }}
          data-testid={`${testId}-save`}
        >
          {t('canvas.annotation.save')}
        </Button>
      </div>
    );

  return (
    // `nodrag` lets a pointer press select the words instead of dragging the
    // note: without it a drag across a line moved the note 112px on a real
    // board and selected nothing. Same reason as the text node's body and the
    // group's name field.
    <div className='nodrag px-2 py-1.5' data-testid={testId}>
      <div className='flex items-center gap-1.5'>
        <span className='truncate text-2xs font-medium' data-testid={`${testId}-author`}>
          {name}
        </span>
        {/* `ml-auto` here and nowhere else in this row: it takes all the
            leftover width, so the name sits at one edge and the time at the
            other, with whatever follows the time riding along behind it. A
            second `ml-auto` further along would split the leftover and strand
            the time in the middle. */}
        <span
          className='ml-auto shrink-0 text-2xs text-muted-foreground'
          data-testid={`${testId}-time`}
        >
          {formatRelativeTime(createdAt, t)}
        </span>
        {editedAt === undefined ? null : (
          <span
            className='shrink-0 text-2xs text-muted-foreground'
            data-testid={`${testId}-edited`}
          >
            {t('canvas.annotation.edited')}
          </span>
        )}
        {showMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuRef}
                variant='ghost'
                size='icon'
                className='h-6 w-6 shrink-0'
                data-testid={`${testId}-menu`}
              >
                <MoreHorizontal className='h-3.5 w-3.5' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' sideOffset={4}>
              {rights.canEdit ? (
                <DropdownMenuItem
                  onSelect={props.onEdit}
                  data-testid={`${testId}-edit`}
                >
                  {t('canvas.annotation.edit')}
                </DropdownMenuItem>
              ) : null}
              {rights.canDelete ? (
                <DropdownMenuItem
                  onSelect={props.onDelete}
                  data-testid={`${testId}-delete`}
                >
                  {t('canvas.annotation.delete')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className={editing === undefined ? undefined : 'mt-1 flex flex-col gap-1'}>
        {/* An entry with a scroller of its own uses it for both readings —
            the words, and the box rewriting them, which stands where they
            stood. An entry without one still needs a cap while a box is open:
            the box grows with what is typed and nothing else bounds it, so
            inside the thread's own 180px scroller a long rewrite pushed its
            buttons below the fold — the body's shape, one level down. */}
        {cap === null ? (
          words
        ) : (
          <NoteScroller cap={cap} data-testid={`${testId}-scroller`}>
            {words}
          </NoteScroller>
        )}
        {buttons}
      </div>
    </div>
  );
}
