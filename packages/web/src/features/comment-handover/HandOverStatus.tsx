// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The label the one who handed a thread to an external agent sees while it
 * waits (#1488 §11.7). Collaborators see none; everyone sees the agent's
 * reply once it comes.
 */

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, TimerOff, Unplug } from 'lucide-react';

import type { AnnotationAssignment } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { AGENT_CONNECTIONS_KEY, agentAccessApi, commentAssignmentsKey } from '@web/data/api/agent-access';
import { handOverLabel, type HandOverLabel } from '@web/features/comment-handover/hand-over-state';
import { useConnectionNames } from '@web/features/comment-handover/use-connection-names';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useAgentTokensDialog } from '@web/stores/agent-tokens-dialog';

export interface HandOverStatusProps {
  projectId: string;
  spaceId: string;
  threadId: string;
  /** The thread's current hand-over. */
  assignment: AnnotationAssignment | undefined;
  viewerId: string | undefined;
  /** Whether the handed-to connection answered this hand-over. */
  answered: boolean;
  /** Whether the thread was resolved. */
  resolved: boolean;
  /** Spacing from the holder. */
  className?: string;
}

const NO_IDS: readonly string[] = [];

/**
 * The label, read from the server's record and the viewer's connections.
 * @param props - As `HandOverStatus`, for a thread the viewer handed over.
 * @returns The label, or nothing while it does not wait.
 */
function Waiting(props: HandOverStatusProps & { assignment: AnnotationAssignment }): React.JSX.Element | null {
  const t = useTranslation();
  const show = useAgentTokensDialog((s) => s.show);
  const records = useQuery({
    queryKey: commentAssignmentsKey(props.projectId, props.spaceId),
    queryFn: () => agentAccessApi.spaceAssignments(props.projectId, props.spaceId),
  });
  const connections = useQuery({ queryKey: AGENT_CONNECTIONS_KEY, queryFn: () => agentAccessApi.listConnections() });
  const label: HandOverLabel | null = handOverLabel({
    assignment: props.assignment,
    viewerId: props.viewerId,
    projectId: props.projectId,
    answered: props.answered,
    resolved: props.resolved,
    record: records.data?.find((r) => r.threadId === props.threadId),
    connections: connections.data,
  });
  const gone = label?.kind === 'disconnected';
  const keptNames = useConnectionNames(gone ? [props.assignment.connectionId] : NO_IDS);
  if (label === null) return null;
  const name = gone
    ? keptNames.get(label.connectionId)
    : connections.data?.find((c) => c.id === label.connectionId)?.displayName;
  if (name === undefined) return null;

  const line = cn('inline-flex items-center gap-1 text-xs', props.className);
  if (label.kind === 'waiting') {
    return (
      <span className={cn(line, 'text-status-warning-foreground')} data-testid='hand-over-status'>
        <Clock className='h-3.5 w-3.5 shrink-0' />
        {t('commentHandover.waiting', { name })}
      </span>
    );
  }
  if (label.kind === 'expiredReconnect') {
    return (
      <Button
        variant={null}
        size={null}
        className={cn(line, 'text-status-warning-foreground underline-offset-2 hover-enabled:underline')}
        data-testid='hand-over-status'
        onClick={() => show(label.connectionId)}
      >
        <TimerOff className='h-3.5 w-3.5 shrink-0' />
        {t('commentHandover.expiredReconnect', { name })}
      </Button>
    );
  }
  if (label.kind === 'expiredToken') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(line, 'text-muted-foreground')} data-testid='hand-over-status'>
            <TimerOff className='h-3.5 w-3.5 shrink-0' />
            {t('commentHandover.expiredToken', { name })}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('commentHandover.expiredTokenHint')}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className={cn(line, 'text-muted-foreground')} data-testid='hand-over-status'>
      <Unplug className='h-3.5 w-3.5 shrink-0' />
      {t('commentHandover.disconnected', { name })}
    </span>
  );
}

/**
 * The label on one thread, for the one who handed it over.
 * @param props - The thread and who is looking.
 * @returns The label, or nothing.
 */
export function HandOverStatus(props: HandOverStatusProps): React.JSX.Element | null {
  const { assignment } = props;
  if (assignment === undefined || assignment.assignedBy !== props.viewerId || assignment.projectId !== props.projectId) {
    return null;
  }
  return <Waiting {...props} assignment={assignment} />;
}
