// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { RailCreateActions } from '@web/pages/studio/rail/RailCreateActions';
import { RailRecentLink } from '@web/pages/studio/rail/RailRecentLink';
import { RailStudioGroup } from '@web/pages/studio/rail/RailStudioGroup';
import { splitStudios } from '@web/pages/studio/rail/rail-grouping';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

interface StudioRailProps {
  /** The viewer's own studios (from `GET /studios`), each with `myStudioRole`. */
  studios: readonly StudioSummary[];
  /** The active studio slug, or `null` when on the cross-studio Recent view. */
  activeSlug: string | null;
  /** Opens the create-project dialog (rail segment ①). */
  onCreateProject: () => void;
}

/**
 * The persistent studio rail (spec §4) — the always-on left navigation that
 * replaces the top-bar switcher popover. Five segments: create actions (①②),
 * Recent (③), and the viewer's studios split by CURRENT role into "My
 * studios" (④ = `admin`) and "Joined studios" (⑤ = `creator`/`member`) via
 * `splitStudios` (spec §0.2,
 * transfer-safe). The rail lists ONLY the viewer's own studios (the server's
 * `GET /studios` filters to active memberships — a stranger's studio never
 * appears here, invariant #1).
 * @param props the viewer's studios, the active slug and the create handler.
 * @param props.studios the viewer's studios.
 * @param props.activeSlug the active studio slug, or null on Recent.
 * @param props.onCreateProject opens the create-project dialog.
 * @returns the studio rail navigation.
 */
export function StudioRail({
  studios,
  activeSlug,
  onCreateProject,
}: StudioRailProps): React.JSX.Element {
  const t = useTranslation();
  const { owned, joined } = splitStudios(studios);
  return (
    <nav
      aria-label={t('studio.rail.navLabel')}
      className='flex w-60 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border bg-background p-3'
    >
      <RailCreateActions
        createProjectLabel={t('studio.rail.createProject')}
        createCollectionLabel={t('studio.rail.createCollection')}
        createStudioLabel={t('studio.rail.createStudio')}
        comingSoonLabel={t('studio.rail.comingSoon')}
        onCreateProject={onCreateProject}
      />

      <hr className='my-0.5 border-border' />

      <RailRecentLink label={t('studio.rail.recent')} active={activeSlug === null} />

      <hr className='my-0.5 border-border' />

      <RailStudioGroup
        title={t('studio.rail.myStudios')}
        studios={owned}
        activeSlug={activeSlug}
        emptyText={t('studio.rail.myStudiosEmpty')}
        collapseKey='rail.myStudios'
      />

      <hr className='my-0.5 border-border' />

      <RailStudioGroup
        title={t('studio.rail.joinedStudios')}
        studios={joined}
        activeSlug={activeSlug}
        emptyText={t('studio.rail.joinedEmpty')}
        collapseKey='rail.joinedStudios'
      />
    </nav>
  );
}
