// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

interface TopBarProps {
  /** The bar's two ends: what goes on the left, then what goes on the right. */
  children: React.ReactNode;
  /** Test hook for the bar itself. */
  testId?: string;
}

/**
 * The 40px page bar along the top of the Studio and the sign-in pages: a
 * hairline underneath, its two children pushed to either end.
 * @param props - Top bar props.
 * @param props.children - The left end, then the right end.
 * @param props.testId - Test hook for the bar itself.
 * @returns the page bar.
 */
export function TopBar({ children, testId }: TopBarProps): React.JSX.Element {
  return (
    <header
      role='banner'
      data-testid={testId}
      className='flex h-10 shrink-0 items-center justify-between border-b border-border bg-background px-4'
    >
      {children}
    </header>
  );
}
