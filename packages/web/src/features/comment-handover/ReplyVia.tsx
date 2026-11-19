// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { Bot } from 'lucide-react';

import { useConnectionNames } from '@web/features/comment-handover/use-connection-names';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/**
 * "X replied" beside a reply an external agent wrote (#1488 §11.7), seen by
 * every member.
 * @param props - The connection, and where the line sits.
 * @param props.connectionId - The connection that wrote it.
 * @param props.className - Spacing from the holder.
 * @returns The line, empty until the name arrives.
 */
export function ReplyVia({ connectionId, className }: { connectionId: string; className?: string }): React.JSX.Element | null {
  const t = useTranslation();
  const ids = React.useMemo(() => [connectionId], [connectionId]);
  const name = useConnectionNames(ids).get(connectionId);
  if (name === undefined) return null;
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground', className)}
      data-testid='reply-via'
    >
      <Bot className='h-3 w-3' />
      {t('commentHandover.replied', { name })}
    </span>
  );
}
