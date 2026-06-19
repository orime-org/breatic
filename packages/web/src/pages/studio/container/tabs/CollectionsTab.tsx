// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Group } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { canRenderItemCard } from '@web/pages/studio/container/access';
import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';
import { CollectionCard } from '@web/pages/studio/container/cards/CollectionCard';
import { EmptyState } from '@web/pages/studio/shared/EmptyState';
import type { ContainerCollection } from '@web/pages/studio/container/container-types';
import {
  NewItemDialog,
  type NewItemValues,
} from '@web/pages/studio/container/dialogs/NewItemDialog';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface CollectionsTabProps {
  collections: readonly ContainerCollection[];
  /** The viewer's studio role (`null` = non-member) — drives the visibility filter (invariant 1). */
  studioRole: StudioRole | null;
  /** Called when a collection is created via the dialog (stub no-op in slice 3). */
  onCreateCollection?: (values: NewItemValues) => void;
}

// Auto-fill grid (neutral mock §grid): cards are min 190px wide, so the row
// packs up to ~5 columns at the 1100px container width and reflows down.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3';

/**
 * The Collections tab (spec §3.4 / §3.13): a toolbar (title + count + sort/view
 * placeholders + create button) over a card grid of the studio's collections
 * (project-peer asset sets), filtered by the viewer's access (spec §4 invariant
 * 1). The toolbar's create button is the entry point (locked mock dropped the
 * in-grid card); an empty studio shows an empty-state line below the toolbar.
 * Like projects, create is gated to members (a guest cannot create).
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
  const canCreate = studioRole !== null;
  const visible = collections.filter((collection) =>
    canRenderItemCard(studioRole, collection),
  );
  return (
    <>
      <ContainerToolbar
        title={t('studio.container.tabs.collections')}
        count={visible.length}
        createLabel={t('studio.container.collections.new')}
        onCreate={canCreate ? () => setDialogOpen(true) : undefined}
      />
      {visible.length === 0 ? (
        <EmptyState
          icon={Group}
          title={t('studio.container.collections.emptyTitle')}
          hint={t('studio.container.collections.emptyHint')}
        />
      ) : (
        <div className={GRID}>
          {visible.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              studioRole={studioRole}
            />
          ))}
        </div>
      )}
      {canCreate ? (
        <NewItemDialog
          kind='collection'
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreate={onCreateCollection}
        />
      ) : null}
    </>
  );
}
