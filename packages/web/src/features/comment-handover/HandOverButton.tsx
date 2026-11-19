// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hand-over button on a comment thread (#1488 §11.7): the list of the
 * user's own working external agents, and a take-back for the one who handed
 * the thread over.
 */

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Forward, X } from 'lucide-react';

import type { AnnotationAssignment } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Skeleton } from '@web/components/ui/skeleton';
import { AGENT_CONNECTIONS_KEY, agentAccessApi } from '@web/data/api/agent-access';
import { handOverChoices } from '@web/features/comment-handover/hand-over-state';
import { useTranslation } from '@web/i18n/use-translation';
import { formatLocalDay } from '@web/lib/format-day';
import { useAgentTokensDialog } from '@web/stores/agent-tokens-dialog';

export interface HandOverButtonProps {
  /** The thread's current hand-over. */
  assignment?: AnnotationAssignment;
  viewerId: string | undefined;
  /** Whether the handed-to connection answered this hand-over. */
  answered: boolean;
  /** Hands the thread to one connection. */
  onAssign: (connectionId: string) => void;
  /** Takes the hand-over back. */
  onCancel: () => void;
  /** The buttons' size: `compact` on a canvas note, `sm` in a document card. */
  size?: 'compact' | 'sm';
  /** Told when the list opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Whether the list may flip to stay on screen; off where it follows the canvas. */
  avoidCollisions?: boolean;
}

/**
 * The list the button opens, read when it opens.
 * @param props - What the list offers and where a pick goes.
 * @param props.again - The connection that just answered, offered first.
 * @param props.onPick - Takes the connection picked.
 * @param props.onConnect - Closes the list before opening the Agent tokens dialog.
 * @returns The list.
 */
function HandOverList({
  again,
  onPick,
  onConnect,
}: {
  again: string | null;
  onPick: (connectionId: string) => void;
  onConnect: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  const showTokens = useAgentTokensDialog((s) => s.show);
  const connections = useQuery({ queryKey: AGENT_CONNECTIONS_KEY, queryFn: () => agentAccessApi.listConnections() });

  if (connections.isError) {
    return (
      <div className='flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground'>
        <span>{t('commentHandover.loadFailed')}</span>
        <Button variant='outline' size='compact' onClick={() => void connections.refetch()}>
          {t('commentHandover.retry')}
        </Button>
      </div>
    );
  }
  if (connections.isPending) {
    return (
      <div className='flex flex-col gap-1.5 p-1' data-testid='hand-over-loading'>
        <Skeleton className='h-6 w-full' />
        <Skeleton className='h-6 w-full' />
      </div>
    );
  }
  const choices = handOverChoices(connections.data, again);
  if (choices.length === 0) {
    return (
      <div className='flex flex-col items-start gap-1 px-2 py-1 text-xs'>
        <span className='text-muted-foreground'>{t('commentHandover.empty')}</span>
        <Button
          variant='outline'
          size='compact'
          onClick={() => {
            onConnect();
            showTokens();
          }}
        >
          {t('commentHandover.connect')}
        </Button>
      </div>
    );
  }
  return (
    <>
      <p className='px-2 py-1 text-xs text-muted-foreground'>{t('commentHandover.listTitle')}</p>
      {choices.map((c) => (
        <Button
          key={c.id}
          variant='ghost'
          className='h-8 w-full justify-start gap-2 px-2 font-normal'
          data-testid={`hand-over-choice-${c.id}`}
          onClick={() => onPick(c.id)}
        >
          {c.again ? <Forward className='h-4 w-4 shrink-0' /> : <Bot className='h-4 w-4 shrink-0' />}
          <span className='truncate'>{c.again ? t('commentHandover.again', { name: c.name }) : c.name}</span>
          {c.tellApart === null ? null : (
            <span className='ml-auto shrink-0 text-xs text-muted-foreground'>
              {c.tellApart.kind === 'token'
                ? t('commentHandover.token', { prefix: c.tellApart.prefix })
                : t('commentHandover.since', { date: formatLocalDay(c.tellApart.at) })}
            </span>
          )}
        </Button>
      ))}
    </>
  );
}

/**
 * The take-back and hand-over buttons for one thread.
 * @param props - The thread's hand-over and what the buttons do.
 * @param props.assignment - The thread's current hand-over.
 * @param props.viewerId - Who is looking.
 * @param props.answered - Whether the handed-to connection answered this hand-over.
 * @param props.onAssign - Hands the thread to one connection.
 * @param props.onCancel - Takes the hand-over back.
 * @param props.size - The buttons' size.
 * @param props.onOpenChange - Told when the list opens or closes.
 * @param props.avoidCollisions - Whether the list may flip to stay on screen.
 * @returns The buttons.
 */
export function HandOverButton({
  assignment,
  viewerId,
  answered,
  onAssign,
  onCancel,
  size = 'sm',
  onOpenChange,
  avoidCollisions = true,
}: HandOverButtonProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const mine = assignment !== undefined && assignment.assignedBy === viewerId;
  const again = mine && answered ? assignment.connectionId : null;
  const changeOpen = React.useCallback(
    (next: boolean): void => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const icon = size === 'compact' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <div className='flex shrink-0 items-center gap-1'>
      {mine ? (
        <Button variant='outline' size={size} className='gap-1' data-testid='hand-over-cancel' onClick={onCancel}>
          <X className={icon} />
          {t('commentHandover.cancel')}
        </Button>
      ) : null}
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button variant='outline' size={size} className='gap-1' data-testid='hand-over-open'>
            <Forward className={icon} />
            {t('commentHandover.handOver')}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side='bottom'
          align='end'
          sideOffset={4}
          avoidCollisions={avoidCollisions}
          className='nodrag nowheel w-[260px] p-1'
          data-testid='hand-over-list'
        >
          {open ? (
            <HandOverList
              again={again}
              onConnect={() => changeOpen(false)}
              onPick={(connectionId) => {
                changeOpen(false);
                onAssign(connectionId);
              }}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
