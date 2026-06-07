// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';

import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { ThemeToggle } from '@web/features/preferences/ThemeToggle';
import { useTranslation } from '@web/i18n/use-translation';
import { StudioChromeIconButton } from '@web/pages/studio/shell/StudioChromeIconButton';

/**
 * Studio top bar (spec §5) — the app chrome above every studio screen (48px),
 * shared by the Recent landing and the studio container via `StudioLayout`.
 * After the navigation rework the studio switcher moved OUT of the top bar and
 * into the persistent left rail, so the top bar is now identical on every
 * studio page and takes no props: left = logo + "Breatic"; right = language /
 * theme / notifications (placeholder) / avatar. Brand color is only on the logo
 * mark (chrome-baseline monochrome rule); the rest is neutral.
 * @returns the studio top bar header.
 */
export function StudioTopBar(): React.JSX.Element {
  const t = useTranslation();
  return (
    <header
      role='banner'
      className='flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4'
    >
      <Link
        to='/studio'
        aria-label={t('studio.topBar.home')}
        className='flex items-center gap-2'
      >
        <span className='flex h-7 w-7 items-center justify-center rounded-md bg-[var(--brand-logo-primary)] text-sm font-semibold text-[var(--brand-fg)]'>
          b
        </span>
        <span className='text-sm font-semibold text-foreground'>Breatic</span>
      </Link>
      <div className='flex items-center gap-1'>
        <LangSwitcher />
        <ThemeToggle />
        <StudioChromeIconButton
          icon={Bell}
          label={t('studio.topBar.notifications')}
        />
        <div
          className='ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground'
          aria-hidden='true'
        >
          A
        </div>
      </div>
    </header>
  );
}
