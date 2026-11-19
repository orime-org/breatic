// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The member list a comment box opens when `@` is typed (#1488 §11.6): it
 * sits above the box, lists the project's members matching what follows the
 * `@`, and a press writes "@name" in its place and records who. The box keeps
 * the caret throughout, so a box that closes on blur stays open.
 */

import * as React from 'react';
import { UserRound } from 'lucide-react';

import type { CommentMention } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@web/components/ui/popover';
import { Skeleton } from '@web/components/ui/skeleton';
import { useProjectMembers } from '@web/data/use-project-members';
import {
  insertMention,
  mentionQueryAt,
} from '@web/features/comment-mention/mention-text';
import { useTranslation } from '@web/i18n/use-translation';
import { useCurrentUserStore } from '@web/stores/current-user';

export interface MentionPickerProps {
  /** The project whose members can be mentioned. */
  projectId: string;
  /** The box being typed in. */
  boxRef: React.RefObject<HTMLTextAreaElement | null>;
  /** The box's words. */
  text: string;
  /** Writes the words with the mention in, and records who was mentioned. */
  onPick: (text: string, mention: CommentMention) => void;
  /** Told whenever the list opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Whether the list may flip to stay on screen; off where it follows the canvas. */
  avoidCollisions?: boolean;
}

/**
 * Track where the caret is in a box.
 * @param boxRef - The box.
 * @param text - Its words, so a change re-reads the caret.
 * @returns The caret's index, or null while unknown.
 */
function useCaret(boxRef: React.RefObject<HTMLTextAreaElement | null>, text: string): number | null {
  const [caret, setCaret] = React.useState<number | null>(null);
  React.useEffect(() => {
    const box = boxRef.current;
    if (box === null) return undefined;
    /** Take the caret's position from the box. */
    const read = (): void => {
      setCaret(box.selectionStart);
    };
    read();
    box.addEventListener('input', read);
    box.addEventListener('keyup', read);
    box.addEventListener('click', read);
    box.addEventListener('focus', read);
    return (): void => {
      box.removeEventListener('input', read);
      box.removeEventListener('keyup', read);
      box.removeEventListener('click', read);
      box.removeEventListener('focus', read);
    };
  }, [boxRef, text]);
  return caret;
}

/**
 * The `@` member list for one comment box.
 * @param props - The picker's props.
 * @param props.projectId - The project whose members are listed.
 * @param props.boxRef - The box it opens above.
 * @param props.text - The box's words.
 * @param props.onPick - Receives the new words and the mention.
 * @param props.onOpenChange - Told when it opens or closes.
 * @param props.avoidCollisions - Whether it may flip to stay on screen.
 * @returns The list, open while the caret follows an `@`.
 */
export function MentionPicker({
  projectId,
  boxRef,
  text,
  onPick,
  onOpenChange,
  avoidCollisions = true,
}: MentionPickerProps): React.JSX.Element {
  const t = useTranslation();
  const viewerId = useCurrentUserStore((s) => s.user?.id);
  const caret = useCaret(boxRef, text);
  const query = caret === null ? null : mentionQueryAt(text, caret);
  // The `@` the user closed the list on; it stays closed until another `@` is typed.
  const [dismissed, setDismissed] = React.useState<number | null>(null);
  const open = query !== null && query.start !== dismissed;
  const { members, isLoading, isError, retry } = useProjectMembers(open ? projectId : 'demo');

  React.useEffect(() => {
    if (query === null && dismissed !== null) setDismissed(null);
  }, [query, dismissed]);
  React.useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // Where the caret goes once the words with the mention are back in the box.
  const pendingCaret = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const box = boxRef.current;
    const at = pendingCaret.current;
    if (box === null || at === null || box.value !== text) return;
    pendingCaret.current = null;
    box.setSelectionRange(at, at);
  }, [boxRef, text]);

  const needle = query?.query.toLocaleLowerCase() ?? '';
  const matching = React.useMemo(
    () =>
      members.filter(
        (m) => m.userId !== viewerId && m.name !== '' && m.name.toLocaleLowerCase().includes(needle),
      ),
    [members, viewerId, needle],
  );

  /**
   * Write one member into the box where the `@` was typed.
   * @param userId - The member.
   * @param name - Their current name.
   */
  const pick = (userId: string, name: string): void => {
    const box = boxRef.current;
    if (box === null) return;
    const at = mentionQueryAt(text, box.selectionStart);
    if (at === null) return;
    const label = `@${name}`;
    const next = insertMention(text, at, box.selectionStart, label);
    pendingCaret.current = next.caret;
    onPick(next.text, { userId, projectId, mentionedAt: Date.now(), label });
  };

  let body: React.ReactNode;
  if (isError) {
    body = (
      <div className='flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground'>
        <span>{t('commentMention.loadFailed')}</span>
        <Button variant='outline' size='compact' onMouseDown={(e) => e.preventDefault()} onClick={retry}>
          {t('commentMention.retry')}
        </Button>
      </div>
    );
  } else if (isLoading) {
    body = (
      <div className='flex flex-col gap-1.5 p-1' data-testid='mention-picker-loading'>
        <Skeleton className='h-6 w-full' />
        <Skeleton className='h-6 w-full' />
        <Skeleton className='h-6 w-full' />
      </div>
    );
  } else if (matching.length === 0) {
    body = <p className='px-2 py-1 text-xs text-muted-foreground'>{t('commentMention.noMatch')}</p>;
  } else {
    body = matching.map((m) => (
      <Button
        key={m.userId}
        variant='ghost'
        className='h-8 w-full justify-start gap-2 px-2 font-normal'
        data-testid={`mention-picker-member-${m.userId}`}
        // The box keeps the caret: the new-note box ends when it loses focus.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(m.userId, m.name)}
      >
        <UserRound className='h-4 w-4 shrink-0' />
        <span className='truncate'>{m.name}</span>
      </Button>
    ));
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next && query !== null) setDismissed(query.start);
      }}
    >
      <PopoverAnchor virtualRef={boxRef as React.RefObject<HTMLTextAreaElement>} />
      <PopoverContent
        side='top'
        align='start'
        sideOffset={4}
        avoidCollisions={avoidCollisions}
        className='nodrag nowheel w-[220px] p-1'
        data-testid='mention-picker'
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Escape closes the list and stops there, leaving the box's own Escape alone.
        onEscapeKeyDown={(e) => e.stopPropagation()}
        onInteractOutside={(e) => {
          if (e.target instanceof Node && boxRef.current?.contains(e.target) === true) e.preventDefault();
        }}
      >
        <p className='px-2 py-1 text-xs text-muted-foreground'>{t('commentMention.members')}</p>
        {body}
      </PopoverContent>
    </Popover>
  );
}
