// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Clock, Search } from 'lucide-react';

import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { ThemeToggle } from '@web/features/preferences/ThemeToggle';
import { useTranslation } from '@web/i18n/use-translation';
import { StudioChromeIconButton } from '@web/pages/studio/shell/StudioChromeIconButton';

/**
 * Studio top bar — the app chrome shown above every studio screen (spec §2.1
 * TopBar, 48px). Left: brand logo + a studio switcher (slice 2 shows the
 * static "Recent" entry; interactive switching lands with the studio
 * container in a later slice). Right: search + the language / theme
 * switchers + the user avatar. Brand color is used only on the logo +
 * switcher recent-icon (spec §1.2 studio brand exemption); the tool icons
 * stay neutral. The language / theme switchers are the SAME shared
 * `features/preferences` components the project top bar uses — identical
 * look and behavior (user 2026-06-05: align studio's lang/theme buttons
 * with project, appearance included, not just the logic).
 * @returns the studio top bar header.
 */
export function StudioTopBar(): React.JSX.Element {
  const t = useTranslation();
  return (
    <header
      role='banner'
      className='flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4'
    >
      <div className='flex items-center gap-2'>
        <Link
          to='/studio'
          aria-label={t('studio.topBar.home')}
          className='flex h-7 w-7 items-center justify-center rounded-md bg-[var(--brand-accent)] text-sm font-semibold text-[var(--brand-fg)]'
        >
          b
        </Link>
        <button
          type='button'
          className='flex items-center gap-1.5 rounded-chrome px-2 py-1 text-sm font-medium transition-colors hover:bg-muted'
        >
          <span className='flex h-5 w-5 items-center justify-center rounded-md bg-[var(--brand-tint)] text-[var(--brand-accent)]'>
            <Clock className='h-3.5 w-3.5' />
          </span>
          {t('studio.topBar.recent')}
          <ChevronDown className='h-4 w-4 text-muted-foreground' />
        </button>
      </div>
      <div className='flex items-center gap-1'>
        <StudioChromeIconButton icon={Search} label={t('studio.topBar.search')} />
        <LangSwitcher />
        <ThemeToggle />
        <div
          className='ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-700'
          aria-hidden='true'
        >
          A
        </div>
      </div>
    </header>
  );
}
