// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '@web/components/ui/badge';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/pages/studio/shared/format-relative-time';
import type {
  RecentItem,
  RecentItemRole,
} from '@web/pages/studio/recent/recent-types';

const ROLE_KEY: Record<RecentItemRole, string> = {
  owner: 'studio.recent.role.owner',
  editor: 'studio.recent.role.editor',
  viewer: 'studio.recent.role.viewer',
};

interface RecentCardProps {
  item: RecentItem;
}

/**
 * Recent item tile — a single project / collection card on the cross-studio
 * "Recent" landing. Links to `/project/{slug}-{uuid}` or
 * `/collection/{slug}-{uuid}` (URL design §5.7). Because the landing spans
 * studios, the footer carries a neutral source-studio chip showing where the
 * item lives (the studio chrome is neutral — 2026-06-06 visual ADR). Role
 * badge stays neutral.
 * @param root0 - component props
 * @param root0.item - the recent item to render
 * @returns a clickable tile linking to the item.
 */
export function RecentCard({ item }: RecentCardProps): React.JSX.Element {
  const t = useTranslation();
  const href = `/${item.kind}/${item.slug}-${item.id}`;
  return (
    <Link
      to={href}
      aria-label={item.name}
      className='group flex flex-col overflow-hidden rounded-chrome border border-border bg-card text-card-foreground transition-colors hover:border-foreground-disabled'
    >
      <div className='aspect-video w-full bg-muted'>
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=''
            className='h-full w-full object-cover'
            loading='lazy'
          />
        ) : null}
      </div>
      <div className='flex flex-col gap-2 p-3'>
        <div className='truncate text-sm font-medium'>{item.name}</div>
        <div className='flex items-center justify-between gap-2'>
          <span className='inline-flex min-w-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs'>
            <span
              className='h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground'
              aria-hidden='true'
            />
            <span className='truncate text-muted-foreground'>
              {item.studioName}
            </span>
          </span>
          <Badge variant='outline' className='shrink-0'>
            {t(ROLE_KEY[item.myRole])}
          </Badge>
        </div>
        <div className='text-xs text-muted-foreground'>
          {t('studio.recent.openedAt', {
            time: formatRelativeTime(item.lastOpenedAt, t),
          })}
        </div>
      </div>
    </Link>
  );
}
