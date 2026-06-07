// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { canRenderItemCard } from '@web/pages/studio/container/access';
import { CollectionCard } from '@web/pages/studio/container/cards/CollectionCard';
import { NewItemCard } from '@web/pages/studio/container/cards/NewItemCard';
import type { ContainerCollection } from '@web/pages/studio/container/container-types';
import {
  NewItemDialog,
  type NewItemValues,
} from '@web/pages/studio/container/dialogs/NewItemDialog';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface CollectionsTabProps {
  collections: readonly ContainerCollection[];
  /** The viewer's studio role (`null` = guest) — drives the visibility filter (invariant 1). */
  studioRole: StudioRole | null;
  /** Called when a collection is created via the dialog (stub no-op in slice 3). */
  onCreateCollection?: (values: NewItemValues) => void;
}

// Auto-fill grid (mock定稿): cards are ~236px wide, so the row packs up to
// ~5 columns at the 1320px container width and reflows down on narrow screens.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3';

/**
 * The Collections tab (spec §3.4 / §3.13): a card grid of the studio's
 * collections (project-peer asset sets), filtered by the viewer's access
 * (spec §4 invariant 1), with a trailing "new collection" card that opens the
 * create dialog. When there are no visible collections, only the
 * new-collection card is shown.
 * @param props the collections, the viewer's studio role and the create callback.
 * @param props.collections the studio's collections.
 * @param props.studioRole the viewer's studio role.
 * @param props.onCreateCollection called when a collection is created via the dialog.
 * @returns the Collections tab content.
 */
export function CollectionsTab({
  collections,
  studioRole,
  onCreateCollection,
}: CollectionsTabProps): React.JSX.Element {
  const t = useTranslation();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const visible = collections.filter((collection) =>
    canRenderItemCard(studioRole, collection),
  );
  const newCard = (
    <NewItemCard
      label={t('studio.container.collections.new')}
      onClick={() => setDialogOpen(true)}
    />
  );
  return (
    <>
      {visible.length === 0 ? (
        <div>
          <p className='mb-4 text-sm text-muted-foreground'>
            {t('studio.container.collections.empty')}
          </p>
          <div className={GRID}>{newCard}</div>
        </div>
      ) : (
        <div className={GRID}>
          {visible.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              studioRole={studioRole}
            />
          ))}
          {newCard}
        </div>
      )}
      <NewItemDialog
        kind='collection'
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={onCreateCollection}
      />
    </>
  );
}
