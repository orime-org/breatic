// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Timeline toolbar (inner#1709): one row of controls; when the row is too narrow the rightmost controls move,
 * in order, behind a More button at its end and come back as it widens.
 */

import * as React from 'react';
import { Ellipsis } from 'lucide-react';

import { BarButton } from '@web/components/BarButton';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Separator } from '@web/components/ui/separator';
import { cn } from '@web/lib/utils';
import { fittingEntryCount } from '@web/spaces/timeline/toolbar-fit';

/** One control of the toolbar, as it sits on the bar and as its row behind More. */
export interface TimelineToolbarEntry {
  id: string;
  /** Neighbouring entries of one group sit together; a separator opens each group after the first. */
  group: string;
  bar: React.ReactNode;
  row: React.ReactNode;
}

/** The toolbar. */
interface TimelineToolbarProps {
  label: string;
  moreLabel: string;
  entries: readonly TimelineToolbarEntry[];
}

const MORE_ICON = <Ellipsis className='size-4' />;
/**
 * How far the More menu stands off its button: the 4px visible gap from the bar's top edge, plus the bar's 6px padding
 * above the 32px button and its 1px top border.
 */
const MENU_OFFSET = 4 + 6 + 1;

/** A button of the toolbar; its row behind More is drawn from the same fields. */
interface TimelineToolbarButton {
  testId: string;
  group: string;
  label: string;
  icon: React.ReactElement<{ className?: string }>;
  onClick: () => void;
  shortcut?: string;
  /** Set for a switch: whether it is on; its row is then a checked row. */
  pressed?: boolean;
  disabled?: boolean;
  unavailable?: boolean;
}

/**
 * A toolbar button as a toolbar entry: a `BarButton` on the bar and a menu row behind More with its icon, name and
 * shortcut. The row's test hook is the button's with `-item` after it.
 * @param button - The button.
 * @returns The entry.
 * @throws {never} Never.
 */
export function toolbarButton(button: TimelineToolbarButton): TimelineToolbarEntry {
  const { testId, group, label, icon, onClick, shortcut, pressed, disabled = false, unavailable = false } = button;
  const content = <>{icon}{label}{shortcut !== undefined && <DropdownMenuShortcut className='pl-4'>{shortcut}</DropdownMenuShortcut>}</>;
  return {
    id: testId,
    group,
    bar: <BarButton testId={testId} label={label} icon={icon} shortcut={shortcut} pressed={pressed} disabled={disabled} unavailable={unavailable} onClick={onClick} />,
    row: pressed === undefined
      ? <DropdownMenuItem data-testid={`${testId}-item`} disabled={disabled} onSelect={onClick} className={cn('pl-8', unavailable && 'opacity-50')}>{content}</DropdownMenuItem>
      : <DropdownMenuCheckboxItem data-testid={`${testId}-item`} checked={pressed} disabled={disabled} onCheckedChange={onClick}>{content}</DropdownMenuCheckboxItem>,
  };
}

/**
 * Whether an entry opens a new group.
 * @param entries - All entries.
 * @param index - The entry's index.
 * @returns Whether a separator goes before it.
 * @throws {never} Never.
 */
function opensGroup(entries: readonly TimelineToolbarEntry[], index: number): boolean {
  return index > 0 && entries[index - 1]!.group !== entries[index]!.group;
}

/**
 * The Timeline toolbar with its More menu (inner#1709).
 * @param props - The toolbar.
 * @param props.label - Its accessible name.
 * @param props.moreLabel - The More button's name.
 * @param props.entries - Its controls, in order.
 * @returns The toolbar.
 * @throws {never} Never.
 */
export const TimelineToolbar = React.memo(function TimelineToolbar({ label, moreLabel, entries }: TimelineToolbarProps): React.JSX.Element {
  const toolbar = React.useRef<HTMLDivElement>(null);
  // Controls show only icons, so a width once measured holds in every language; a hidden entry keeps its last one.
  const widths = React.useRef(new Map<string, number>());
  const [room, setRoom] = React.useState<number | null>(null);
  const [shown, setShown] = React.useState(entries.length);
  const [open, setOpen] = React.useState(false);

  React.useLayoutEffect(() => {
    const element = toolbar.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => { if (entry !== undefined) setRoom(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    const element = toolbar.current;
    if (element === null) return;
    for (const node of element.querySelectorAll<HTMLElement>('[data-toolbar-entry]')) widths.current.set(node.dataset.toolbarEntry!, node.getBoundingClientRect().width);
    const measured = entries.map((entry) => widths.current.get(entry.id));
    if (measured.some((width) => width === undefined)) { setShown(entries.length); return; }
    if (room === null) return;
    const more = element.querySelector('[data-toolbar-more]')!.getBoundingClientRect().width;
    const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
    setShown(fittingEntryCount(measured as number[], room, gap, more));
  });

  const count = Math.min(shown, entries.length);
  const overflowing = count < entries.length;
  const rows: React.ReactNode[] = [];
  for (let index = count; index < entries.length; index += 1) {
    if (index > count && opensGroup(entries, index)) rows.push(<DropdownMenuSeparator key={`separator-${entries[index]!.id}`} />);
    rows.push(<React.Fragment key={entries[index]!.id}>{entries[index]!.row}</React.Fragment>);
  }
  return <div ref={toolbar} role='toolbar' aria-label={label} className='relative flex shrink-0 items-center gap-1.5 border-t border-border px-4 py-1.5'>
    {entries.slice(0, count).map((entry, index) => <div key={entry.id} data-toolbar-entry={entry.id} className='flex shrink-0 items-center gap-1.5'>
      {opensGroup(entries, index) && <Separator orientation='vertical' className='mx-1 h-5' />}
      {entry.bar}
    </div>)}
    {/* Kept mounted while unused so its width is known before the first control has to move behind it. */}
    <span data-toolbar-more='' inert={!overflowing} className={cn('inline-flex shrink-0', !overflowing && 'invisible absolute')}>
      <DropdownMenu open={open && overflowing} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <BarButton testId='timeline-more' label={moreLabel} icon={MORE_ICON} pressed={open && overflowing} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side='top' align='end' sideOffset={MENU_OFFSET} className='w-max'>{rows}</DropdownMenuContent>
      </DropdownMenu>
    </span>
  </div>;
});
