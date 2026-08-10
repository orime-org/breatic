// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { STORAGE_KEYS } from '@web/lib/storage-keys';
import { RAIL_LIST } from '@web/pages/studio/rail/rail-row';
import { RailCreateActions } from '@web/pages/studio/rail/RailCreateActions';
import { RailRecentLink } from '@web/pages/studio/rail/RailRecentLink';
import { RailStudioGroup } from '@web/pages/studio/rail/RailStudioGroup';
import { splitStudios } from '@web/pages/studio/rail/rail-grouping';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

interface StudioRailContentProps {
  /** The viewer's own studios (from `GET /studios`), each with `myStudioRole`. */
  studios: readonly StudioSummary[];
  /** The active studio slug, or `null` when on the cross-studio Recent view. */
  activeSlug: string | null;
  /** Opens the create-project dialog (rail segment ①). */
  onCreateProject: () => void;
}

/**
 * The studio rail's scrolling content — what you can do, then where you can
 * go: Recent and the create actions above, the viewer's studios below, split
 * into three groups (#1661) via `splitStudios` — Personal Studio, My Team
 * Studios, Joined Studios.
 *
 * One rule separates those two halves, and it is the only one here. Five used
 * to cut this column into six pieces while every group already carried a
 * heading saying where it began, so the rules, the headings and the group
 * icons were three devices doing one job. The groups are told apart by their
 * headings and the space between them; the rule is kept for the one boundary
 * a heading does not describe — the change from acting to navigating.
 *
 * Create-studio is not here: it creates a Studio rather than something inside
 * the Studio you are already in, so each host pins it to the rail's foot,
 * outside this scrolling area.
 *
 * Shared by the persistent desktop rail (`StudioRail`) and the narrow-screen
 * drawer (`StudioRailDrawer`) so the two never drift. This is layout-only
 * inner content; the outer container (width / border / scroll) belongs to
 * each host.
 * @param props the viewer's studios, active slug and create handler.
 * @param props.studios the viewer's studios.
 * @param props.activeSlug the active studio slug, or null on Recent.
 * @param props.onCreateProject opens the create-project dialog.
 * @returns the rail content segments.
 */
export function StudioRailContent({
  studios,
  activeSlug,
  onCreateProject,
}: StudioRailContentProps): React.JSX.Element {
  const t = useTranslation();
  const { personal, myTeam, joined } = splitStudios(studios);
  return (
    <>
      <div className={`${RAIL_LIST} p-2`}>
        <RailRecentLink
          label={t('studio.rail.recent')}
          active={activeSlug === null}
        />
        <RailCreateActions
          createProjectLabel={t('studio.rail.createProject')}
          createCollectionLabel={t('studio.rail.createCollection')}
          comingSoonLabel={t('studio.rail.comingSoon')}
          onCreateProject={onCreateProject}
        />
      </div>

      <hr className='border-border' />

      <div className='flex flex-col gap-3 p-2'>
        <RailStudioGroup
          title={t('studio.rail.personalStudio')}
          studios={personal}
          activeSlug={activeSlug}
          emptyText={t('studio.rail.personalStudioEmpty')}
          collapseKey={STORAGE_KEYS.railPersonalStudios}
        />
        <RailStudioGroup
          title={t('studio.rail.myStudios')}
          studios={myTeam}
          activeSlug={activeSlug}
          emptyText={t('studio.rail.myStudiosEmpty')}
          collapseKey={STORAGE_KEYS.railMyStudios}
        />
        <RailStudioGroup
          title={t('studio.rail.joinedStudios')}
          studios={joined}
          activeSlug={activeSlug}
          emptyText={t('studio.rail.joinedEmpty')}
          collapseKey={STORAGE_KEYS.railJoinedStudios}
        />
      </div>
    </>
  );
}
