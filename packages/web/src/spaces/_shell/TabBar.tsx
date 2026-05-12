/**
 * TabBar — horizontal Tab strip across the top of the Space area.
 *
 * Layout aligned with `design/project/mocks/05-canvas-native-tailwind.html`
 * (CanvasTabBar @1162):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ [chat] │ ← │ tab tab tab …  │ → │ [+] [≡] [🔔]          │
 *   └──────────────────────────────────────────────────────────┘
 *
 *   - left chat-toggle (single entry per spec §10.18 ADR
 *     `2026-05-09-chat-toggle-single-entry.md`)
 *   - left/right scroll arrows for overflow
 *   - tabs scrollable strip (active scrolls into view)
 *   - right action group: new tab + drawer + system messages bell
 *
 * The drawer button and the system-messages bell are wired as no-op
 * placeholders in this PR — they ship visually so the right-action
 * group reads correctly, but the drawer panel + meta.systemMessages
 * backend land in follow-up PRs (drawer = V1 todo, bell = PR-Y3).
 *
 * Sources of truth:
 *   - tab list:    `meta.spaces`
 *   - active tab:  parent's `useTabState`-driven activeSpaceId
 *   - chat visibility: `ProjectLayoutContext.chatPanelVisible`
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Space } from '@breatic/shared';
import { cn } from '@/utils/classnames';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';
import CanvasTab from './CanvasTab';

const PlusGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3.5 h-3.5" aria-hidden>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const ChevronLeftGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ChevronRightGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const ChatToggleGlyph = () => (
  // Sidebar toggle pictogram — vertical bar at left of a rounded rect
  // matches the mock @1232 closely enough for "show/hide left panel".
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

const DrawerGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5" aria-hidden>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const BellGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

export interface TabBarProps {
  spaces: Space[];
  activeSpaceId: string | null;
  onSelect: (spaceId: string) => void;
  onClose: (spaceId: string) => void;
  onNewSpace: () => void;
  /** Optional opt-out for the chat toggle when the page has no chat. */
  showChatToggle?: boolean;
  className?: string;
}

const ICON_BTN =
  'w-7 h-7 inline-flex items-center justify-center rounded-sm transition-colors flex-shrink-0 ' +
  'text-[var(--color-text-default-secondary)] hover:bg-[var(--color-background-default-secondary)] hover:text-[var(--color-text-default-base)]';
const ARROW_BTN =
  'w-6 h-7 inline-flex items-center justify-center rounded-sm transition-colors flex-shrink-0 ' +
  'text-[var(--color-text-default-secondary)] hover:bg-[var(--color-background-default-secondary)] hover:text-[var(--color-text-default-base)] ' +
  'disabled:opacity-30 disabled:pointer-events-none';

const TabBar: React.FC<TabBarProps> = memo(function TabBar({
  spaces,
  activeSpaceId,
  onSelect,
  onClose,
  onNewSpace,
  showChatToggle = true,
  className,
}) {
  const { t } = useTranslation();
  const { chatPanelVisible, toggleChatPanel } = useProjectLayout();
  const visible = spaces;
  const onlyOne = visible.length <= 1;

  // Scroll arrow visibility — mirrors mock CanvasTabBar @1167 logic.
  // We poll the scroll container's `scrollLeft` / `scrollWidth` and
  // toggle arrow disabled state. ResizeObserver covers width changes
  // (e.g. chat collapsing widens the strip).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    checkScroll();
  }, [visible.length, checkScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkScroll);
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  // Auto-scroll active tab into view (mock @1188).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeSpaceId) return;
    const active = el.querySelector(`[data-space-id="${activeSpaceId}"]`);
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeSpaceId]);

  // Scroll by "next clipped tab" rather than fixed px (mock @1197) —
  // gives a precise step regardless of tab width.
  const scrollOneTab = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const tabs = Array.from(el.querySelectorAll('[data-space-id]'));
    const containerRect = el.getBoundingClientRect();
    if (direction === 'right') {
      for (const tab of tabs) {
        const r = tab.getBoundingClientRect();
        if (r.right > containerRect.right + 1) {
          tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
          return;
        }
      }
    } else {
      for (let i = tabs.length - 1; i >= 0; i--) {
        const tab = tabs[i];
        const r = tab.getBoundingClientRect();
        if (r.left < containerRect.left - 1) {
          tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
          return;
        }
      }
    }
  }, []);

  return (
    <div
      role="tablist"
      className={cn(
        'relative flex items-center gap-1 h-10 px-3',
        'bg-[var(--color-background-default-base)]',
        'border-b border-[var(--color-border-default-base)]',
        'flex-shrink-0',
        className,
      )}
    >
      {showChatToggle && (
        <>
          <button
            type="button"
            onClick={toggleChatPanel}
            title={
              chatPanelVisible
                ? t('spaces.tabbar.collapseChat', { defaultValue: '收起 chat 面板' })
                : t('spaces.tabbar.expandChat', { defaultValue: '展开 chat 面板' })
            }
            aria-pressed={chatPanelVisible}
            className={ICON_BTN}
          >
            <ChatToggleGlyph />
          </button>
          <div className="w-px h-5 bg-[var(--color-border-default-base)] mx-0.5 flex-shrink-0" />
        </>
      )}

      <button
        type="button"
        onClick={() => scrollOneTab('left')}
        disabled={!canScrollLeft}
        aria-label={t('spaces.tabbar.scrollLeft', { defaultValue: '向左滚动' })}
        className={ARROW_BTN}
      >
        <ChevronLeftGlyph />
      </button>

      <div
        ref={scrollRef}
        className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-hide min-w-0"
      >
        {visible.map((space) => (
          <CanvasTab
            key={space.id}
            space={space}
            isActive={space.id === activeSpaceId}
            hideClose={onlyOne}
            onClick={() => onSelect(space.id)}
            onClose={() => onClose(space.id)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => scrollOneTab('right')}
        disabled={!canScrollRight}
        aria-label={t('spaces.tabbar.scrollRight', { defaultValue: '向右滚动' })}
        className={ARROW_BTN}
      >
        <ChevronRightGlyph />
      </button>

      {/* Right action group: [+] new tab, [≡] drawer (placeholder),
          [🔔] system messages (PR-Y3 placeholder). Drawer + bell ship
          visually only — their click handlers are no-ops here so the
          layout matches the mock without committing to backend work
          that lives in separate PRs. */}
      <div className="flex items-center gap-0.5 ml-2 pl-2 border-l border-[var(--color-border-default-base)] flex-shrink-0">
        <button
          type="button"
          onClick={onNewSpace}
          aria-label={t('spaces.tab.new')}
          className={ICON_BTN}
        >
          <PlusGlyph />
        </button>
        <button
          type="button"
          aria-label={t('spaces.tabbar.drawer', { defaultValue: '所有 Spaces' })}
          title={t('spaces.tabbar.drawerSoon', { defaultValue: '所有 Spaces(即将上线)' })}
          className={cn(ICON_BTN, 'opacity-60 cursor-not-allowed')}
          disabled
        >
          <DrawerGlyph />
        </button>
        <button
          type="button"
          aria-label={t('spaces.tabbar.notifications', { defaultValue: '系统通知' })}
          title={t('spaces.tabbar.notificationsSoon', { defaultValue: '系统通知(即将上线)' })}
          className={cn(ICON_BTN, 'opacity-60 cursor-not-allowed')}
          disabled
        >
          <BellGlyph />
        </button>
      </div>
    </div>
  );
});

export default TabBar;
