// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

/**
 * The cover a project shows until its owner uploads one: three nodes and two
 * links, drawn in `currentColor` so it follows the theme with whatever text
 * colour the cover area gives it. Built in rather than a static file, so every
 * project shares it and nothing is stored for it.
 * @returns The default cover, filling its container.
 */
export function DefaultProjectCover(): React.JSX.Element {
  return (
    <svg
      data-testid='default-project-cover'
      aria-hidden='true'
      viewBox='0 0 160 90'
      width='100%'
      height='100%'
      preserveAspectRatio='xMidYMid slice'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.2'
    >
      <g opacity='.55'>
        <path d='M52 40 C66 40 66 30 80 30' />
        <path d='M100 38 C112 38 112 52 124 52' />
      </g>
      <g opacity='.7'>
        <rect x='28' y='32' width='24' height='17' rx='2.5' />
        <rect x='80' y='21' width='20' height='26' rx='2.5' />
        <rect x='124' y='44' width='16' height='16' rx='2.5' />
      </g>
      <g fill='currentColor' stroke='none' opacity='.5'>
        <circle cx='52' cy='40' r='1.6' />
        <circle cx='80' cy='30' r='1.6' />
        <circle cx='100' cy='38' r='1.6' />
        <circle cx='124' cy='52' r='1.6' />
      </g>
    </svg>
  );
}
