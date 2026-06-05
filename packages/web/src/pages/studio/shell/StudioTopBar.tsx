// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Clock, Globe, Moon, Search } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';

interface ToolButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

/**
 * A neutral 32x32 chrome icon button for the top-bar tool cluster (search /
 * language / theme). Stays monochrome per F10 — only the logo + switcher use
 * brand color; the search / language / theme tool icons stay neutral
 * (spec 1.2 brand whitelist).
 * @param root0 - component props
 * @param root0.icon - the lucide icon component to render
 * @param root0.label - accessible label (also the tooltip text)
 * @returns the icon button.
 */
function ToolButton({ icon: Icon, label }: ToolButtonProps): React.JSX.Element {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      className='flex h-8 w-8 items-center justify-center rounded-chrome text-neutral-600 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
    >
      <Icon className='h-[18px] w-[18px]' />
    </button>
  );
}

/**
 * Studio top bar — the app chrome shown above every studio screen (spec §2.1
 * TopBar, 48px). Left: brand logo + a studio switcher (slice 2 shows the
 * static "Recent" entry; interactive switching lands with the studio
 * container in a later slice). Right: search / language / theme tool icons +
 * the user avatar. Brand color is used only on the logo + switcher
 * recent-icon (spec §1.2 studio brand exemption); tools stay neutral.
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
          to='/studio/recent'
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
        <ToolButton icon={Search} label={t('studio.topBar.search')} />
        <ToolButton icon={Globe} label={t('studio.topBar.language')} />
        <ToolButton icon={Moon} label={t('studio.topBar.theme')} />
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
