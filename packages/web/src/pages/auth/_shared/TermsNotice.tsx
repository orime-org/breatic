// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { PRIVACY_URL, TERMS_URL } from '@web/lib/official-home';
import { renderSlottedText, slotMarker } from '@web/lib/slotted-text';

/** The same treatment as the card's own footer link (`AuthLink`), at this line's size. */
const LINK_CLASS = 'font-medium text-foreground underline-offset-4 hover:underline';

/**
 * The terms line at the foot of the sign-in and sign-up cards (#302).
 *
 * Continuing from either card is what creates an account, so this is where
 * the reader agrees to the terms. The documents open in a new tab, which keeps
 * whatever the reader has already typed into the card.
 * @returns The line, with both documents linked.
 */
export function TermsNotice(): React.JSX.Element {
  const t = useTranslation();
  const sentence = t('auth.terms.notice', {
    terms: slotMarker('terms'),
    privacy: slotMarker('privacy'),
  });
  return (
    <p data-testid='auth-terms-notice' className='mt-3 text-center text-xs text-muted-foreground'>
      {renderSlottedText(sentence, {
        terms: (
          <a href={TERMS_URL} target='_blank' rel='noreferrer' className={LINK_CLASS}>
            {t('auth.terms.termsLink')}
          </a>
        ),
        privacy: (
          <a href={PRIVACY_URL} target='_blank' rel='noreferrer' className={LINK_CLASS}>
            {t('auth.terms.privacyLink')}
          </a>
        ),
      })}
    </p>
  );
}
