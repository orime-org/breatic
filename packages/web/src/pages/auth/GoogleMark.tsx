// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import '@fontsource/google-sans/500.css';

/** The mark's four colours, fixed by Google's branding guidelines in both themes. */
const MARK = {
  red: '#EA4335', // design-value: allow
  blue: '#4285F4', // design-value: allow
  yellow: '#FBBC05', // design-value: allow
  green: '#34A853', // design-value: allow
} as const;

/**
 * The look of every "Continue with Google" button, on the web pages and in the
 * desktop client (inner#2157, inner#2041): Google's pill in the page theme's
 * colours (tokens.css), Google Sans, the mark and the label centred together,
 * and the hover Google's own button shows.
 */
export const GOOGLE_BUTTON_CLASS =
  'relative inline-flex h-10 w-full items-center justify-center gap-2.5 rounded-full border border-(--google-button-stroke) bg-(--google-button-fill) px-3 [font-family:Google_Sans,var(--font-sans)] text-sm font-medium leading-5 text-(--google-button-text) hover-enabled:border-(--google-button-hover-stroke) hover-enabled:bg-(--google-button-hover) disabled:cursor-not-allowed disabled:opacity-50';

/** The mark's size; Button gives the same classes to the spinner that replaces it. */
export const GOOGLE_MARK_CLASS = 'size-[18px] shrink-0';

/**
 * Google's standard multicolour "G", drawn as Google's branding guidelines give it.
 * @param props - The mark's classes.
 * @param props.className - Its size.
 * @returns The mark.
 */
export function GoogleMark({ className }: { className: string }): React.JSX.Element {
  return (
    <svg aria-hidden='true' viewBox='0 0 48 48' className={className}>
      <path fill={MARK.red} d='M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z' />
      <path fill={MARK.blue} d='M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z' />
      <path fill={MARK.yellow} d='M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z' />
      <path fill={MARK.green} d='M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z' />
    </svg>
  );
}
