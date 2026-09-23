// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { OFFICIAL_HOME_URL } from '@web/lib/official-home';
import type * as React from 'react';

import { BrandMark } from '@web/ui/BrandMark';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Project top-bar logo — opens the official Breatic home page in a new tab.
 * The shared `BrandMark` also appears in the Studio top bar; this wrapper
 * adds the home link and its accessible name.
 * @returns the brand logo as a home link wrapping the shared brand mark.
 */
export function Logo28(): React.JSX.Element {
  const t = useTranslation();
  return (
    <a
      href={OFFICIAL_HOME_URL}
      target='_blank'
      rel='noopener noreferrer'
      aria-label={t('chrome.aria.home')}
      className='inline-flex items-center'
    >
      <BrandMark size={28} />
    </a>
  );
}
