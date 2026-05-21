import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ProjectSpace } from '@/data/yjs/project-meta';
import type { SpaceType } from '@/spaces';
import { useUIStore } from '@/stores';
import { NewSpaceDialog } from '@/pages/project/chrome/tab-bar/NewSpaceDialog';
import { SpaceDrawer } from '@/pages/project/chrome/tab-bar/SpaceDrawer';
import { SpaceHistoryButton } from '@/pages/project/chrome/tab-bar/SpaceHistoryButton';
import { SpaceTab } from '@/pages/project/chrome/tab-bar/SpaceTab';

interface SpaceTabBarProps {
  /** Tabs currently open in the bar (resolved from per-user openTabIds). */
  spaces: ReadonlyArray<ProjectSpace>;
  /** All Spaces in the project — used by the drawer to list everything. */
  allSpaces: ReadonlyArray<ProjectSpace>;
  /** Per-user open tab id list, for the drawer's status chip computation. */
  openTabIds: ReadonlyArray<string>;
  activeSpaceId: string;
  /** Project id — drawer passes this to spacesApi for lock / delete. */
  projectId: string;
  onActivate: (id: string) => void;
  /** Returns a promise so the dialog can show progress and report errors. */
  onCreate: (type: SpaceType, name: string) => Promise<void> | void;
  /** Close a tab — does NOT delete the Space, just removes from the bar. */
  onClose?: (id: string) => void;
  /** Open the read-only preview sheet for a Space (drawer 查看 action). */
  onViewSpace: (id: string) => void;
}

/**
 * Space tab bar — chrome-baseline mock `.space-header` (40px).
 *
 * Layout (mock § space-header):
 *   [agent-toggle | divider] [scroll-left] [.space-tabs] [scroll-right]
 *   [divider | new-space + drawer + history]
 *
 * Scroll arrows hide when content doesn't overflow + show disabled
 * state at boundaries (industry standard pattern per mock v4.27/v4.29).
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
}: SpaceTabBarProps) {
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const toggleAgent = useUIStore((s) => s.toggleChatPanel);
  const agentOpen = !collapsed;
  const scrollerRef = React.useRef<HTMLDivElement>(null);

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
    const overflow = el.scrollWidth > el.clientWidth + 1;
    const atStart = el.scrollLeft <= 0;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
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

  const scrollBy = (delta: number) => {
    scrollerRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
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
        disabled && 'pointer-events-none opacity-35',
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
    <div
      data-testid='space-tab-bar'
      role='tablist'
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
        onClick={() => scrollBy(-120)}
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
          />
        ))}
      </div>

      <ArrowButton
        direction='right'
        onClick={() => scrollBy(120)}
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
        />
        <SpaceHistoryButton />
      </div>
    </div>
  );
}
