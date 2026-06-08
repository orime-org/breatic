// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { BellMenu } from '@web/features/notifications/BellMenu';
import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { ThemeToggle } from '@web/features/preferences/ThemeToggle';
import { useTranslation } from '@web/i18n/use-translation';
import { StudioAccountMenu } from '@web/pages/studio/shell/StudioAccountMenu';
import { BrandMark } from '@web/ui/BrandMark';

interface StudioTopBarProps {
  /**
   * Optional leading slot rendered before the logo — the narrow-screen rail
   * hamburger (`StudioRailDrawer`), which hides itself at `md` and up.
   */
  leading?: React.ReactNode;
}

/**
 * Studio top bar (spec §5) — the app chrome above every studio screen (40px,
 * matching the project top bar + the neutral mock), shared by the Recent
 * landing and the studio container via `StudioLayout`. Left = optional
 * `leading` slot (the narrow-screen rail hamburger) + logo + "Breatic"; right =
 * language / theme / notifications (`BellMenu`, shared with the project chrome)
 * / account avatar. Brand color is only on the logo mark (chrome-baseline
 * monochrome rule); the rest is neutral.
 * @param props the top bar props.
 * @param props.leading optional leading slot before the logo (rail hamburger).
 * @returns the studio top bar header.
 */
export function StudioTopBar({ leading }: StudioTopBarProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <header
      role='banner'
      className='flex h-10 shrink-0 items-center justify-between border-b border-border bg-background px-4'
    >
      <div className='flex items-center gap-1'>
        {leading}
        <Link
          to='/studio'
          aria-label={t('studio.topBar.home')}
          className='flex items-center gap-[7px]'
        >
          <BrandMark size={24} />
          <span className='text-sm font-semibold text-foreground'>Breatic</span>
        </Link>
      </div>
      <div className='flex items-center gap-1'>
        <LangSwitcher />
        <ThemeToggle />
        <BellMenu />
        <StudioAccountMenu />
      </div>
    </header>
  );
}
