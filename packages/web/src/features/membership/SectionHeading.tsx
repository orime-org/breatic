// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/**
 * A muted section heading, matching the settings tab's own.
 * @param props - The heading's text.
 * @param props.children - The heading's text.
 * @returns The heading.
 */
export function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h3 className='text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground'>
      {children}
    </h3>
  );
}
