// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Clock } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { RecentCard } from '@web/pages/studio/recent/RecentCard';
import type { RecentItem } from '@web/pages/studio/recent/recent-types';
import { EmptyState } from '@web/pages/studio/shared/EmptyState';

interface RecentLandingProps {
  projects: RecentItem[];
  collections: RecentItem[];
  /** Opens the create-project dialog from the empty-state CTA (Outlet context). */
  onCreateProject: () => void;
}

/**
 * "Recent" landing — the login-default, cross-studio home (`/studio`,
 * spec §2.1): a "Recent" header + the cross-studio recent projects /
 * collections, centered in the 1100px column. When the viewer has nothing
 * recent yet (the common case until `GET /studio/recent` lands), it shows the
 * shared `EmptyState` (clock + copy + a create-project CTA) instead of
 * per-section placeholder lines — neutral mock §recent-empty.
 * @param root0 - component props
 * @param root0.projects - recent projects across all studios (newest first)
 * @param root0.collections - recent collections across all studios
 * @param root0.onCreateProject - opens the create-project dialog from the empty CTA
 * @returns the recent landing (header + content or empty state).
 */
export function RecentLanding({
  projects,
  collections,
  onCreateProject,
}: RecentLandingProps): React.JSX.Element {
  const t = useTranslation();
  const isEmpty = projects.length === 0 && collections.length === 0;
  return (
    <div className='mx-auto w-full max-w-[1100px] px-7 pb-12'>
      <div className='pt-6'>
        <h1 className='text-lg font-bold tracking-tight text-foreground'>
          {t('studio.recent.title')}
        </h1>
        <p className='mt-1 text-xs text-muted-foreground'>
          {t('studio.recent.subtitle')}
        </p>
      </div>
      {isEmpty ? (
        <EmptyState
          icon={Clock}
          title={t('studio.recent.emptyTitle')}
          hint={t('studio.recent.emptyHint')}
          action={{
            label: t('studio.rail.createProject'),
            onClick: onCreateProject,
          }}
        />
      ) : (
        <div className='pt-[18px]'>
          <RecentSection
            title={t('studio.recent.projectsTitle')}
            emptyText={t('studio.recent.emptyProjects')}
            items={projects}
          />
          <RecentSection
            title={t('studio.recent.collectionsTitle')}
            emptyText={t('studio.recent.emptyCollections')}
            items={collections}
          />
        </div>
      )}
    </div>
  );
}

interface RecentSectionProps {
  title: string;
  emptyText: string;
  items: RecentItem[];
}

/**
 * One titled section of the recent landing: a heading plus a card grid, or an
 * empty-state line when this section has no items (used only when the OTHER
 * section has content — a fully-empty landing renders the shared `EmptyState`).
 * @param root0 - component props
 * @param root0.title - the section heading text
 * @param root0.emptyText - the message shown when `items` is empty
 * @param root0.items - the recent items to render as cards
 * @returns the section element.
 */
function RecentSection({
  title,
  emptyText,
  items,
}: RecentSectionProps): React.JSX.Element {
  return (
    <section className='mb-8'>
      <h2 className='mb-3 text-sm font-semibold text-foreground'>{title}</h2>
      {items.length === 0 ? (
        <p className='text-sm text-muted-foreground'>{emptyText}</p>
      ) : (
        <div className='grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3'>
          {items.map((item) => (
            <RecentCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
