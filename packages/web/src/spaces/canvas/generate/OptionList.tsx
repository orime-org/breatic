// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { ParamOption } from '@web/spaces/canvas/generate/ParamOptionGroup';

/**
 * How tall the list stands, counted in rows.
 *
 * The height is the same in every state of the list (the voice list, the audio panel's option lists and the sample
 * language list): a full result set scrolls inside it,
 * a short one leaves the space below empty, and the loading and empty lines
 * centre in it. The audio settings popover opens upward, so a box there that
 * grew and shrank with its contents would take the search box with it, out from under the user's
 * hands — and on every keystroke, since each one restarts the request.
 */
const LIST_ROWS = 5;

/** A row's height on a real browser: `size='menu-item'` around two lines. */
const ROW_HEIGHT = 46;
/** The `gap-0.5` between two rows. */
const ROW_GAP = 2;

/** The `p-1` the rows sit inside, top and bottom. */
const LIST_PADDING = 4;

/**
 * The one height every state of this list stands at.
 *
 * Counts the padding as well as the rows: the box is `border-box`, so a height
 * of just the rows has its own inset taken out of that same number and the
 * last row comes up a padding short of a row.
 */
export const LIST_BODY_HEIGHT = `${
  LIST_ROWS * ROW_HEIGHT + (LIST_ROWS - 1) * ROW_GAP + 2 * LIST_PADDING
}px`;

interface OptionListProps {
  /** Every option, in the order the model declares them. */
  options: readonly ParamOption[];
  /** The option held, if any. */
  value: string | number | undefined;
  /** Called with the picked option's value. */
  onPick: (value: string | number) => void;
  /** What the search box says before anything is typed. */
  searchPlaceholder: string;
  /** Prefix of each row's test id. */
  testIdPrefix: string;
}

/**
 * A choice too long to lay out as buttons, as a searchable list (#2156,
 * design §16): the voice list's shape and height, filtered here because the
 * options are all on hand.
 * @param root0 - Props.
 * @param root0.options - The options.
 * @param root0.value - The option held.
 * @param root0.onPick - Called with the picked value.
 * @param root0.searchPlaceholder - The search box's placeholder.
 * @param root0.testIdPrefix - Prefix of each row's test id.
 * @returns The list.
 */
export function OptionList({
  options,
  value,
  onPick,
  searchPlaceholder,
  testIdPrefix,
}: OptionListProps): React.JSX.Element {
  const t = useTranslation();
  const [query, setQuery] = React.useState('');
  const shown = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle === ''
      ? options
      : options.filter((o) => o.label.toLocaleLowerCase().includes(needle));
  }, [options, query]);
  return (
    <div className='flex flex-col'>
      <div className='border-b border-border p-2'>
        <Input
          autoComplete='off'
          data-testid={`${testIdPrefix}-search`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          className='h-8 text-sm'
        />
      </div>
      <div className='p-1' style={{ height: LIST_BODY_HEIGHT }}>
        {shown.length === 0 ? (
          <p className='flex h-full items-center justify-center text-sm text-muted-foreground'>
            {t('canvas.generatePanel.audioOptionEmpty')}
          </p>
        ) : (
          <ScrollArea className='h-full'>
            <div className='flex flex-col gap-0.5'>
              {shown.map((option) => {
                const chosen = option.value === value;
                return (
                  <Button
                    key={String(option.value)}
                    type='button'
                    variant='ghost'
                    size='menu-item'
                    aria-pressed={chosen}
                    data-testid={`${testIdPrefix}-${String(option.value)}`}
                    className={cn('justify-start', chosen && 'bg-accent-strong hover-enabled:bg-accent-strong')}
                    onClick={() => onPick(option.value)}
                  >
                    <span className='truncate'>{option.label}</span>
                  </Button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
