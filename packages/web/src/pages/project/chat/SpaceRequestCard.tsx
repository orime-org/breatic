// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { SpaceType } from '@breatic/shared';

import { useCollabSocketContext } from '@web/data/yjs/collab-socket';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { ProposalAction, ProposalActions } from '@web/pages/project/chat/ProposalActions';
import { SpaceRequestAnswerContext } from '@web/pages/project/chat/space-request-answer';
import type { ChatSharedSpaceSummary, ChatSpaceRequest } from '@web/pages/project/chat/types';
import { SPACE_TYPE_ICON } from '@web/pages/project/space-type';

interface SpaceRequestCardProps {
  /** The request and where it stands. */
  request: ChatSpaceRequest;
}

/** One row of the card: a Space, the part asked for, and how its read went. */
interface Row {
  id: string;
  name?: string;
  kind?: SpaceType;
  part?: ChatSharedSpaceSummary['part'];
  /** How the read went, when it says something: anything but read. */
  state?: Exclude<ChatSharedSpaceSummary['state'], 'read'>;
}

/** What each state other than read is called on the card. */
const STATE_KEYS: Record<NonNullable<Row['state']>, string> = {
  unreadable: 'chat.spaceRequest.state.unreadable',
  gone: 'chat.spaceRequest.state.gone',
  timed_out: 'chat.spaceRequest.state.timedOut',
  failed: 'chat.spaceRequest.state.failed',
};

/**
 * One Space on the card: its kind's icon, its name, the part asked for, and
 * how its read went when that was not a read.
 * @param root0 - The component props.
 * @param root0.row - The row.
 * @returns The row.
 */
function SpaceRow({ row }: { row: Row }): React.JSX.Element {
  const t = useTranslation();
  const Icon = row.kind === undefined ? null : SPACE_TYPE_ICON[row.kind];
  const part =
    row.part === undefined
      ? null
      : 'blocks' in row.part
        ? t('chat.spaceRequest.partBlocks', { from: row.part.blocks.from, to: row.part.blocks.to ?? 'end' })
        : t('chat.spaceRequest.partNodes', { count: row.part.node_ids.length });
  // A Space gone from the project is named by its state; any name a summary
  // kept for it is not shown.
  const name = row.state === 'gone' ? undefined : row.name;
  return (
    <li data-testid='space-request-row' data-kind={row.kind} className='flex min-w-0 items-center gap-2 text-sm'>
      {Icon === null ? <span className='size-3.5 shrink-0' /> : <Icon className='size-3.5 shrink-0 text-muted-foreground' />}
      {name === undefined ? null : <span className='min-w-0 truncate'>{name}</span>}
      {part === null ? null : (
        <span data-testid='space-request-part' className='shrink-0 text-xs text-muted-foreground'>
          {part}
        </span>
      )}
      {row.state === undefined ? null : (
        <span data-testid='space-request-state' className={cn('shrink-0 text-xs text-muted-foreground', name !== undefined && 'ml-auto')}>
          {t(STATE_KEYS[row.state])}
        </span>
      )}
    </li>
  );
}

/**
 * The two buttons of a waiting card, and the one place the card reads and
 * answers. While a read or a send runs, or a turn is running in the
 * conversation, neither can be pressed; the card going away, or stopping
 * waiting, drops a read in progress.
 * @param root0 - The component props.
 * @param root0.request - The request, waiting.
 * @returns The buttons.
 */
function RequestActions({ request }: SpaceRequestCardProps): React.JSX.Element {
  const t = useTranslation();
  const answering = React.useContext(SpaceRequestAnswerContext);
  const { url } = useCollabSocketContext();
  const [responding, setResponding] = React.useState(false);
  // Read by the press itself: two presses before a render would both see the
  // state as it was.
  const running = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => running.current?.abort(), []);
  const busy = answering?.busy === true;

  const respond = React.useCallback(
    async (allow: boolean): Promise<void> => {
      if (answering === undefined || busy || running.current !== null) return;
      const stop = new AbortController();
      running.current = stop;
      setResponding(true);
      try {
        if (allow) {
          const spaces = await answering.read(request, url, stop.signal);
          if (stop.signal.aborted) return;
          await answering.answer({ toolCallId: request.toolCallId, decision: 'shared', spaces });
        } else {
          await answering.answer({ toolCallId: request.toolCallId, decision: 'declined' });
        }
      } catch (failed) {
        // A read dropped because the card stopped waiting ends here; one that
        // could not start was already said by the panel, and the card waits
        // again either way.
        if (!stop.signal.aborted) console.error('[chat] the request card could not be answered', failed);
      } finally {
        if (running.current === stop) running.current = null;
        setResponding(false);
      }
    },
    [answering, busy, request, url],
  );

  const waiting = responding || busy;
  return (
    <ProposalActions wrap>
      <ProposalAction data-testid='space-request-decline' disabled={waiting} onClick={() => void respond(false)}>
        {t('chat.spaceRequest.decline')}
      </ProposalAction>
      <ProposalAction data-testid='space-request-allow' loading={waiting} onClick={() => void respond(true)}>
        {t('chat.spaceRequest.allow')}
      </ProposalAction>
    </ProposalActions>
  );
}

/**
 * The Agent's request to look at Spaces (inner#1552): each Space asked for,
 * with the part asked for, and why; Decline on the left and Allow
 * on the right. Settled, a heading says how it was answered; a shared card
 * lists the Spaces and marks only those that could not be read.
 * @param root0 - The component props.
 * @param root0.request - The request and where it stands.
 * @returns The card.
 */
export const SpaceRequestCard = React.memo(function SpaceRequestCard({ request }: SpaceRequestCardProps): React.JSX.Element {
  const t = useTranslation();
  const listed = React.useContext(SpaceRequestAnswerContext)?.spaces;
  const awaiting = request.state === 'awaiting';
  const rows = React.useMemo((): Row[] => {
    if (request.state === 'shared') {
      return (request.results ?? []).map(({ id, name, kind, part, state }) => ({
        id,
        name,
        kind,
        part,
        ...(state === 'read' ? {} : { state }),
      }));
    }
    if (!awaiting) return [];
    return request.spaces.map((asked) => {
      const space = listed?.find((s) => s.id === asked.id);
      const part = asked.blocks !== undefined ? { blocks: asked.blocks } : asked.node_ids !== undefined ? { node_ids: asked.node_ids } : undefined;
      return space === undefined
        ? { id: asked.id, part, state: 'gone' as const }
        : { id: asked.id, name: space.name, kind: space.type, part };
    });
  }, [awaiting, listed, request]);
  const heading = awaiting
    ? t('chat.spaceRequest.title')
    : t(request.state === 'shared' ? 'chat.spaceRequest.shared' : request.state === 'declined' ? 'chat.spaceRequest.declined' : 'chat.questionnaire.replied');
  return (
    <div
      data-testid='space-request-card'
      className='mt-2 flex flex-col gap-3 rounded-overlay border border-border bg-popover px-3 py-2.5'
    >
      <div className='flex flex-col gap-1'>
        <p
          data-testid='space-request-heading'
          className={awaiting ? 'text-sm font-semibold text-foreground' : 'text-sm text-muted-foreground'}
        >
          {heading}
        </p>
        {awaiting ? <p className='break-words text-xs text-muted-foreground'>{request.reason}</p> : null}
      </div>
      {rows.length === 0 ? null : (
        <ul className='flex flex-col gap-1.5'>
          {rows.map((row) => (
            <SpaceRow key={row.id} row={row} />
          ))}
        </ul>
      )}
      {awaiting ? <RequestActions request={request} /> : null}
    </div>
  );
});
