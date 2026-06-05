// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '@web/components/ui/badge';
import { useTranslation } from '@web/i18n/use-translation';
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
 * Recent item tile — a single project / asset-group card on the cross-studio
 * "Recent" landing. Links to `/project/{slug}-{uuid}` or
 * `/collection/{slug}-{uuid}` (URL design §5.7). Because the landing spans
 * studios, the footer carries a brand-tinted source-studio chip (spec §1.2 —
 * studio is the sole brand-color exemption). Role badge stays neutral.
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
      className='group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground transition-colors hover:border-neutral-300'
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
          <span className='inline-flex min-w-0 items-center gap-1 rounded-full bg-[var(--brand-tint)] px-2 py-0.5 text-xs'>
            <span
              className='h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-accent)]'
              aria-hidden='true'
            />
            <span className='truncate text-[var(--brand-accent)]'>
              {item.studioName}
            </span>
          </span>
          <Badge variant='outline' className='shrink-0'>
            {t(ROLE_KEY[item.myRole])}
          </Badge>
        </div>
        <div className='text-xs text-muted-foreground'>
          {formatRelative(item.lastOpenedAt)}
        </div>
      </div>
    </Link>
  );
}

/**
 * Format an ISO timestamp as a short relative string ("5m ago", "3h ago",
 * "2d ago"), falling back to a locale date beyond 30 days or for invalid input.
 * @param iso - the ISO-8601 timestamp to format
 * @returns the relative-time label, or the original string if not a valid date.
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}
