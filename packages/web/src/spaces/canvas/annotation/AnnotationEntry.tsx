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
import { AnnotationBody } from '@web/spaces/canvas/annotation/AnnotationBody';
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
  /** The draft changed. */
  onEditingChange: (text: string) => void;
  /** Keep the rewritten words. */
  onSave: () => void;
  /** Throw the rewritten words away. */
  onCancel: () => void;
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
  React.useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);

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
      {editing === undefined ? (
        <AnnotationBody source={content} />
      ) : (
        <div className='mt-1 flex flex-col gap-1'>
          <Textarea
            ref={boxRef}
            value={editing}
            rows={2}
            className='min-h-0 resize-none text-xs'
            data-testid={`${testId}-input`}
            onChange={(e) => props.onEditingChange(e.target.value)}
            // The reducer decides what Enter means — mid-composition it belongs
            // to the IME, and a blank body is not worth writing.
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                props.onCancel();
              }
            }}
          />
          <div className='flex justify-end gap-1'>
            <Button
              variant='ghost'
              size='sm'
              className='h-6 text-2xs'
              onClick={props.onCancel}
              data-testid={`${testId}-cancel`}
            >
              {t('canvas.annotation.cancel')}
            </Button>
            <Button
              size='sm'
              className='h-6 text-2xs'
              // Blanking a note is not deleting it, so the reducer keeps the
              // box open and writes nothing. Said here rather than in silence:
              // a Save that looks pressable and does nothing leaves the author
              // with no account of what happened.
              disabled={editing.trim().length === 0}
              onClick={props.onSave}
              data-testid={`${testId}-save`}
            >
              {t('canvas.annotation.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
