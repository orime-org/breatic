// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { StudioRailContent } from '@web/pages/studio/rail/StudioRailContent';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

interface StudioRailProps {
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
 * The persistent studio rail (spec §4) — the always-on left navigation that
 * replaces the top-bar switcher popover. On narrow screens (`< md`) the
 * persistent rail is hidden and the same content moves into a top-bar
 * hamburger drawer (`StudioRailDrawer`); the shared `StudioRailContent` keeps
 * both in sync. The rail lists ONLY the viewer's own studios (the server's
 * `GET /studios` filters to active memberships — invariant #1).
 * @param props the viewer's studios, the active slug and the create handler.
 * @param props.studios the viewer's studios.
 * @param props.activeSlug the active studio slug, or null on Recent.
 * @param props.onCreateProject opens the create-project dialog.
 * @param props.onCreateStudio opens the create-team-studio dialog.
 * @returns the persistent studio rail navigation (hidden below `md`).
 */
export function StudioRail({
  studios,
  activeSlug,
  onCreateProject,
  onCreateStudio,
}: StudioRailProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <nav
      aria-label={t('studio.rail.navLabel')}
      className='hidden w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-background p-2 md:flex'
    >
      <StudioRailContent
        studios={studios}
        activeSlug={activeSlug}
        onCreateProject={onCreateProject}
        onCreateStudio={onCreateStudio}
      />
    </nav>
  );
}
