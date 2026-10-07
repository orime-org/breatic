// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { ChevronDown, LayoutGrid, List, Plus } from 'lucide-react';
import type { StudioProjectSort } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import type { ProjectListView } from '@web/pages/studio/container/container-types';

/**
 * The create entry: a label whenever the tab can create at all, and the
 * opener when this viewer may. A tab nothing is created from (Archived)
 * passes neither.
 */
type ContainerToolbarCreate =
  | {
      /** Localized create-button label ("New project" / "New collection"). */
      createLabel: string;
      /**
       * Opens the create dialog. When omitted (a guest, who cannot create), the
       * create button is hidden — the rest of the toolbar still shows.
       */
      onCreate?: () => void;
    }
  | { createLabel?: never; onCreate?: never };

/** The sort control: the list's sorts, the current one, and a change. */
export interface ToolbarSort {
  value: StudioProjectSort;
  options: readonly StudioProjectSort[];
  onChange: (sort: StudioProjectSort) => void;
}

/** The layout control: the current layout and a change. */
export interface ToolbarView {
  value: ProjectListView;
  onChange: (view: ProjectListView) => void;
}

type ContainerToolbarProps = ContainerToolbarCreate & {
  /** Section title (the localized tab name). */
  title: string;
  /** Item count shown in the muted chip after the title; `null` hides the chip. */
  count: number | null;
  /** A working sort control (the project lists). */
  sort?: ToolbarSort;
  /** A working grid/list switch (the project lists). */
  view?: ToolbarView;
  /**
   * Whether to show the disabled sort + grid/list placeholders where no working
   * control is given. Default `true` (Collections, whose sorting and layout
   * come with the collections feature). The Members tab passes `false`.
   */
  showViewControls?: boolean;
};

const CONTROL =
  'inline-flex h-[30px] items-center gap-1.5 rounded-chrome border border-border px-2.5 text-xs font-medium text-foreground';
const VIEW_BUTTON =
  'flex h-[30px] w-[30px] items-center justify-center rounded-none text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-muted aria-pressed:text-foreground';

/**
 * The Projects / Collections / Archived tab toolbar (locked mock `.toolbar`):
 * a title + count chip on the left, then the sort control, the grid/list view
 * switch, and the create button on the right. The project lists pass working
 * `sort` and `view` controls; Collections still shows disabled placeholders,
 * whose sorting and layout come with the collections feature. The create CTA
 * uses the shared `bg-primary` token, which is `--neutral-900` (black in light
 * / white in dark — tokens.css), matching the mock `.btn` neutral button and
 * every other studio CTA.
 * @param root0 - Component props.
 * @param root0.title - the section title (localized tab name).
 * @param root0.count - the item count, or null to hide the chip.
 * @param root0.createLabel - the create-button label (absent on a tab nothing is created from).
 * @param root0.onCreate - opens the create dialog (omit to hide the button).
 * @param root0.sort - a working sort control.
 * @param root0.view - a working grid/list switch.
 * @param root0.showViewControls - whether to show the disabled placeholders where no working control is given (default true; the Members tab passes false).
 * @returns the tab toolbar.
 */
export function ContainerToolbar({
  title,
  count,
  createLabel,
  onCreate,
  sort,
  view,
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
        {count !== null ? (
          <span
            data-testid='container-toolbar-count'
            className='rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground'
          >
            {count}
          </span>
        ) : null}
      </h2>
      <div className='flex-1' />
      {sort ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type='button' variant={null} size={null} className={`${CONTROL} hover:bg-accent`}>
              <span className='font-normal text-muted-foreground'>
                {t('studio.container.toolbar.sortLabel')}
              </span>
              {t(`studio.container.toolbar.sort.${sort.value}`)}
              <ChevronDown className='h-3 w-3 text-muted-foreground' aria-hidden='true' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuRadioGroup
              value={sort.value}
              onValueChange={(value) => {
                const next = sort.options.find((option) => option === value);
                if (next) sort.onChange(next);
              }}
            >
              {sort.options.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {t(`studio.container.toolbar.sort.${option}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {view ? (
        <div className='inline-flex overflow-hidden rounded-chrome border border-border'>
          <Button
            type='button'
            variant={null}
            size={null}
            aria-label={t('studio.container.toolbar.view.grid')}
            aria-pressed={view.value === 'grid'}
            onClick={() => view.onChange('grid')}
            className={VIEW_BUTTON}
          >
            <LayoutGrid className='h-3.5 w-3.5' aria-hidden='true' />
          </Button>
          <Button
            type='button'
            variant={null}
            size={null}
            aria-label={t('studio.container.toolbar.view.list')}
            aria-pressed={view.value === 'list'}
            onClick={() => view.onChange('list')}
            className={VIEW_BUTTON}
          >
            <List className='h-3.5 w-3.5' aria-hidden='true' />
          </Button>
        </div>
      ) : null}
      {!sort && !view && showViewControls ? (
        <>
          <Button
            type='button'
            disabled
            aria-label={notAvailable}
            variant={null}
            size={null}
            className={`${CONTROL} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <span className='font-normal text-muted-foreground'>
              {t('studio.container.toolbar.sortLabel')}
            </span>
            {t('studio.container.toolbar.sortValue')}
            <ChevronDown
              className='h-3 w-3 text-muted-foreground'
              aria-hidden='true'
            />
          </Button>
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
