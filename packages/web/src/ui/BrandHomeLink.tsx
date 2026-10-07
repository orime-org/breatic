// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { OFFICIAL_HOME_URL } from '@web/lib/official-home';
import { BrandMark } from '@web/ui/BrandMark';

/**
 * The logo and "Breatic" at the left of a page header, opening the official
 * website in a new tab. Shared by the Studio top bar and every page framed by
 * `AuthCardShell`.
 * @returns the brand link.
 */
export function BrandHomeLink(): React.JSX.Element {
  const t = useTranslation();
  return (
    <a
      href={OFFICIAL_HOME_URL}
      target='_blank'
      rel='noopener noreferrer'
      aria-label={t('chrome.aria.home')}
      className='flex items-center gap-[7px] rounded-chrome-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
    >
      <BrandMark size={24} />
      <span className='text-sm font-semibold text-foreground'>Breatic</span>
    </a>
  );
}
