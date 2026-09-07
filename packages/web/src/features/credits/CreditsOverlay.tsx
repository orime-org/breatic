// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import {
  CREDITS_SECTIONS,
  CREDITS_SECTION_GROUPS,
} from '@web/features/credits/credits-sections';
import type { CreditsSectionId } from '@web/features/credits/credits-sections';
import { CreditsScrollerContext } from '@web/features/credits/credits-scroller';
import { CreditsSectionPanel } from '@web/features/credits/CreditsSectionPanel';
import { OverlayClose } from '@web/features/credits/OverlayClose';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/** Whether the overlay is open, and how it reports being closed. */
interface CreditsOverlayProps {
  /** Whether the overlay is showing. */
  open: boolean;
  /** Called when it closes itself (the X, the backdrop, Escape). */
  onOpenChange: (open: boolean) => void;
  /**
   * Which section to show first. A buyer coming back from a payment lands on
   * their purchase history rather than on the overview they did not ask for.
   */
  initialSection?: CreditsSectionId | null;
}

/**
 * The account's credits, over whatever page the reader was on.
 *
 * A panel rather than a page, for the reason the membership panel is one:
 * somebody checking their balance is looking something up, not going
 * somewhere. Whatever they were doing stays underneath, the address bar keeps
 * naming the page below, and a reload returns to that page.
 *
 * Fixed at 880 × 620 and clipped, so the index stays put while the panel on
 * the right scrolls. The width is the ledger's natural width plus the index
 * and the padding either side; the height is what the tallest section needs
 * before it starts scrolling.
 * @param props - Whether the overlay is open, and how it reports closing.
 * @param props.open - Whether the overlay is showing.
 * @param props.onOpenChange - Called when it closes itself.
 * @param props.initialSection - Which section to show first.
 * @returns The overlay.
 */
export function CreditsOverlay({
  open,
  onOpenChange,
  initialSection = null,
}: CreditsOverlayProps): React.JSX.Element {
  const t = useTranslation();
  const [active, setActive] = React.useState<CreditsSectionId>(
    initialSection ?? 'overview',
  );

  // Whoever opens the overlay may say where to open it. It is applied when
  // that instruction changes rather than on every render, so a reader who
  // then clicks elsewhere in the index stays where they clicked.
  React.useEffect(() => {
    if (initialSection !== null) setActive(initialSection);
  }, [initialSection]);
  // The element the paging sections watch. Held as state rather than a ref so
  // that a section mounting after it is attached still re-renders with it.
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);

  // One scroll area serves all seven, so an offset left by one section is
  // still there when the next one draws. Landing mid-list is the visible half;
  // the other half is that the sentinel may already be in view, which asks for
  // a page the reader never scrolled to.
  React.useEffect(() => {
    const viewport = scroller?.querySelector('[data-radix-scroll-area-viewport]');
    if (viewport instanceof HTMLElement) viewport.scrollTop = 0;
  }, [active, scroller]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `flex-row` explicitly: the primitive's own class list says `flex-col`,
          and `flex` alone does not replace it — the two are different utility
          groups, so the merge keeps both and the index ends up stacked on top
          of the panel instead of beside it. */}
      <DialogContent className='flex h-[min(620px,calc(100vh-48px))] w-[min(880px,calc(100vw-48px))] max-w-none flex-row gap-0 overflow-hidden bg-card p-0'>
        <DialogTitle className='sr-only'>{t('credits.panelTitle')}</DialogTitle>
        <OverlayClose label={t('credits.close')} />
        <CreditsIndex active={active} onSelect={setActive} />
        {/* One scroll area for the whole right-hand column rather than one per
            list: only the ledger is a heading over a single long list. The
            rest put text above or below theirs, and a scroller inside the
            list would clip that text with no way to reach it.

            The wrapper exists because `useScrolledToEnd` is given the element
            AROUND the scroll area and finds Radix's viewport inside it; the
            sections that page do their own reading, so they are handed this
            node rather than the hook being lifted up here. */}
        {/* `min-h-0` is what makes it scroll at all: a flex child's default
            minimum height is its content, so without it this column grows past
            the panel and the panel's `overflow-hidden` clips the overflow —
            leaving the rows below the fold unreachable rather than scrollable. */}
        <div ref={setScroller} className='min-h-0 min-w-0 flex-1'>
          <ScrollArea className='h-full' viewportClassName='px-7 py-7'>
            <div id='credits-body' role='tabpanel' aria-labelledby={`credits-tab-${active}`}>
              <CreditsScrollerContext.Provider value={scroller}>
                <CreditsSectionPanel section={active} open={open} />
              </CreditsScrollerContext.Provider>
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Which section is showing, and how a choice is reported. */
interface CreditsIndexProps {
  /** The section currently showing. */
  active: CreditsSectionId;
  /** Called with the section the reader picked. */
  onSelect: (id: CreditsSectionId) => void;
}

/**
 * The index down the left, as a vertical tab list.
 *
 * Tabs rather than links, by the test the studio's own tab bar states:
 * activating one of these swaps a panel that is already part of this overlay,
 * so nothing is navigated to and nothing has an address. Arrow keys move
 * between them and select as they go, which is what a tab list is expected to
 * do; Home and End jump to the ends.
 *
 * Its width follows its content, between a floor and a ceiling. Five
 * languages write these seven labels at five different lengths, and a width
 * fixed on the longest leaves the other four with a band of empty panel.
 * @param props - The active section and the callback.
 * @param props.active - The section currently showing.
 * @param props.onSelect - Called with the section the reader picked.
 * @returns The index.
 */
function CreditsIndex({
  active,
  onSelect,
}: CreditsIndexProps): React.JSX.Element {
  const t = useTranslation();

  /**
   * Move between entries with the arrow keys, wrapping at both ends.
   *
   * Selection follows focus, which is the behaviour for a tab list whose
   * panels are already loaded: every one of these is a section of this
   * overlay, so arrowing through them costs nothing but a render.
   *
   * Bound to each entry rather than to the list around them: the list is not
   * in the tab order and never has focus, so a handler there would only ever
   * run on keys that bubbled up from an entry anyway.
   * @param event - The keydown on the entry that has focus.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const at = CREDITS_SECTIONS.findIndex((s) => s.id === active);
    const last = CREDITS_SECTIONS.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = at === last ? 0 : at + 1;
    else if (event.key === 'ArrowUp') next = at === 0 ? last : at - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    const target = CREDITS_SECTIONS[next];
    if (target === undefined) return;
    onSelect(target.id);
    document.getElementById(`credits-tab-${target.id}`)?.focus();
  };

  return (
    <ScrollArea
      className='w-max min-w-36 max-w-56 shrink-0 border-r border-border'
      viewportClassName='px-2 py-4'
    >
      <div
        role='tablist'
        aria-orientation='vertical'
        aria-label={t('credits.indexLabel')}
        className='flex flex-col gap-3.5'
        data-testid='credits-index'
      >
        {CREDITS_SECTION_GROUPS.map((group) => (
          <div key={group.labelKey} className='flex flex-col gap-0.5'>
            {/* A label rather than a group heading: `role="tablist"` only takes
              tabs as children, and a heading between them would break the
              list. The name it gives is carried by each entry instead. */}
            <span className='px-2 pb-0.5 text-2xs font-semibold tracking-wide text-muted-foreground'>
              {t(group.labelKey)}
            </span>
            {group.items.map((section) => {
              const Icon = section.icon;
              const selected = section.id === active;
              return (
                <Button
                  key={section.id}
                  type='button'
                  variant={null}
                  size={null}
                  role='tab'
                  id={`credits-tab-${section.id}`}
                  aria-selected={selected}
                  aria-controls='credits-body'
                  // Only the selected entry is in the tab order, so Tab leaves
                  // the list rather than walking all seven of them.
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelect(section.id)}
                  onKeyDown={handleKeyDown}
                  className={cn(
                    'flex items-center justify-start gap-2 whitespace-nowrap rounded-chrome px-2 py-1.5 text-left text-sm font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    selected &&
                      'bg-accent-strong font-semibold text-foreground hover:bg-accent-strong',
                  )}
                >
                  <Icon className='h-4 w-4 shrink-0 opacity-85' />
                  <span>{t(section.labelKey)}</span>
                </Button>
              );
            })}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
