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
import {
  CollectionKindTag,
  RoleBadge,
  VisibilityBadge,
} from '@web/pages/studio/shared/badges';
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
    <div className='group relative overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-neutral-300'>
      <Link
        to={`/collection/${collection.slug}-${collection.id}`}
        className='flex flex-col'
      >
        <div className='grid aspect-[16/10] grid-cols-2 grid-rows-2 gap-0.5 bg-border'>
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
        </div>
        <div className='p-3'>
          <p className='truncate text-sm font-semibold text-foreground'>
            {collection.name}
          </p>
          <p className='mt-0.5 text-xs text-muted-foreground'>
            {t('studio.container.card.assetCount', {
              count: collection.assetCount,
            })}
          </p>
          <div className='mt-2 flex flex-wrap items-center gap-1.5'>
            <CollectionKindTag kind={collection.kind} />
            <VisibilityBadge visibility={collection.visibility} />
            <RoleBadge itemRole={effectiveItemRole(collection.myRole)} />
          </div>
        </div>
      </Link>
      {canManage ? (
        <button
          type='button'
          aria-label={t('studio.container.card.more')}
          className='absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-chrome bg-background text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100'
        >
          <MoreHorizontal className='h-4 w-4' />
        </button>
      ) : null}
    </div>
  );
}
