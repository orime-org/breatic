// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';

/** One selectable option: what gets reported, and what the user reads. */
export interface ParamOption {
  /** Reported to `onSelect` — the catalog's own value, types intact. */
  value: string | number;
  /** What the option button shows. */
  label: string;
}

interface ParamOptionGroupProps {
  /** Section heading (e.g. Ratio / Resolution / Duration). */
  label: string;
  /** The options this parameter offers; the section renders nothing when empty. */
  options: readonly ParamOption[];
  /** The currently selected value, compared by identity against each option. */
  value: string | number | undefined;
  /** Called with the picked option's value. */
  onSelect: (value: string | number) => void;
  /** `data-testid` stem; each option appends its own value. */
  testIdPrefix: string;
  /** Extra classes on the section wrapper (spacing between stacked groups). */
  className?: string;
}

/**
 * One parameter rendered as a labelled row of options — the single shape all
 * option-style params use (user 2026-08-08: ratio, resolution and duration are
 * one form, not three).
 *
 * An empty option list renders nothing at all, which is how "the model does not
 * declare this parameter" reaches the user: the group is absent rather than
 * present and empty.
 *
 * Deliberately NOT wrapped in `React.memo`: both callers build `options` from
 * the active model during render, so the array identity changes every time and
 * a memo could never bail. Leaving one on would advertise a saving that does
 * not exist and send the next person profiling this panel looking elsewhere.
 * The pickers that own these groups ARE memoized, which is where the bail
 * actually happens.
 * @param root0 - Component props.
 * @param root0.label - Section heading.
 * @param root0.options - The offered options.
 * @param root0.value - The current selection.
 * @param root0.onSelect - Called with the picked value.
 * @param root0.testIdPrefix - `data-testid` stem for the options.
 * @param root0.className - Extra classes on the wrapper.
 * @returns The option group, or null when there is nothing to offer.
 */
export function ParamOptionGroup({
  label,
  options,
  value,
  onSelect,
  testIdPrefix,
  className,
}: ParamOptionGroupProps): React.JSX.Element | null {
  if (options.length === 0) return null;
  // max-w + truncate: catalog values carry no length cap at the sanitize
  // boundary — a verbose value must clip inside the popover, not overflow it.
  const optionClass =
    // `grow basis-12` = flex: 1 1 3rem. Each row takes as many options as fit
    // at that minimum and then stretches them to span the width, the last row
    // included — a group whose count does not divide evenly ends on a wide
    // option rather than on a narrow one beside 177px of nothing.
    'grow basis-12 ' +
    'max-w-full truncate rounded-overlay border border-border px-2 py-1 text-xs text-foreground transition-colors ' +
    'hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
    'aria-[current=true]:border-active-border aria-[current=true]:bg-accent-strong ' +
    // The whole group shares this list, so hover has to answer the same way:
    // plain hover outranks the chosen fill and would take the mark off the
    // option the pointer is on.
    'aria-[current=true]:hover:bg-accent-strong';
  return (
    <div className={className}>
      <p className='mb-1.5 text-xs font-medium text-muted-foreground'>{label}</p>
      {/*
        Rows that fill the popover's width, rather than options sized to their
        own text. Natural widths leave whatever the last row could not fit as
        dead space on the right — 75px in the ten-preset duration group, against
        the 12px padding on the left, and a different amount per row.
      */}
      <div className='flex flex-wrap gap-1.5'>
        {options.map((option) => (
          <Button
            key={String(option.value)}
            type='button'
            variant={null}
            size={null}
            data-testid={`${testIdPrefix}-${String(option.value)}`}
            aria-current={value === option.value}
            onClick={() => onSelect(option.value)}
            className={optionClass}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
