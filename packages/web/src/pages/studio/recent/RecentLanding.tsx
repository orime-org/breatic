// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { RecentCard } from '@web/pages/studio/recent/RecentCard';
import type { RecentItem } from '@web/pages/studio/recent/recent-types';

interface RecentLandingProps {
  projects: RecentItem[];
  collections: RecentItem[];
}

/**
 * "Recent" landing — the login-default, cross-studio home (`/studio/recent`,
 * spec §2.1). Two sections (recent projects + recent asset groups), each a
 * 3-column card grid, centered at max 1080px. No credits chip here (credits
 * live only in a studio's Credits tab).
 * @param root0 - component props
 * @param root0.projects - recent projects across all studios (newest first)
 * @param root0.collections - recent asset groups across all studios
 * @returns the two-section recent landing.
 */
export function RecentLanding({
  projects,
  collections,
}: RecentLandingProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='mx-auto w-full max-w-[1080px] px-6 py-6'>
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
  );
}

interface RecentSectionProps {
  title: string;
  emptyText: string;
  items: RecentItem[];
}

/**
 * One titled section of the recent landing: a heading plus a 3-column card
 * grid, or an empty-state line when there are no items.
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
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
          {items.map((item) => (
            <RecentCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
