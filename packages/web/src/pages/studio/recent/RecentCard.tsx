// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import type {
  RecentItem,
  RecentItemRole,
} from '@web/pages/studio/recent/recent-types';
import { ItemCardBody } from '@web/pages/studio/shared/ItemCardBody';

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
 * studios, the meta line reads "{studio} · opened {time}", with the viewer's
 * role as plain text at its right end; a long studio name truncates and the
 * time stays whole.
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
      className='group flex flex-col overflow-hidden rounded-chrome border border-border bg-card text-card-foreground transition-colors hover:border-foreground-disabled focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
    >
      <ItemCardBody
        thumbnailUrl={item.thumbnailUrl}
        name={item.name}
        role={t(ROLE_KEY[item.myRole])}
        meta={
          <>
            <span className='min-w-0 truncate'>{item.studioName}</span>
            <span className='shrink-0' aria-hidden='true'>
              ·
            </span>
            <span className='shrink-0'>
              {t('studio.recent.openedAt', {
                time: formatRelativeTime(item.lastOpenedAt, t),
              })}
            </span>
          </>
        }
      />
    </Link>
  );
}
