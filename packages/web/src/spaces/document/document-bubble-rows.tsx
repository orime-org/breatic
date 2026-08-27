// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three shapes a bubble-bar menu holds: a row, a group heading, a rule.
 *
 * These menus take no keyboard input — typing while one is open reaches the
 * body (user 2026-08-26) — so they carry no menu semantics: a `role="menu"`
 * announces arrow-key navigation and a typeahead that are deliberately not
 * there. A reader picks a row with the pointer, and the row closes the menu
 * it belongs to on the way out.
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useCloseBubbleMenu } from '@web/spaces/document/document-bubble-menu';

/**
 * One row.
 *
 * Its measurements are the shared menu row's: `px-2 py-1.5`, `text-sm`, 4px
 * between icon and label, a 16px icon.
 */
const ROW = [
  'w-full justify-start gap-2 rounded-chrome px-2 py-1.5 text-sm font-normal',
  'cursor-default select-none transition-colors hover:bg-accent',
  '[&_svg]:size-4 [&_svg]:shrink-0',
].join(' ');

/** A group heading, the way the shared menu draws one. */
const HEADING = 'px-2 py-1.5 text-sm font-semibold';

/** The rule between two groups. */
const RULE = '-mx-1 my-1 h-px bg-border';

interface BubbleMenuRowProps
  extends Omit<React.ComponentProps<typeof Button>, 'onSelect'> {
  /** What this row does. The menu closes afterwards either way. */
  onSelect?: () => void;
}

/**
 * A row of a bubble-bar menu.
 *
 * `tabIndex={-1}` keeps it out of the tab order, the way every control on the
 * bar is (ruling R4).
 * @param props - See {@link BubbleMenuRowProps}, plus anything `Button` takes.
 * @param props.className - Extra classes.
 * @param props.onSelect - What this row does.
 * @param props.children - The row's contents.
 * @returns The row.
 */
export function BubbleMenuRow({
  className,
  onSelect,
  children,
  ...rest
}: BubbleMenuRowProps): React.JSX.Element {
  const close = useCloseBubbleMenu();
  return (
    <Button
      variant={null}
      size={null}
      tabIndex={-1}
      className={cn(ROW, className)}
      onClick={() => {
        onSelect?.();
        close();
      }}
      {...rest}
    >
      {children}
    </Button>
  );
}

/**
 * A heading over a group of rows.
 * @param props - Anything a `div` takes.
 * @param props.className - Extra classes.
 * @returns The heading.
 */
export function BubbleMenuHeading({
  className,
  ...rest
}: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn(HEADING, className)} {...rest} />;
}

/**
 * The rule between two groups.
 * @param props - Anything a `div` takes.
 * @param props.className - Extra classes.
 * @returns The rule.
 */
export function BubbleMenuRule({
  className,
  ...rest
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div data-testid='doc-bubble-rule' className={cn(RULE, className)} {...rest} />
  );
}

/**
 * The shortcut a row shows on its right.
 * @param props - Anything a `span` takes.
 * @param props.className - Extra classes.
 * @returns The shortcut.
 */
export function BubbleMenuShortcut({
  className,
  ...rest
}: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      className={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground',
        className,
      )}
      {...rest}
    />
  );
}
