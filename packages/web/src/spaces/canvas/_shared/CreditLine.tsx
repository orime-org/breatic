// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { KeyRound, Star } from 'lucide-react';
import type * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';

/** What a run's cost line shows. */
export interface CreditLineProps {
  /** A credit figure, or the short name of the key a run uses. */
  text: string;
  /**
   * The full sentence for a run on a key (inner#1953), shown on hover; present only then, and it puts the key mark in
   * place of the credits star.
   */
  detail?: string;
  /** Test hook. */
  testId: string;
  className?: string;
}

/**
 * The cost beside a run button, on one line: a credit figure behind the credits star, or the key a run uses behind the
 * key mark of the BYOK settings entry, with what that means on hover.
 * @param props - The line.
 * @param props.text - The figure or the key's short name.
 * @param props.detail - On a key, the full sentence shown on hover.
 * @param props.testId - Test hook.
 * @param props.className - Extra classes for the line.
 * @returns The line.
 */
export function CreditLine({ text, detail, testId, className }: CreditLineProps): React.JSX.Element {
  const line = (
    <span
      data-testid={testId}
      className={cn('flex items-center gap-0.5 whitespace-nowrap text-xs font-medium tabular-nums text-muted-foreground', className)}
    >
      {detail === undefined
        ? <Star data-icon='credits' className='h-3.5 w-3.5' aria-hidden='true' />
        : <KeyRound data-icon='key' className='h-3.5 w-3.5' aria-hidden='true' />}
      {text}
    </span>
  );
  if (detail === undefined) return line;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}
