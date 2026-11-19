// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from 'react';

import { CountChip } from '@web/components/CountChip';
import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';

/** One filter of an Open / All pair. */
interface FilterButtonProps {
  /** Its test hook; its count chip takes the same hook with `-count`. */
  testId: string;
  /** Whether this filter is in force. */
  on: boolean;
  label: string;
  /** How many items it shows; zero shows no chip. */
  count: number;
  onPress: () => void;
}

/**
 * One of the Open / All filter buttons over a list of comments (Document's comment panel, Motion's annotation panel):
 * the one in force on the chosen fill, the other muted, each with its count in a chip.
 * @param props - The filter.
 * @param props.testId - Its test hook.
 * @param props.on - Whether it is in force.
 * @param props.label - What it says.
 * @param props.count - How many items it shows.
 * @param props.onPress - Switches to it.
 * @returns The button.
 * @throws {never} Never.
 */
export function FilterButton({ testId, on, label, count, onPress }: FilterButtonProps): React.JSX.Element {
  return (
    <Button
      variant={null}
      size={null}
      aria-pressed={on}
      data-testid={testId}
      onClick={onPress}
      className={cn(
        'gap-1 rounded-chrome px-2 py-0.5 text-2xs',
        on
          ? 'bg-accent-strong text-foreground'
          : 'text-muted-foreground hover-enabled:bg-accent hover-enabled:text-foreground',
      )}
    >
      {label}
      {count === 0 ? null : (
        <CountChip count={count} className='px-1 text-2xs leading-4' data-testid={`${testId}-count`} />
      )}
    </Button>
  );
}
