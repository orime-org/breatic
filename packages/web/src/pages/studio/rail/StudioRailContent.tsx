// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Briefcase, Users } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { STORAGE_KEYS } from '@web/lib/storage-keys';
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
  /** Opens the create-team-studio dialog (rail segment ③). */
  onCreateStudio: () => void;
}

/**
 * The studio rail's inner content — segments ①–⑤ (create actions, Recent, and
 * the viewer's studios split by current role into "My studios" / "Joined
 * studios" via `splitStudios`). Shared by the persistent desktop rail
 * (`StudioRail`) and the narrow-screen drawer (`StudioRailDrawer`) so the two
 * never drift. This is layout-only inner content; the outer container (width /
 * border / scroll) belongs to each host.
 * @param props the viewer's studios, active slug and create handler.
 * @param props.studios the viewer's studios.
 * @param props.activeSlug the active studio slug, or null on Recent.
 * @param props.onCreateProject opens the create-project dialog.
 * @param props.onCreateStudio opens the create-team-studio dialog.
 * @returns the rail content segments.
 */
export function StudioRailContent({
  studios,
  activeSlug,
  onCreateProject,
  onCreateStudio,
}: StudioRailContentProps): React.JSX.Element {
  const t = useTranslation();
  const { owned, joined } = splitStudios(studios);
  return (
    <>
      <RailRecentLink
        label={t('studio.rail.recent')}
        active={activeSlug === null}
      />

      <hr className='mx-1.5 my-1.5 border-border' />

      <RailCreateActions
        createProjectLabel={t('studio.rail.createProject')}
        createCollectionLabel={t('studio.rail.createCollection')}
        createStudioLabel={t('studio.rail.createStudio')}
        comingSoonLabel={t('studio.rail.comingSoon')}
        onCreateProject={onCreateProject}
        onCreateStudio={onCreateStudio}
      />

      <hr className='mx-1.5 my-1.5 border-border' />

      <RailStudioGroup
        title={t('studio.rail.myStudios')}
        studios={owned}
        activeSlug={activeSlug}
        emptyText={t('studio.rail.myStudiosEmpty')}
        collapseKey={STORAGE_KEYS.railMyStudios}
        Icon={Briefcase}
      />

      <hr className='mx-1.5 my-1.5 border-border' />

      <RailStudioGroup
        title={t('studio.rail.joinedStudios')}
        studios={joined}
        activeSlug={activeSlug}
        emptyText={t('studio.rail.joinedEmpty')}
        collapseKey={STORAGE_KEYS.railJoinedStudios}
        Icon={Users}
      />
    </>
  );
}
