// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Clock, Search } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { ThemeToggle } from '@web/features/preferences/ThemeToggle';
import { useTranslation } from '@web/i18n/use-translation';
import { NewStudioDialog } from '@web/pages/studio/container/dialogs/NewStudioDialog';
import { StudioChromeIconButton } from '@web/pages/studio/shell/StudioChromeIconButton';
import { StudioSwitcherPanel } from '@web/pages/studio/shell/StudioSwitcherPanel';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

/** What the top-bar switcher trigger shows when inside a studio container. */
interface SwitcherCurrentStudio {
  name: string;
}

interface StudioTopBarProps {
  /**
   * The studio the switcher trigger should display. When omitted the trigger
   * shows the cross-studio "Recent" entry (the `/studio` landing); when set it
   * shows that studio's avatar + name (the `/studio/{slug}` container).
   */
  current?: SwitcherCurrentStudio;
  /** The viewer's own studios (personal + teams), for the switcher panel. */
  studios?: readonly StudioSummary[];
  /** The active studio slug, or `null` when on the Recent view. */
  activeSlug?: string | null;
  /** The viewer's guest (shared-with-me) project count, shown in the switcher. */
  guestProjectCount?: number;
}

/**
 * Studio top bar — the app chrome shown above every studio screen (spec §2.1
 * TopBar, 48px). Left: brand logo + a studio switcher trigger (shows "Recent"
 * on the landing, or the current studio inside a container). Right: search +
 * the language / theme switchers + the user avatar. Brand color is used only
 * on the logo + switcher icon (spec §1.2 studio brand exemption); the tool
 * icons stay neutral. The language / theme switchers are the SAME shared
 * `features/preferences` components the project top bar uses — identical look
 * and behavior (user 2026-06-05: align studio's lang/theme buttons with
 * project, appearance included, not just the logic).
 * @param props optionally the current studio for the switcher trigger.
 * @param props.current the current studio shown in the switcher trigger.
 * @param props.studios the viewer's studios.
 * @param props.activeSlug the active studio slug, or null on the Recent view.
 * @param props.guestProjectCount the viewer's guest project count.
 * @returns the studio top bar header.
 */
export function StudioTopBar({
  current,
  studios = [],
  activeSlug = null,
  guestProjectCount = 0,
}: StudioTopBarProps = {}): React.JSX.Element {
  const t = useTranslation();
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [newStudioOpen, setNewStudioOpen] = React.useState(false);
  const takenSlugs = React.useMemo(
    () => new Set(studios.map((studio) => studio.slug)),
    [studios],
  );
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
        <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              aria-label={t('studio.container.switcher.myStudios')}
              className='flex items-center gap-1.5 rounded-chrome px-2 py-1 text-sm font-medium transition-colors hover:bg-muted'
            >
              <span className='flex h-5 w-5 items-center justify-center rounded-md bg-[var(--brand-tint)] text-[var(--brand-accent)]'>
                {current ? (
                  <span className='text-[0.65rem] font-semibold'>
                    {current.name.slice(0, 1).toUpperCase()}
                  </span>
                ) : (
                  <Clock className='h-3.5 w-3.5' />
                )}
              </span>
              {current ? current.name : t('studio.topBar.recent')}
              <ChevronDown className='h-4 w-4 text-muted-foreground' />
            </button>
          </PopoverTrigger>
          <PopoverContent align='start' className='w-auto p-3'>
            <StudioSwitcherPanel
              studios={studios}
              activeSlug={activeSlug}
              guestProjectCount={guestProjectCount}
              onNavigate={() => setSwitcherOpen(false)}
              onNewStudio={() => {
                setSwitcherOpen(false);
                setNewStudioOpen(true);
              }}
            />
          </PopoverContent>
        </Popover>
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
      <NewStudioDialog
        open={newStudioOpen}
        onOpenChange={setNewStudioOpen}
        takenSlugs={takenSlugs}
      />
    </header>
  );
}
