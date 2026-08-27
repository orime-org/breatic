// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { getLocale } from '@breatic/shared';

import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/** The heading and body of one section. */
interface SectionProps {
  /** The heading. */
  title: string;
  /** The section's content. */
  children: React.ReactNode;
}

/**
 * One section of the overlay: a heading over its content.
 * @param props - The heading and the content.
 * @param props.title - The heading.
 * @param props.children - The section's content.
 * @returns The section.
 */
export function Section({ title, children }: SectionProps): React.JSX.Element {
  return (
    <div className='flex flex-col gap-5'>
      <h2 className='text-base font-semibold'>{title}</h2>
      {children}
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
}

/**
 * One headline number, drawn the way the studio's credits tab draws its
 * spendable figure.
 * @param props - The label, value, unit and hint.
 * @param props.label - What the number is.
 * @param props.value - The number itself, already formatted.
 * @param props.unit - The unit, omitted when the value is a dash.
 * @param props.hint - An optional line under it.
 * @returns The figure.
 */
export function Figure({
  label,
  value,
  unit,
  hint,
}: FigureProps): React.JSX.Element {
  return (
    <div>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='text-3xl font-extrabold leading-[1.1] tracking-tight tabular-nums'>
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
 * Sticky against the overlay's one scroll viewport, which is the element that
 * actually moves — the tables themselves do not scroll.
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

/** Where a list ends, and whether more is coming. */
interface ListEndProps {
  /** Goes on the empty element after the last row. */
  sentinelRef: (node: HTMLElement | null) => void;
  /** A further page is on its way. */
  loading: boolean;
  /** There are more pages to read. */
  more: boolean;
  /** The last page asked for did not arrive. */
  failed: boolean;
}

/**
 * The foot of a paging list: the sentinel that asks for the next page, and
 * what the list is doing.
 * @param props - The sentinel and the three states.
 * @param props.sentinelRef - Goes on the empty element after the last row.
 * @param props.loading - A further page is on its way.
 * @param props.more - There are more pages to read.
 * @param props.failed - The last page asked for did not arrive.
 * @returns The foot.
 */
export function ListEnd({
  sentinelRef,
  loading,
  more,
  failed,
}: ListEndProps): React.JSX.Element {
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
