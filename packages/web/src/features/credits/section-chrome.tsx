// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { getLocale } from '@breatic/shared';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/** The heading, the body and the fixed line under it. */
interface SectionProps {
  /** The heading. */
  title: string;
  /** The body. */
  children: React.ReactNode;
  /** A line that stays put under the body. */
  footer?: React.ReactNode;
  /**
   * Whether the body itself scrolls.
   *
   * True for a column of blocks that can outgrow the panel together. False
   * where one block holds the long thing and scrolls it inside its own
   * border — then the body only hands that block the height it has.
   */
  scrolls?: boolean;
}

/**
 * One section of the overlay: a heading, a body, a fixed foot.
 *
 * The heading and the terms under a list are about the whole section, so they
 * stay on screen. Scrolling the whole column instead carries the heading away
 * on the first turn of the wheel and hides the terms until the reader reaches
 * the end of the list.
 * @param props - The heading, the content, the fixed line and the layout.
 * @param props.title - The heading.
 * @param props.children - The body.
 * @param props.footer - A line that stays put under it.
 * @param props.scrolls - Whether the body itself scrolls.
 * @returns The section.
 */
export function Section({
  title,
  children,
  footer,
  scrolls = true,
}: SectionProps): React.JSX.Element {
  // `min-h-0` is what makes either layout work: a flex child's default
  // minimum height is its content, so without it the body grows past the
  // panel and what is below the fold becomes unreachable.
  //
  // The last row needs the panel's own bottom margin under it — but only
  // where nothing else provides one. A section with a footer already has
  // that line sitting below with its own spacing, and a second gap there
  // reads as a hole.
  const pad = footer === undefined ? 'px-7 pb-7' : 'px-7 pb-1';
  return (
    <div className='flex h-full flex-col'>
      <h2 className='px-7 pb-5 pt-7 text-base font-semibold'>{title}</h2>
      {scrolls ? (
        <div className='min-h-0 flex-1'>
          <ScrollArea className='h-full' viewportClassName={pad}>
            <div className='flex flex-col gap-5'>{children}</div>
          </ScrollArea>
        </div>
      ) : (
        <div className={cn('flex min-h-0 flex-1 flex-col gap-5', pad)}>
          {children}
        </div>
      )}
      {footer === undefined ? null : (
        <div className='px-7 pb-7 pt-5'>{footer}</div>
      )}
    </div>
  );
}

/**
 * What a section shows while its read is in flight.
 *
 * Bars rather than a spinner: the layout does not depend on the answer, so
 * the reader is already looking at the right place when it arrives.
 * @returns The placeholder.
 */
export function SectionSkeleton(): React.JSX.Element {
  return (
    <div className='flex flex-col gap-3' data-testid='credits-skeleton'>
      <Skeleton className='h-3.5 w-40' />
      <Skeleton className='h-3.5 w-full' />
      <Skeleton className='h-3.5 w-5/6' />
      <Skeleton className='h-3.5 w-2/3' />
    </div>
  );
}

/**
 * What a section shows when its read failed.
 *
 * One line, no retry button: closing the overlay and opening it again
 * refetches, and nothing here is mid-task enough to lose by doing that. This
 * is what the membership panel and the studio pages do.
 * @returns The message.
 */
export function SectionError(): React.JSX.Element {
  const t = useTranslation();
  return (
    <p role='alert' className='text-sm text-muted-foreground'>
      {t('credits.loadFailed')}
    </p>
  );
}

/** The sentence shown when a section has nothing in it. */
interface SectionEmptyProps {
  /** What is missing, and what to do about it if anything. */
  message: string;
}

/**
 * What a section shows when it has nothing to list.
 * @param props - The message.
 * @param props.message - What is missing, and what to do about it.
 * @returns The message.
 */
export function SectionEmpty({
  message,
}: SectionEmptyProps): React.JSX.Element {
  return (
    <p data-testid='credits-empty' className='text-sm text-muted-foreground'>
      {message}
    </p>
  );
}

/** A line explaining what is above it. */
interface FootnoteProps {
  /** The explanation. */
  children: React.ReactNode;
  /** A hook for tests to name this particular line. */
  'data-testid'?: string;
}

/**
 * A quiet line under a list, explaining how to read it.
 *
 * Drawn the same as {@link SectionEmpty} and named apart from it: one says
 * there is nothing to show, the other explains what is being shown, and a
 * reader of this code should not have to work out which is meant.
 * @param props - The explanation.
 * @param props.children - The explanation.
 * @param props.'data-testid' - A hook for tests to name this particular line.
 * @returns The line.
 */
export function Footnote({
  children,
  'data-testid': testId,
}: FootnoteProps): React.JSX.Element {
  return (
    <p className='text-sm text-muted-foreground' data-testid={testId}>
      {children}
    </p>
  );
}

/** The sentences of a rule, and a name for tests to reach them by. */
interface RuleLinesProps {
  /** The sentences, in the order they were handed over. */
  lines: readonly string[];
  /** A hook for tests to name this particular block. */
  'data-testid'?: string;
}

/**
 * A rule, one sentence per line.
 *
 * Its own shape rather than {@link Rows}: those put a label left and a figure
 * right and rule off between them, which under prose draws a line through the
 * middle of a paragraph and pulls each sentence toward opposite edges.
 * @param props - The sentences and the hook.
 * @param props.lines - The sentences, in order.
 * @param props.'data-testid' - A hook for tests to name this block.
 * @returns The lines.
 */
export function RuleLines({
  lines,
  'data-testid': testId,
}: RuleLinesProps): React.JSX.Element {
  return (
    <ul data-testid={testId} className='flex list-none flex-col gap-1.5'>
      {lines.map((line) => (
        <li key={line} className='text-sm text-muted-foreground'>
          {line}
        </li>
      ))}
    </ul>
  );
}

/** A bordered block, and what is in it. */
interface CardProps {
  /** An optional heading for the block. */
  title?: string;
  /** The block's content. */
  children: React.ReactNode;
}

/**
 * A bordered block, the way the studio's credits tab draws one.
 * @param props - The heading and the content.
 * @param props.title - An optional heading.
 * @param props.children - The block's content.
 * @returns The block.
 */
export function Card({ title, children }: CardProps): React.JSX.Element {
  return (
    <div className='rounded-content-md border border-border p-4'>
      {title === undefined ? null : (
        <h3 className='mb-3 text-sm font-semibold'>{title}</h3>
      )}
      {children}
    </div>
  );
}

/** A long list, what stands above it, and a hook for the section paging it. */
interface ScrollCardProps {
  /** The rows. */
  children: React.ReactNode;
  /**
   * What sits at the top of the block and stays there.
   *
   * For a control that acts on the whole list — what it is called, what it is
   * filtered by. Scrolling it away takes the filter with it, and the reader
   * has to come back up to find out what they are looking at.
   */
  head?: React.ReactNode;
  /**
   * Goes on the element wrapping this block's `ScrollArea`.
   *
   * Passed straight through from the paging hook: each section draws its own
   * block, so the one showing is always the one being watched.
   */
  scrollerRef?: (node: HTMLElement | null) => void;
}

/**
 * A bordered block that takes the height it is given and scrolls inside it.
 *
 * The border is the frame around a list, so it stays whole: all four corners
 * on screen at every offset, with the rows moving behind it. A block that
 * scrolls with the page instead is cut off at the top and bottom of the
 * panel, and its corners come and go as the reader scrolls.
 *
 * Padding goes on the viewport rather than this element, so the first and
 * last rows clear the border the same way the middle ones clear the sides.
 * A head takes the top padding instead, and the rows start where it ends.
 * @param props - The rows, the head and the hook.
 * @param props.children - The rows.
 * @param props.head - What stays at the top of the block.
 * @param props.scrollerRef - Goes on the element wrapping the `ScrollArea`.
 * @returns The block.
 */
export function ScrollCard({
  children,
  head,
  scrollerRef,
}: ScrollCardProps): React.JSX.Element {
  return (
    <div className='flex min-h-0 flex-1 flex-col rounded-content-md border border-border'>
      {head === undefined ? null : <div className='px-4 pb-3 pt-4'>{head}</div>}
      <div ref={scrollerRef} className='min-h-0 flex-1'>
        <ScrollArea
          className='h-full'
          viewportClassName={head === undefined ? 'p-4' : 'px-4 pb-4'}
        >
          {children}
        </ScrollArea>
      </div>
    </div>
  );
}

/**
 * How loud a figure is.
 *
 * `sum` is the studio credits tab's spendable figure; `part` is a step
 * quieter, for a figure that is one of the numbers adding up to a `sum` shown
 * beside it. Same size on both says they are peers.
 */
type FigureSize = 'sum' | 'part';

/** How each size draws its number. */
const FIGURE_VALUE_CLASS: Record<FigureSize, string> = {
  sum: 'text-3xl font-extrabold',
  part: 'text-2xl font-bold',
};

/** One headline number and what it means. */
interface FigureProps {
  /** What the number is. */
  label: string;
  /** The number itself, already formatted, or a dash when it has none. */
  value: string;
  /** The unit, omitted when the value is a dash. */
  unit?: string;
  /** An optional line under it. */
  hint?: string;
  /** How loud it is, defaulting to a figure that stands on its own. */
  size?: FigureSize;
}

/**
 * One headline number. At its default size it is drawn the way the studio's
 * credits tab draws its spendable figure; {@link FigureSize} has the quieter
 * one.
 * @param props - The label, value, unit, hint and size.
 * @param props.label - What the number is.
 * @param props.value - The number itself, already formatted.
 * @param props.unit - The unit, omitted when the value is a dash.
 * @param props.hint - An optional line under it.
 * @param props.size - How loud it is.
 * @returns The figure.
 */
export function Figure({
  label,
  value,
  unit,
  hint,
  size = 'sum',
}: FigureProps): React.JSX.Element {
  return (
    <div>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div
        className={cn(
          'leading-[1.1] tracking-tight tabular-nums',
          FIGURE_VALUE_CLASS[size],
        )}
      >
        {value}
        {unit === undefined ? null : (
          <small className='ml-1 align-baseline text-sm font-medium text-muted-foreground'>
            {unit}
          </small>
        )}
      </div>
      {hint === undefined ? null : (
        <div className='mt-0.5 text-xs text-muted-foreground'>{hint}</div>
      )}
    </div>
  );
}

/** One row of a two-sided list. */
interface RowProps {
  /** The row's first line. */
  main: React.ReactNode;
  /** Its second, quieter line. */
  sub?: React.ReactNode;
  /** What sits at the right end: a figure, a control, or nothing. */
  right?: React.ReactNode;
  /** A hook for tests to name this particular row. */
  'data-testid'?: string;
}

/**
 * One row of a list where a label sits left and a figure or control right.
 *
 * Rows are separated by a rule on their top edge rather than the bottom, so
 * the list does not end with one hanging under its last row.
 * @param props - The row's three slots.
 * @param props.main - The row's first line.
 * @param props.sub - Its second, quieter line.
 * @param props.right - What sits at the right end.
 * @param props.'data-testid' - A hook for tests to name this particular row.
 * @returns The row.
 */
export function Row({
  main,
  sub,
  right,
  'data-testid': testId,
}: RowProps): React.JSX.Element {
  return (
    <li
      data-testid={testId}
      className='flex items-baseline gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0'
    >
      <span className='min-w-0'>
        <span className='text-sm'>{main}</span>
        {sub === undefined ? null : (
          <span className='block text-xs text-muted-foreground'>{sub}</span>
        )}
      </span>
      {right === undefined ? null : (
        <span className='ml-auto text-right tabular-nums'>{right}</span>
      )}
    </li>
  );
}

/** The rows of a list. */
interface RowsProps {
  /** The rows. */
  children: React.ReactNode;
}

/**
 * A list of {@link Row}s.
 * @param props - The rows.
 * @param props.children - The rows.
 * @returns The list.
 */
export function Rows({ children }: RowsProps): React.JSX.Element {
  return <ul className='flex list-none flex-col'>{children}</ul>;
}

/** A block of guidance, and how loud it is. */
interface NoticeProps {
  /** Its first line. */
  title: string;
  /** The explanation under it. */
  body: string;
  /**
   * Whether it is telling the reader something needs doing. Warnings carry
   * the amber fill; anything merely informative stays neutral.
   */
  tone?: 'warning' | 'info';
  /** A hook for tests to name this particular block. */
  'data-testid'?: string;
}

/**
 * A block saying what the reader may want to do next.
 * @param props - Its text and tone.
 * @param props.title - Its first line.
 * @param props.body - The explanation under it.
 * @param props.tone - Whether something needs doing.
 * @param props.'data-testid' - A hook for tests to name this particular block.
 * @returns The block.
 */
export function Notice({
  title,
  body,
  tone = 'warning',
  'data-testid': testId,
}: NoticeProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn(
        'rounded-content-sm border px-3 py-2.5 text-sm',
        tone === 'warning'
          ? 'border-status-warning-border bg-status-warning-bg'
          : 'border-border bg-muted',
      )}
    >
      <div className='font-semibold'>{title}</div>
      <div className='mt-0.5 text-sm'>{body}</div>
    </div>
  );
}

/** The cells of one header row. */
interface TableHeadProps {
  /** The column headings, in order. */
  columns: readonly { key: string; label: string; align?: 'right' }[];
}

/**
 * A table header that stays put while the panel scrolls.
 *
 * Sticky against its own section's scroll viewport, which is the element that
 * actually moves — the panel around it stays put.
 * @param props - The column headings.
 * @param props.columns - The headings, in order.
 * @returns The header.
 */
export function TableHead({ columns }: TableHeadProps): React.JSX.Element {
  return (
    <thead className='sticky top-0 z-10 bg-card'>
      <tr className='border-b border-border'>
        {columns.map((column) => (
          <th
            key={column.key}
            scope='col'
            className={cn(
              'whitespace-nowrap py-1 text-left text-xs font-medium text-muted-foreground',
              column.align === 'right' && 'text-right',
            )}
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/**
 * Format what a purchase cost, in its own currency.
 *
 * The amount is stored in the currency's smallest unit, which is a hundredth
 * for the currencies this takes; `Intl` is told the currency and places the
 * symbol and the decimals the way the reader's language does.
 * @param cents - The amount, in the smallest unit of `currency`.
 * @param currency - Its ISO 4217 code.
 * @returns The amount, formatted.
 */
export function formatMoney(cents: number, currency: string): string {
  return (cents / 100).toLocaleString(getLocale(), {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
}

/** What the foot of a paging list reads from. */
interface ListEndProps {
  /**
   * The paging state, as `useCreditsPaging` returns it.
   *
   * The whole object rather than four fields off it: three of them are
   * booleans, so a call site that mixed two of them up would type-check and
   * draw the wrong thing, and every one of these lists is fed by that hook.
   */
  paging: {
    sentinelRef: (node: HTMLElement | null) => void;
    isFetchingNextPage: boolean;
    hasNextPage: boolean;
    pageFailed: boolean;
  };
}

/**
 * The foot of a paging list: the sentinel that asks for the next page, and
 * what the list is doing.
 *
 * Drawn under a list that has rows. A page builder over-fetches by one and
 * slices back, so a page carrying a next cursor always carries a row — which
 * means a list with nothing in it is a list with nothing more coming, and the
 * sentinel has nothing to ask for.
 * @param props - The paging state.
 * @param props.paging - The paging state, as `useCreditsPaging` returns it.
 * @returns The foot.
 */
export function ListEnd({ paging }: ListEndProps): React.JSX.Element {
  const {
    sentinelRef,
    isFetchingNextPage: loading,
    hasNextPage: more,
    pageFailed: failed,
  } = paging;
  const t = useTranslation();
  return (
    <div className='flex items-center justify-center py-2 text-2xs tracking-widest text-muted-foreground'>
      <span ref={sentinelRef} aria-hidden='true' />
      {/* A page that did not arrive says so. The watcher stops until the
          reader scrolls again, so with nothing here the list looks exactly
          like one that still has more coming and the reader waits for a page
          nobody is fetching. */}
      {loading ? (
        <Loader2 className='h-4 w-4 animate-spin' aria-hidden='true' />
      ) : failed ? (
        <span role='status'>{t('credits.listPageFailed')}</span>
      ) : more ? null : (
        t('credits.listEnd')
      )}
    </div>
  );
}
