// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowUp, Star } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';

/**
 * The bottom row of a panel that runs something on its node: what the run
 * costs on the left, Run on the right.
 *
 * The mini-tool panel and the transcribe panel both end on it, so a reader
 * moving between them presses the same button in the same place.
 */
export interface PanelRunFooterProps {
  /** What the run costs, as the reader reads it. */
  creditText: string;
  /** Run's accessible name. */
  runLabel: string;
  /** Whether Run takes no press. */
  disabled: boolean;
  /** Whether a press is still waiting. */
  loading: boolean;
  /** Runs it. */
  onRun: () => void;
  /** Test hook for the cost text. */
  creditTestId: string;
  /** Test hook for Run. */
  runTestId: string;
  /** Controls set beside the cost, at the other end of the row from Run. */
  children?: React.ReactNode;
}

/**
 * Renders the row.
 * @param props - What the row shows and what Run does.
 * @param props.creditText - What the run costs.
 * @param props.runLabel - Run's accessible name.
 * @param props.disabled - Whether Run takes no press.
 * @param props.loading - Whether a press is still waiting.
 * @param props.onRun - Runs it.
 * @param props.creditTestId - Test hook for the cost text.
 * @param props.runTestId - Test hook for Run.
 * @param props.children - Controls beside the cost.
 * @returns The footer row.
 */
export function PanelRunFooter({
  creditText,
  runLabel,
  disabled,
  loading,
  onRun,
  creditTestId,
  runTestId,
  children,
}: PanelRunFooterProps): React.JSX.Element {
  return (
    <div className='flex items-center justify-between gap-1.5 border-t border-border px-3 py-2'>
      <div className='flex items-center gap-3'>
        <span
          data-testid={creditTestId}
          className='flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground'
        >
          <Star className='h-3.5 w-3.5' aria-hidden='true' />
          {creditText}
        </span>
        {children}
      </div>
      <Button
        type='button'
        variant={null}
        size={null}
        data-testid={runTestId}
        aria-label={runLabel}
        disabled={disabled}
        loading={loading}
        icon={<ArrowUp className='h-4 w-4' aria-hidden='true' />}
        onClick={onRun}
        className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover-enabled:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
      />
    </div>
  );
}
