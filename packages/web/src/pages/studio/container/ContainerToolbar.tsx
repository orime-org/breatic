// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { ChevronDown, LayoutGrid, List, Plus } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

interface ContainerToolbarProps {
  /** Section title (the localized tab name). */
  title: string;
  /** Item count shown in the muted chip after the title. */
  count: number;
  /** Localized create-button label ("New project" / "New collection"). */
  createLabel: string;
  /**
   * Opens the create dialog. When omitted (a guest, who cannot create), the
   * create button is hidden — the rest of the toolbar still shows.
   */
  onCreate?: () => void;
  /**
   * Whether to show the sort + grid/list view-toggle placeholders. Default
   * `true` (projects / collections). The Members tab passes `false` — a member
   * list has no grid/list view, so it shows only the title + count + the
   * invite button.
   */
  showViewControls?: boolean;
}

/**
 * The Projects / Collections tab toolbar (locked mock `.toolbar`): a title + count
 * chip on the left, then the sort control, the grid/list view toggle, and the
 * create button on the right. Per the B-scope visual slice, **sort + view toggle
 * are disabled placeholders** (those features ship later) — they convey the
 * layout without being wired; only the create button is live. The create CTA
 * uses the shared `bg-primary` token, which is `--neutral-900` (black in light
 * / white in dark — tokens.css), matching the mock `.btn` neutral button and
 * every other studio CTA.
 * @param root0 - Component props.
 * @param root0.title - the section title (localized tab name).
 * @param root0.count - the item count.
 * @param root0.createLabel - the create-button label.
 * @param root0.onCreate - opens the create dialog (omit to hide the button).
 * @param root0.showViewControls - whether to show the sort + grid/list view-toggle placeholders (default true; the Members tab passes false).
 * @returns the tab toolbar.
 */
export function ContainerToolbar({
  title,
  count,
  createLabel,
  onCreate,
  showViewControls = true,
}: ContainerToolbarProps): React.JSX.Element {
  const t = useTranslation();
  // Disabled placeholders read as "not available" to assistive tech (the
  // control genuinely is not wired yet) — reuses the space-picker key, so this
  // adds no new locale strings.
  const notAvailable = t('spaces.create.notAvailable');
  return (
    <div
      data-testid='container-toolbar'
      className='mb-[18px] flex items-center gap-2'
    >
      <h2 className='flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground'>
        {title}
        <span className='rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground'>
          {count}
        </span>
      </h2>
      <div className='flex-1' />
      {showViewControls ? (
        <>
          <button
            type='button'
            disabled
            aria-label={notAvailable}
            className='inline-flex h-[30px] items-center gap-1.5 rounded-chrome border border-border px-2.5 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50'
          >
            <span className='font-normal text-muted-foreground'>
              {t('studio.container.toolbar.sortLabel')}
            </span>
            {t('studio.container.toolbar.sortValue')}
            <ChevronDown
              className='h-3 w-3 text-muted-foreground'
              aria-hidden='true'
            />
          </button>
          <div
            className='inline-flex overflow-hidden rounded-chrome border border-border opacity-50'
            aria-hidden='true'
          >
            <span className='flex h-[30px] w-[30px] items-center justify-center bg-muted text-foreground'>
              <LayoutGrid className='h-3.5 w-3.5' />
            </span>
            <span className='flex h-[30px] w-[30px] items-center justify-center text-muted-foreground'>
              <List className='h-3.5 w-3.5' />
            </span>
          </div>
        </>
      ) : null}
      {onCreate ? (
        <Button
          type='button'
          onClick={onCreate}
          className='h-[30px] gap-1.5 rounded-chrome px-3 text-xs font-semibold'
        >
          <Plus className='h-3.5 w-3.5' aria-hidden='true' />
          {createLabel}
        </Button>
      ) : null}
    </div>
  );
}
