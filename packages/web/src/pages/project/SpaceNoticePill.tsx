// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@web/lib/utils';

type SpaceNoticePillProps = Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> & {
  /** Which status colour the surface takes. */
  tone: 'info' | 'warning';
  /** The icon before the sentence. */
  icon: LucideIcon;
  /** The sentence. */
  children: React.ReactNode;
  /** Rendered after the sentence, inside the surface (the read-only notice's reconnect control). */
  extra?: React.ReactNode;
};

const TONE_CLASSES = {
  info: 'border-status-info-border bg-status-info-bg text-status-info-foreground',
  warning: 'border-status-warning-border bg-status-warning-bg text-status-warning-foreground',
} as const;

/**
 * The pill the top-centre Space notices share (`SpaceReadOnlyNotice`,
 * `SpaceSizeNotice`). The status `-bg` tokens are 14% tints, so the outer
 * element is opaque and the tint sits on the surface inside it, as in
 * `ConnectionBanner`: canvas content under the pill never shows through. The
 * sentence wraps when the Space column is narrow, so it is always whole.
 * Props other than `tone`, `icon`, `children` and `extra` go to the outer
 * element.
 * @param root0 - Props.
 * @param root0.tone - Which status colour the surface takes.
 * @param root0.icon - The icon before the sentence.
 * @param root0.children - The sentence.
 * @param root0.extra - Rendered after the sentence, inside the surface.
 * @param root0.className - Merged into the outer element's classes.
 * @returns The pill.
 * @throws {never} Never.
 */
export function SpaceNoticePill({ tone, icon: Icon, children, extra, className, ...rest }: SpaceNoticePillProps): React.JSX.Element {
  return (
    <div {...rest} className={cn('max-w-full rounded-overlay bg-background shadow-md', className)}>
      <div className={cn('flex items-center gap-2 rounded-overlay border px-3.5 py-1.5 text-sm', TONE_CLASSES[tone])}>
        <Icon className='h-4 w-4 shrink-0' aria-hidden />
        <span className='text-balance font-medium'>{children}</span>
        {extra}
      </div>
    </div>
  );
}
