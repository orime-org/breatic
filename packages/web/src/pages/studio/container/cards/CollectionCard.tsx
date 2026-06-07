// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  canManageItem,
  effectiveItemRole,
} from '@web/pages/studio/container/access';
import type { ContainerCollection } from '@web/pages/studio/container/container-types';
import { RoleBadge, VisibilityBadge } from '@web/pages/studio/shared/badges';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface CollectionCardProps {
  collection: ContainerCollection;
  /** The viewer's studio role (`null` = guest) — gates the governance (`⋯`) menu (invariant 2). */
  studioRole: StudioRole | null;
}

/** Four preview cells for the collection's 4-grid thumbnail (spec §3.4). */
const PREVIEW_CELLS = [0, 1, 2, 3] as const;

/**
 * A collection card in the studio container Collections tab (spec §3.4): a
 * 4-grid asset preview, the name, asset count, media-kind tag, visibility +
 * role badges, and a governance (`⋯`) entry gated by spec §4 invariant 2.
 * Collections are project-peers (DD §5.5); the card links to
 * `/collection/{slug}-{uuid}`.
 * @param props the collection and the viewer's studio role.
 * @param props.collection the collection to render.
 * @param props.studioRole the viewer's studio role.
 * @returns the collection card.
 */
export function CollectionCard({
  collection,
  studioRole,
}: CollectionCardProps): React.JSX.Element {
  const t = useTranslation();
  const canManage = canManageItem(studioRole, collection.isOwner);
  return (
    <div className='group relative overflow-hidden rounded-lg border border-border bg-card transition-[box-shadow,border-color] hover:border-neutral-300 hover:shadow-md'>
      <Link
        to={`/collection/${collection.slug}-${collection.id}`}
        className='flex flex-col'
      >
        <div className='relative grid aspect-[16/9] grid-cols-2 grid-rows-2 gap-0.5 bg-border'>
          {PREVIEW_CELLS.map((cell) => {
            const thumb = collection.previewThumbnails[cell];
            return (
              <div key={cell} className='overflow-hidden bg-muted'>
                {thumb ? (
                  <img
                    src={thumb}
                    alt=''
                    className='h-full w-full object-cover'
                  />
                ) : null}
              </div>
            );
          })}
          <span className='absolute left-2 top-2 z-[1]'>
            <VisibilityBadge visibility={collection.visibility} />
          </span>
        </div>
        <div className='p-2.5'>
          {/* Title row (locked mock): name + asset count on one line. */}
          <div className='flex items-center gap-2'>
            <p className='min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground'>
              {collection.name}
            </p>
            <span className='whitespace-nowrap text-xs text-muted-foreground'>
              {t('studio.container.card.assetCount', {
                count: collection.assetCount,
              })}
            </span>
          </div>
          <div className='mt-2 flex items-center gap-2'>
            {/* Time slot placeholder — see ProjectCard; role badge stays right. */}
            <span className='ml-auto inline-flex'>
              <RoleBadge itemRole={effectiveItemRole(collection.myRole)} />
            </span>
          </div>
        </div>
      </Link>
      {canManage ? (
        <button
          type='button'
          aria-label={t('studio.container.card.more')}
          className='absolute right-2 top-2 z-10 flex h-[22px] w-[22px] items-center justify-center rounded-content-sm bg-black/45 text-white opacity-0 transition-opacity hover:bg-black/70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100'
        >
          <MoreHorizontal className='h-3.5 w-3.5' />
        </button>
      ) : null}
    </div>
  );
}
