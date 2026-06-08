// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Menu } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@web/components/ui/sheet';
import { useTranslation } from '@web/i18n/use-translation';
import { StudioRailContent } from '@web/pages/studio/rail/StudioRailContent';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';
import { BrandMark } from '@web/ui/BrandMark';

interface StudioRailDrawerProps {
  /** The viewer's own studios (from `GET /studios`), each with `myStudioRole`. */
  studios: readonly StudioSummary[];
  /** The active studio slug, or `null` when on the cross-studio Recent view. */
  activeSlug: string | null;
  /** Opens the create-project dialog (rail segment ①). */
  onCreateProject: () => void;
}

/**
 * Narrow-screen studio rail drawer — the hamburger button (shown only below
 * `md`, in the top bar's leading slot) opening a left Sheet with the same
 * `StudioRailContent` as the persistent desktop rail. Closes automatically on
 * navigation (route change) so tapping a rail link doesn't leave the drawer
 * covering the routed content (standard mobile-web drawer behavior).
 * @param props the viewer's studios, active slug and create handler.
 * @param props.studios the viewer's studios.
 * @param props.activeSlug the active studio slug, or null on Recent.
 * @param props.onCreateProject opens the create-project dialog.
 * @returns the hamburger button + rail drawer (hidden at `md` and up).
 */
export function StudioRailDrawer({
  studios,
  activeSlug,
  onCreateProject,
}: StudioRailDrawerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const location = useLocation();

  // Close the drawer on navigation so tapping a rail link doesn't leave the
  // sheet covering the content.
  React.useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type='button'
          aria-label={t('studio.rail.openNav')}
          className='flex h-7 w-7 items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden'
        >
          <Menu className='h-[18px] w-[18px]' />
        </button>
      </SheetTrigger>
      <SheetContent
        side='left'
        aria-describedby={undefined}
        className='flex w-64 flex-col gap-0.5 overflow-y-auto p-2'
        data-testid='studio-rail-drawer'
      >
        <SheetTitle className='sr-only'>{t('studio.rail.navLabel')}</SheetTitle>
        {/* Drawer header — brand on the left; the vendor Sheet close (X,
            absolute right-3 top-3) lands in the pr-10 gap on the right, so it
            gets its own row instead of overlapping the first rail item. */}
        <div className='mb-1 flex h-9 shrink-0 items-center pl-1.5 pr-10'>
          <Link
            to='/studio'
            aria-label={t('studio.topBar.home')}
            className='flex items-center gap-[7px]'
          >
            <BrandMark size={24} />
            <span className='text-sm font-semibold text-foreground'>
              Breatic
            </span>
          </Link>
        </div>
        <StudioRailContent
          studios={studios}
          activeSlug={activeSlug}
          onCreateProject={onCreateProject}
        />
      </SheetContent>
    </Sheet>
  );
}
