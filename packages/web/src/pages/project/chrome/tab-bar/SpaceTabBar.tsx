import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react';
import * as React from 'react';

import type { ProjectMessageEntry, ProjectRole } from '@breatic/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ProjectSpace } from '@/data/yjs/project-meta';
import type { SpaceType } from '@/spaces';
import { useUIStore } from '@/stores';
import { NewSpaceDialog } from '@/pages/project/chrome/tab-bar/NewSpaceDialog';
import { SpaceDrawer } from '@/pages/project/chrome/tab-bar/SpaceDrawer';
import { ProjectMessagesButton } from '@/pages/project/chrome/tab-bar/ProjectMessagesButton';
import { SpaceTab } from '@/pages/project/chrome/tab-bar/SpaceTab';

interface SpaceTabBarProps {
  /** Tabs currently open in the bar (resolved from per-user openTabIds). */
  spaces: ReadonlyArray<ProjectSpace>;
  /** All Spaces in the project — used by the drawer to list everything. */
  allSpaces: ReadonlyArray<ProjectSpace>;
  /** Per-user open tab id list, for the drawer's status chip computation. */
  openTabIds: ReadonlyArray<string>;
  activeSpaceId: string;
  /** Project id — drawer uses it for row test ids only (RPCs are by handler). */
  projectId: string;
  onActivate: (id: string) => void;
  /** Returns a promise so the dialog can show progress and report errors. */
  onCreate: (type: SpaceType, name: string) => Promise<void> | void;
  /** Close a tab — does NOT delete the Space, just removes from the bar. */
  onClose?: (id: string) => void;
  /** Open the read-only preview sheet for a Space (drawer "view" action). */
  onViewSpace: (id: string) => void;
  /**
   * Project-wide message channel (missing nodes + Space lifecycle).
   * Defaults to empty when the parent hasn't wired it yet.
   */
  projectMessages?: ReadonlyArray<ProjectMessageEntry>;
  /**
   * Live user lookup (`useProjectMeta().users`). ProjectMessagesButton
   * renders display names by reading `usersById[m.actor]`. Q11 v2
   * replaced snapshot strings with pointers so username rename
   * retroactively updates every old message.
   */
  usersById?: ReadonlyMap<string, { name: string }>;
  /** Caller's role on the project — drives owner-only message actions. */
  currentUserRole?: ProjectRole;
  /** Owner-only: restore a soft-deleted Space via collab `space:restore` RPC. */
  onRestoreSpace?: (spaceId: string) => Promise<void> | void;
  /** Owner-only: clear all entries in `meta.projectMessages`. */
  onClearMessages?: () => Promise<void> | void;
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
}

/**
 * Space tab bar — chrome-baseline mock `.space-header` (40px).
 *
 * Layout (mock § space-header):
 *   [agent-toggle | divider] [scroll-left] [.space-tabs] [scroll-right]
 *   [divider | new-space + drawer + project-messages]
 *
 * Scroll arrows hide when content doesn't overflow + show disabled
 * state at boundaries (industry standard pattern per mock v4.27/v4.29).
 */
const EMPTY_USERS_MAP: ReadonlyMap<string, { name: string }> = new Map();

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
  projectMessages = [],
  usersById,
  currentUserRole,
  onRestoreSpace,
  onClearMessages,
  onDeleteSpace,
  onSetSpaceLocked,
  onRenameSpace,
}: SpaceTabBarProps) {
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const toggleAgent = useUIStore((s) => s.toggleChatPanel);
  const agentOpen = !collapsed;
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  // Q11 v2 — ProjectMessagesButton renders display names via O(1) Map
  // lookup against the live `meta.spaces` Y.Map. Build the lookup
  // here from the array `allSpaces` (already supplied for the drawer)
  // so the bell needn't iterate the array per message at render time.
  const spacesById = React.useMemo(() => {
    const m = new Map<string, { name: string }>();
    for (const s of allSpaces) m.set(s.id, { name: s.name });
    return m;
  }, [allSpaces]);

  // Track scroll overflow + boundaries to drive the smart-hide/disabled
  // states for the left / right scroll arrows (mock v4.27 / v4.29).
  const [scrollState, setScrollState] = React.useState({
    overflow: false,
    atStart: true,
    atEnd: true,
  });

  const updateScrollState = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // atStart / atEnd are DOM-rect-based — same yardstick as the
    // `scrollOneTab` algorithm below, so the arrow's enabled predicate
    // ("can we still scroll?") always matches what the arrow click
    // would actually do ("is there a tab left to bring on-screen?").
    //
    // Why not scrollLeft-based (prior approach, commit 626ec56 + 4870de6):
    // smooth `scrollIntoView({ inline: 'start' })` lands scrollLeft at
    // the scroller's content-area edge — that's `padding-left` (~8 px
    // with `padding: 0 var(--space-2)`), NOT zero. A `scrollLeft <= 1`
    // boundary check therefore stayed false at the visual left edge,
    // leaving the arrow stuck enabled. Mouse-wheel scroll did snap to
    // scrollLeft=0 (browser clamp), which is why the bug only showed
    // up via arrow clicks. DOM rects sidestep the scroll-position
    // arithmetic entirely.
    const overflow = el.scrollWidth > el.clientWidth + 1;
    const scrollerRect = el.getBoundingClientRect();
    const tabs = Array.from(el.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement,
    );
    const atStart = !tabs.some(
      (t) => t.getBoundingClientRect().left < scrollerRect.left - 1,
    );
    const atEnd = !tabs.some(
      (t) => t.getBoundingClientRect().right > scrollerRect.right + 1,
    );
    setScrollState({ overflow, atStart, atEnd });
  }, []);

  React.useEffect(() => {
    updateScrollState();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      ro.disconnect();
    };
  }, [updateScrollState, spaces.length]);

  // When the active space changes (e.g. user picks a space from the
  // drawer), make sure the corresponding tab is visible inside the
  // scrollable tab strip. Without this, picking an off-screen space
  // from the drawer left the tab bar frozen and the user with no
  // visual confirmation that the selection landed.
  //
  // `inline: 'nearest'` is the key choice: it scrolls only as much
  // as needed (the tab snaps to the nearest edge of the scroller),
  // matching the standard IDE / browser tab strip behavior.
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !activeSpaceId) return;
    const activeTab = scroller.querySelector(
      `[data-testid="space-tab-${activeSpaceId}"]`,
    );
    if (activeTab instanceof HTMLElement) {
      activeTab.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeSpaceId]);

  /**
   * Scroll one tab into view (point-and-scroll model, IDE / browser tab
   * strip standard).
   *
   * Why not a fixed pixel `scrollBy(±120)` like the prior implementation:
   * tab width is content-driven (short "Main" ≈ 60px, long "你叫什么名字
   * ..." ≈ 280px). A fixed delta either over- or under-scrolls; long-name
   * tabs took 2–3 clicks to fully reveal (PR #140 user report 2026-05-25).
   *
   * Algorithm:
   *   - **right**: find the first tab whose right edge sits beyond the
   *     scroller's right edge → `scrollIntoView({ inline: 'end' })` snaps
   *     it flush right.
   *   - **left**: find the last tab whose left edge sits before the
   *     scroller's left edge → `scrollIntoView({ inline: 'start' })`
   *     snaps it flush left.
   *
   * A 1-px tolerance absorbs sub-pixel rounding from CSS gap / padding.
   */
  const scrollOneTab = (direction: 'left' | 'right') => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const tabs = Array.from(scroller.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    if (tabs.length === 0) return;
    const scrollerRect = scroller.getBoundingClientRect();

    const target =
      direction === 'right'
        ? tabs.find(
            (tab) =>
              tab.getBoundingClientRect().right > scrollerRect.right + 1,
          )
        : [...tabs]
            .reverse()
            .find(
              (tab) =>
                tab.getBoundingClientRect().left < scrollerRect.left - 1,
            );

    target?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: direction === 'right' ? 'end' : 'start',
    });
  };

  const ArrowButton = ({
    direction,
    onClick,
    disabled,
  }: {
    direction: 'left' | 'right';
    onClick: () => void;
    disabled: boolean;
  }) => (
    <Button
      variant='chrome-ghost'
      size='chrome'
      aria-label={direction === 'left' ? 'Scroll tabs left' : 'Scroll tabs right'}
      onClick={onClick}
      disabled={disabled}
      data-testid={direction === 'left' ? 'tabs-scroll-left' : 'tabs-scroll-right'}
      className={cn(
        !scrollState.overflow && 'hidden',
        // Slight stronger dim (35%) than Button primitive's default
        // (50%) so a disabled arrow visually recedes against the tab
        // bar bg. Cursor + click-swallow are handled by the Button
        // primitive (PR #137 dropped vendor `disabled:pointer-events-
        // none`; see `components/ui/button.tsx`).
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

  return (
    // ARIA structure: outer container is a `toolbar` because it mixes
    // tabs (the space list) with chrome controls (agent toggle, new,
    // drawer, project-messages, scroll arrows). The actual `role='tablist'` is
    // nested around just the SpaceTab list below, satisfying
    // axe-core's `aria-required-children` rule (a tablist may only
    // contain `role='tab'` children).
    <div
      data-testid='space-tab-bar'
      role='toolbar'
      aria-label='Spaces'
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
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label={agentOpen ? 'Hide agent column' : 'Show agent column'}
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
      </div>

      <ArrowButton
        direction='left'
        onClick={() => scrollOneTab('left')}
        disabled={scrollState.atStart}
      />

      <div
        ref={scrollerRef}
        className='flex flex-1 items-center overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        style={{
          gap: 'var(--space-1)',
          minWidth: 0,
          height: '100%',
          padding: '0 var(--space-2)',
        }}
        role='tablist'
        aria-label='Open spaces'
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
      </div>

      <ArrowButton
        direction='right'
        onClick={() => scrollOneTab('right')}
        disabled={scrollState.atEnd}
      />

      <div
        className='flex shrink-0 items-center border-l border-border'
        style={{
          gap: 'var(--space-2)',
          paddingLeft: 'var(--space-4)',
          marginLeft: 'var(--space-2)',
        }}
        data-testid='space-header-right'
      >
        <NewSpaceDialog
          onCreate={onCreate}
          trigger={
            <Button
              variant='chrome-ghost'
              size='chrome'
              aria-label='New space'
              data-testid='new-space-button'
              style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
            >
              <Plus className='h-[18px] w-[18px]' />
            </Button>
          }
        />
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
        <ProjectMessagesButton
          messages={projectMessages}
          usersById={usersById ?? EMPTY_USERS_MAP}
          spacesById={spacesById}
          currentUserRole={currentUserRole}
          onRestore={onRestoreSpace}
          onClearAll={onClearMessages}
        />
      </div>
    </div>
  );
}
