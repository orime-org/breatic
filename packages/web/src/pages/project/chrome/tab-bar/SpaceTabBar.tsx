// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  ChevronLeft,
  ChevronRight,
  LocateFixed,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react';
import * as React from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';

import type { ProjectRole } from '@breatic/shared';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import type { SpaceType } from '@web/spaces';
import { useUIStore } from '@web/stores';
import { NewSpaceDialog } from '@web/pages/project/chrome/tab-bar/NewSpaceDialog';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { SpaceDrawer } from '@web/pages/project/chrome/tab-bar/SpaceDrawer';
import { ProjectActivityButton } from '@web/pages/project/chrome/tab-bar/ProjectActivityButton';
import { SpaceTab } from '@web/pages/project/chrome/tab-bar/SpaceTab';
import { resolveTabDrop } from '@web/pages/project/chrome/tab-bar/tab-drop';
import {
  edgeLanding,
  endsAfter,
  scrollTargetFor,
  startsBefore,
  type Span,
} from '@web/pages/project/chrome/tab-bar/tab-scroll';

/**
 * How far the pointer travels before a press becomes a drag (px).
 *
 * Without a distance every press starts one, so a hand that shakes a couple
 * of pixels while switching Space drops the tab on its neighbour.
 */
const DRAG_START_DISTANCE = 4;

/**
 * Nothing to tell a screen reader about picking a tab up.
 *
 * dnd-kit's default says to press space and use the arrow keys. Space on a
 * tab switches Space (design §4.5), so that instruction describes an
 * interaction the strip does not have — and it is English in a product that
 * ships five locales.
 */
const DND_ACCESSIBILITY = { screenReaderInstructions: { draggable: '' } };

/** Held still so useSensor's memo has something stable to hold. */
const POINTER_ACTIVATION = {
  activationConstraint: { distance: DRAG_START_DISTANCE },
};

/**
 * Where a tab sits along the strip, in the strip's own scroll coordinates.
 *
 * Read off the layout, which a transform does not move. A tab being dragged
 * carries one, and through a rect it reads as wherever the pointer is holding
 * it — so the strip would answer "is this cut off?" about a position the tab
 * only has while a hand is on it, and keep that answer once the gesture ends,
 * since ending one scrolls nothing and resizes nothing.
 * @param tab - The tab to place.
 * @returns Its leading and trailing edge.
 */
function tabSpan(tab: HTMLElement): Span {
  return { start: tab.offsetLeft, end: tab.offsetLeft + tab.offsetWidth };
}

/**
 * What stretch of the strip is on screen, in the same coordinates.
 * @param scroller - The viewport the tabs scroll in.
 * @returns The visible leading and trailing edge.
 */
function visibleSpan(scroller: HTMLElement): Span {
  return {
    start: scroller.scrollLeft,
    end: scroller.scrollLeft + scroller.clientWidth,
  };
}

/**
 * Brings a tab flush against one edge of the strip, moving the strip alone.
 *
 * `scrollIntoView` moves every scroller between the tab and the document, and
 * once the window is narrower than the project page's floor the page itself is
 * one of them: measured in a browser at 700px, a page the reader had scrolled
 * to 41 was dragged back to 0 by a single arrow click.
 * @param scroller - The viewport the tabs scroll in.
 * @param tab - The tab to bring into view.
 * @param edge - Which edge of the strip the tab should end up flush against.
 */
function scrollTabToEdge(
  scroller: HTMLElement,
  tab: HTMLElement,
  edge: 'start' | 'end',
): void {
  scrollStripTo(
    scroller,
    edgeLanding(tabSpan(tab), visibleSpan(scroller), edge),
  );
}

/**
 * Moves the strip, and the strip alone.
 * @param scroller - The viewport the tabs scroll in.
 * @param left - Where it should come to rest.
 */
function scrollStripTo(scroller: HTMLElement, left: number): void {
  scroller.scrollTo({ left, behavior: 'smooth' });
}

/**
 * The tabs, read off the scroller.
 *
 * Two elements sit between the tabs and the element that scrolls: the
 * `display:table` div Radix puts inside every viewport, and the row this
 * file renders inside it. Asking for the tabs by their role instead of by
 * child position keeps this true however many wrappers either side adds.
 * @param scroller - The element that scrolls, or null before it mounts.
 * @returns The tab elements in document order.
 */
function tabsIn(scroller: HTMLElement | null): HTMLElement[] {
  return scroller === null
    ? []
    : Array.from(scroller.querySelectorAll('[role="tab"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
}

/**
 * Scroll arrow for the tab strip.
 * @param root0 - Component props.
 * @param root0.direction - Which end of the strip this arrow scrolls toward.
 * @param root0.label - Its accessible name.
 * @param root0.onClick - Scrolls the strip one tab that way.
 * @param root0.hidden - True while the strip has nothing to scroll.
 * @param root0.disabled - True at that end of the strip.
 * @returns The arrow button.
 */
function ArrowButton({
  direction,
  label,
  onClick,
  hidden,
  disabled,
}: {
  direction: 'left' | 'right';
  label: string;
  onClick: () => void;
  hidden: boolean;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <Button
      variant='chrome-ghost'
      size='chrome'
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      data-testid={
        direction === 'left' ? 'tabs-scroll-left' : 'tabs-scroll-right'
      }
      className={cn(
        hidden && 'hidden',
        // Reads as 35% and renders as the Button primitive's 50%: this class
        // carries no pseudo-class where `disabled:opacity-50` does, so the
        // primitive wins on specificity. Task #2037 holds that decision.
        disabled && 'opacity-35',
      )}
      style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
    >
      {direction === 'left' ? (
        <ChevronLeft className='h-3.5 w-3.5' />
      ) : (
        <ChevronRight className='h-3.5 w-3.5' />
      )}
    </Button>
  );
}

interface SpaceTabBarProps {
  /** Tabs currently open in the bar (resolved from per-user openTabIds). */
  spaces: ReadonlyArray<ProjectSpace>;
  /** All Spaces in the project - used by the drawer to list everything. */
  allSpaces: ReadonlyArray<ProjectSpace>;
  /** Per-user open tab id list, for the drawer's status chip computation. */
  openTabIds: ReadonlyArray<string>;
  activeSpaceId: string;
  /** Project id - drawer uses it for row test ids only (RPCs are by handler). */
  projectId: string;
  onActivate: (id: string) => void;
  /** Returns a promise so the dialog can show progress and report errors. */
  onCreate: (type: SpaceType, name: string) => Promise<void> | void;
  /** Close a tab - does NOT delete the Space, just removes from the bar. */
  onClose?: (id: string) => void;
  /** Open the read-only preview sheet for a Space (drawer "view" action). */
  onViewSpace: (id: string) => void;
  /**
   * Live meta-doc provider — ProjectActivityButton listens for the
   * `activity:new` stateless signal on it (ADR 2026-07-04
   * project-activity-feed; feed data itself arrives via REST).
   */
  metaProvider?: Pick<HocuspocusProvider, 'on' | 'off'> | null;
  /** Caller's role on the project - drives owner-only message actions. */
  currentUserRole?: ProjectRole;
  /** Owner-only: restore a soft-deleted Space via collab `space:restore` RPC. */
  onRestoreSpace?: (spaceId: string) => Promise<void> | void;

  /** Soft-delete a Space (drawer row × button). RPC handler from ProjectPage. */
  onDeleteSpace?: (spaceId: string) => Promise<void> | void;
  /** Toggle Space lock (drawer row 🔒 button). RPC handler from ProjectPage. */
  onSetSpaceLocked?: (spaceId: string, locked: boolean) => Promise<void> | void;
  /**
   * Rename a Space inline from the tab strip. Caller role ≥ edit;
   * locked Spaces refuse rename on the server side. Handler from
   * ProjectPage wraps `space:rename` RPC via callRpc.
   */
  onRenameSpace?: (spaceId: string, name: string) => Promise<void> | void;
  /**
   * A tab was dragged to a new place. `beforeSpaceId` names the tab it now
   * sits in front of, null when it landed at the end. Omitting it leaves the
   * strip draggable and the landing unreported.
   */
  onReorder?: (spaceId: string, beforeSpaceId: string | null) => void;
}

/**
 * Space tab bar - chrome-baseline mock `.space-header` (40px).
 *
 * Layout (mock § space-header):
 *   [agent-toggle | divider] [scroll-left] [.space-tabs] [scroll-right]
 *   [divider | new-space + drawer + project-activity]
 *
 * Scroll arrows hide when content doesn't overflow + show disabled
 * state at boundaries (industry standard pattern per mock v4.27/v4.29).
 */

/**
 * The 40px space tab bar: agent-column toggle, scrollable open-tab strip
 * with smart scroll arrows, and the new-space / all-spaces drawer /
 * project-activity chrome controls.
 * @param root0 - Component props.
 * @param root0.spaces - Tabs currently open in the bar (resolved from per-user open tab ids).
 * @param root0.allSpaces - All spaces in the project, used by the drawer to list everything.
 * @param root0.openTabIds - Per-user open tab id list, for the drawer's status chip computation.
 * @param root0.activeSpaceId - Id of the active space, used to highlight and scroll to its tab.
 * @param root0.projectId - Project id, threaded to the drawer for row test ids.
 * @param root0.onActivate - Activates the space with the given id.
 * @param root0.onCreate - Creates a new space of the given type and name.
 * @param root0.onClose - Closes a tab (removes it from the bar without deleting the space).
 * @param root0.onViewSpace - Opens the read-only preview sheet for a space (drawer "view" action).
 * @param root0.metaProvider - Live meta-doc provider carrying the activity:new signal.
 * @param root0.currentUserRole - Caller's role on the project, driving owner-only message actions.
 * @param root0.onRestoreSpace - Owner-only handler to restore a soft-deleted space.
 * @param root0.onDeleteSpace - Handler to soft-delete a space (drawer row delete button).
 * @param root0.onSetSpaceLocked - Handler to toggle a space's lock (drawer row lock button).
 * @param root0.onRenameSpace - Handler to rename a space inline from the tab strip.
 * @param root0.onReorder - Handler for a tab dragged to a new place in the strip.
 * @returns The space tab bar toolbar.
 */
export function SpaceTabBar({
  spaces,
  allSpaces,
  openTabIds,
  activeSpaceId,
  projectId,
  onActivate,
  onCreate,
  onClose,
  onViewSpace,
  metaProvider,
  currentUserRole,
  onRestoreSpace,
  onDeleteSpace,
  onSetSpaceLocked,
  onRenameSpace,
  onReorder,
}: SpaceTabBarProps): React.JSX.Element {
  const t = useTranslation();
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const toggleAgent = useUIStore((s) => s.toggleChatPanel);
  const agentOpen = !collapsed;
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);

  // Pointer only, and deliberately so: dnd-kit's keyboard sensor starts a drag
  // on Space and Enter, which are how a keyboard user switches Space on a tab
  // today (design §4.5).
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_ACTIVATION),
  );
  const tabIds = React.useMemo(() => spaces.map((s) => s.id), [spaces]);
  // The order as one value. `spaces` is rebuilt on every projection of the
  // meta doc — a presence heartbeat is enough — so depending on the array
  // itself tears down and rebuilds the strip's listeners every few seconds.
  // Space ids are uuids, so no id can carry the separator.
  const tabKey = tabIds.join(',');

  const onDragEnd = React.useCallback(
    (event: DragEndEvent): void => {
      const over = event.over;
      const drop = resolveTabDrop(
        tabIds,
        String(event.active.id),
        over ? String(over.id) : null,
      );
      if (drop) onReorder?.(drop.spaceId, drop.beforeSpaceId);
    },
    [tabIds, onReorder],
  );

  // Track scroll overflow + boundaries to drive the smart-hide/disabled
  // states for the left / right scroll arrows (mock v4.27 / v4.29).
  const [scrollState, setScrollState] = React.useState({
    overflow: false,
    atStart: true,
    atEnd: true,
    activeVisible: true,
  });

  /**
   * The tab of the Space the page is showing.
   *
   * Named by the id rather than found by `aria-selected`, because this is
   * what carries `activeSpaceId` into the recompute: switching Space scrolls
   * nothing and resizes nothing, so it is the only signal that the answer
   * just changed.
   * @returns That tab, or null before it is on screen.
   */
  const activeTab = React.useCallback((): HTMLElement | null => {
    const found = scrollerRef.current?.querySelector(
      `[data-testid="space-tab-${activeSpaceId}"]`,
    );
    return found instanceof HTMLElement ? found : null;
  }, [activeSpaceId]);

  const updateScrollState = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // atStart / atEnd ask the same spans `scrollOneTab` below asks, so the
    // arrow's enabled state ("can we still scroll?") can never disagree with
    // what clicking it does ("is there a tab left to bring on screen?").
    const visible = visibleSpan(el);
    const tabs = tabsIn(el);
    const atStart = !tabs.some((t) => startsBefore(tabSpan(t), visible));
    const atEnd = !tabs.some((t) => endsAfter(tabSpan(t), visible));
    // Something is off an edge exactly when there is somewhere to scroll to,
    // so this is those two answers rather than a third measurement.
    const overflow = !atStart || !atEnd;
    // The reveal control asks `scrollTargetFor` whether it has anywhere to
    // go, and clicking it moves to that same answer, so being enabled and
    // having something to do are one question.
    const active = activeTab();
    const activeVisible =
      active === null || scrollTargetFor(tabSpan(active), visible) === null;
    setScrollState((was) =>
      was.overflow === overflow &&
      was.atStart === atStart &&
      was.atEnd === atEnd &&
      was.activeVisible === activeVisible
        ? was
        : { overflow, atStart, atEnd, activeVisible },
    );
  }, [activeTab]);

  React.useEffect(() => {
    updateScrollState();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    // The row of tabs grows and shrinks — a name is edited here or by a
    // collaborator — while the box it scrolls in keeps the width the bar gives
    // it, and a resize observer watching only that box never hears about it.
    // The row is the element this file renders, so watching it does not rest
    // on what Radix puts in between.
    if (rowRef.current) ro.observe(rowRef.current);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      ro.disconnect();
    };
    // The order the tabs render in is the fourth signal, and the one neither
    // listener above can carry: a drag moves a tab without scrolling the strip
    // or resizing anything, and it is precisely what can push the current tab
    // out of sight. `tabIds` is the order actually painted — the pending layer
    // included — so this fires when the user lets go, not a round trip later.
  }, [updateScrollState, tabKey]);

  // When the active space changes (e.g. user picks a space from the
  // drawer), make sure the corresponding tab is visible inside the
  // scrollable tab strip. Without this, picking an off-screen space
  // from the drawer left the tab bar frozen and the user with no
  // visual confirmation that the selection landed.
  //
  // Only as far as needed, and only when the tab is actually cut off: a tab
  // already whole on screen stays where it is, matching the standard IDE /
  // browser tab strip behavior. The reveal control calls this too, and both
  // it and the enabled state above read the same `scrollTargetFor`.
  const scrollActiveIntoView = React.useCallback((): void => {
    const scroller = scrollerRef.current;
    const tab = activeTab();
    if (!scroller || !tab) return;
    const target = scrollTargetFor(tabSpan(tab), visibleSpan(scroller));
    if (target !== null) scrollStripTo(scroller, target);
  }, [activeTab]);

  React.useEffect(() => {
    scrollActiveIntoView();
  }, [scrollActiveIntoView]);

  /**
   * Scroll one tab into view (point-and-scroll model, IDE / browser tab
   * strip standard).
   *
   * Why not a fixed pixel `scrollBy(±120)` like the prior implementation:
   * tab width is content-driven (short "Main" ≈ 60px, long "what is your name
   * ..." ≈ 280px). A fixed delta either over- or under-scrolls; long-name
   * tabs took 2–3 clicks to fully reveal (PR #140 user report 2026-05-25).
   *
   * Algorithm:
   *   - **right**: find the first tab whose right edge sits beyond the
   *     scroller's right edge → snap it flush right.
   *   - **left**: find the last tab whose left edge sits before the
   *     scroller's left edge → snap it flush left.
   *
   * A 1-px tolerance absorbs sub-pixel rounding from CSS gap / padding.
   * @param direction - Which way to scroll: bring the next off-screen tab in from the left or right.
   */
  const scrollOneTab = (direction: 'left' | 'right'): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const tabs = tabsIn(scroller);
    if (tabs.length === 0) return;
    const visible = visibleSpan(scroller);

    const target =
      direction === 'right'
        ? tabs.find((tab) => endsAfter(tabSpan(tab), visible))
        : [...tabs].reverse().find((tab) => startsBefore(tabSpan(tab), visible));

    if (target) {
      scrollTabToEdge(scroller, target, direction === 'right' ? 'end' : 'start');
    }
  };

  return (
    // ARIA structure: outer container is a `toolbar` because it mixes
    // tabs (the space list) with chrome controls (agent toggle, new,
    // drawer, project-activity, scroll arrows). The actual `role='tablist'` is
    // nested around just the SpaceTab list below, satisfying
    // axe-core's `aria-required-children` rule (a tablist may only
    // contain `role='tab'` children).
    <div
      data-testid='space-tab-bar'
      role='toolbar'
      aria-label={t('chrome.aria.spacesToolbar')}
      className='flex shrink-0 items-center border-b border-border bg-background'
      style={{
        height: 40,
        padding: '0 var(--space-5)',
        gap: 'var(--space-2)',
      }}
    >
      <div
        className='flex shrink-0 items-center border-r border-border'
        style={{
          gap: 'var(--space-2)',
          paddingRight: 'var(--space-4)',
          marginRight: 'var(--space-2)',
        }}
        data-testid='space-header-left'
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant='chrome-ghost'
              size='chrome'
              aria-label={agentOpen ? t('chrome.tooltip.agentHide') : t('chrome.tooltip.agentShow')}
              aria-pressed={agentOpen}
              onClick={toggleAgent}
              data-testid='agent-toggle'
              style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
            >
              {agentOpen ? (
                <PanelLeftClose className='h-[18px] w-[18px]' />
              ) : (
                <PanelLeftOpen className='h-[18px] w-[18px]' />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side='bottom'>
            {agentOpen
              ? t('chrome.tooltip.agentHide')
              : t('chrome.tooltip.agentShow')}
          </TooltipContent>
        </Tooltip>
      </div>

      <ArrowButton
        direction='left'
        label={t('chrome.aria.scrollTabsLeft')}
        onClick={() => scrollOneTab('left')}
        hidden={!scrollState.overflow}
        disabled={scrollState.atStart}
      />

      {/*
        The scroller is as tall as the bar, because the rail is positioned
        along the scroller's bottom edge and belongs on the bar's bottom edge
        — the same place every other scroller in the app puts its rail.

        The tabs are then centred by the viewport itself. Radix's
        `display:table` wrapper inside the viewport is auto-height, so a
        percentage height on anything under it resolves to auto: a row asking
        for the full height collapses back to the tabs' own 32px and parks
        against the top edge. Declaring the centring one level up, on the
        viewport, puts that wrapper in the middle instead, and the tabs with
        it (user 2026-08-29).
      */}
      {/*
        Auto-scroll stays on its default, which is on: with more tabs than fit,
        dragging one past the edge is the ordinary way to move it far, and the
        viewport below is the scrollable ancestor dnd-kit finds.
      */}
      <DndContext
        accessibility={DND_ACCESSIBILITY}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <ScrollArea
          scrollbars='horizontal'
          viewportRef={scrollerRef}
          className='flex-1'
          viewportClassName='flex items-center'
          style={{ minWidth: 0, height: '100%' }}
        >
          {/*
          The row is ours and the tabs are its own flex children. Radix puts a
          `display:table` div inside every viewport, so a flex declared on the
          viewport reaches that div and stops: the tabs would lay out one per
          row, the strip would never overflow sideways, and neither the bar nor
          the arrows would ever appear. Carrying the row here also puts the
          tablist role on the element the tabs actually sit in.
        */}
          <div
            ref={rowRef}
            role='tablist'
            aria-label={t('chrome.aria.openSpaces')}
            className='flex w-max items-center'
            style={{ gap: 'var(--space-3)', padding: '0 var(--space-2)' }}
          >
            <SortableContext
              items={tabIds}
              strategy={horizontalListSortingStrategy}
            >
              {spaces.map((s) => (
                <SpaceTab
                  key={s.id}
                  id={s.id}
                  name={s.name}
                  type={s.type}
                  active={s.id === activeSpaceId}
                  locked={s.locked}
                  onActivate={() => onActivate(s.id)}
                  onClose={onClose ? () => onClose(s.id) : undefined}
                  onRename={
                    onRenameSpace
                      ? (next) => onRenameSpace(s.id, next)
                      : undefined
                  }
                />
              ))}
            </SortableContext>
          </div>
        </ScrollArea>
      </DndContext>

      <ArrowButton
        direction='right'
        label={t('chrome.aria.scrollTabsRight')}
        onClick={() => scrollOneTab('right')}
        hidden={!scrollState.overflow}
        disabled={scrollState.atEnd}
      />

      {/*
        Reordering does not chase the current tab (user 2026-08-30), so this is
        how it is brought back. Disabled rather than hidden, also by that
        decision: a control that appears and disappears with the tab count is
        harder to find than one that is always in the same place.
      */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant='chrome-ghost'
            size='chrome'
            aria-label={t('chrome.tooltip.revealActiveTab')}
            onClick={scrollActiveIntoView}
            // A strip with nothing off either edge holds every tab whole, so
            // `activeVisible` already answers for that case.
            disabled={scrollState.activeVisible}
            data-testid='tabs-reveal-active'
            // Disabled dimming is the Button primitive's, measured at 0.5. The
            // arrows next door ask for `opacity-35` and get 0.5 anyway — their
            // class has no pseudo-class where `disabled:opacity-50` does, so
            // the primitive wins on specificity (task #2037).
            style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
          >
            <LocateFixed className='h-3.5 w-3.5' />
          </Button>
        </TooltipTrigger>
        <TooltipContent side='bottom'>
          {t('chrome.tooltip.revealActiveTab')}
        </TooltipContent>
      </Tooltip>

      <div
        className='flex shrink-0 items-center border-l border-border'
        style={{
          gap: 'var(--space-2)',
          paddingLeft: 'var(--space-4)',
          marginLeft: 'var(--space-2)',
        }}
        data-testid='space-header-right'
      >
        {/* New-space create is hidden for viewers (B model — hidden, not
            disabled). Editors + owners can create spaces; the all-spaces
            drawer + project-activity buttons stay visible for everyone.
            Backend `requireRole` on `space:create` is the real boundary. */}
        {currentUserRole === 'viewer' ? null : (
          <NewSpaceDialog
            onCreate={onCreate}
            tooltip={t('chrome.tooltip.newSpace')}
            trigger={
              <Button
                variant='chrome-ghost'
                size='chrome'
                aria-label={t('chrome.tooltip.newSpace')}
                data-testid='new-space-button'
                onFocusCapture={suppressTooltipFocusOpen}
                style={{
                  height: 'var(--btn-chrome)',
                  width: 'var(--btn-chrome)',
                }}
              >
                <Plus className='h-[18px] w-[18px]' />
              </Button>
            }
          />
        )}
        <SpaceDrawer
          spaces={allSpaces}
          openTabIds={openTabIds}
          activeSpaceId={activeSpaceId}
          projectId={projectId}
          onActivate={onActivate}
          onView={onViewSpace}
          onDeleteSpace={onDeleteSpace}
          onSetSpaceLocked={onSetSpaceLocked}
        />
        <ProjectActivityButton
          projectId={projectId}
          provider={metaProvider}
          currentUserRole={currentUserRole}
          onRestore={onRestoreSpace}
        />
      </div>
    </div>
  );
}
