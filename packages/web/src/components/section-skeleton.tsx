// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';

/**
 * What a section shows while its read is in flight.
 *
 * Bars rather than a spinner: the layout does not depend on the answer, so
 * the reader is already looking at the right place when it arrives. Shared by
 * the credits overlay and the membership panel, so the two load the same way.
 * @returns The placeholder.
 */
export function SectionSkeleton(): React.JSX.Element {
  return (
    <div className='flex flex-col gap-3' data-testid='section-skeleton'>
      <Skeleton className='h-3.5 w-40' />
      <Skeleton className='h-3.5 w-full' />
      <Skeleton className='h-3.5 w-5/6' />
      <Skeleton className='h-3.5 w-2/3' />
    </div>
  );
}
