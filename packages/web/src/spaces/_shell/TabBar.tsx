/**
 * TabBar — horizontal Tab strip across the top of the Space area.
 *
 * Sources of truth:
 *   - tab list:    `meta.spaces` (read via parent's `useProjectMeta` /
 *                  `useProjectSpaces`)
 *   - active tab:  parent's `useTabState`-driven activeSpaceId
 *
 * Responsibilities here are intentionally small: render the strip,
 * call `onSelect` / `onClose` / `onNewSpace` callbacks. All
 * persistence (`useTabState` flush to `meta.userStates`,
 * `projectSpacesApi.create`/`remove`) lives in the parent
 * `SpaceShell`.
 *
 * V1 omits drag-reorder, rename-on-double-click, and the Drawer
 * "all spaces" overflow — those are follow-up enhancements.
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Space } from '@breatic/shared';
import { cn } from '@/utils/classnames';
import CanvasTab from './CanvasTab';

const PlusGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3.5 h-3.5" aria-hidden>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export interface TabBarProps {
  spaces: Space[];
  activeSpaceId: string | null;
  onSelect: (spaceId: string) => void;
  onClose: (spaceId: string) => void;
  onNewSpace: () => void;
  className?: string;
}

const TabBar: React.FC<TabBarProps> = memo(function TabBar({
  spaces,
  activeSpaceId,
  onSelect,
  onClose,
  onNewSpace,
  className,
}) {
  const { t } = useTranslation();
  // Only show non-deleted spaces (Space row from meta.spaces is
  // already filtered server-side via `space:deleted` removing the
  // entry; but a defensive filter doesn't hurt).
  const visible = spaces;
  const onlyOne = visible.length <= 1;

  return (
    <div
      role="tablist"
      className={cn(
        'flex items-end gap-1 h-9 px-2 bg-[var(--color-background-default-secondary)]',
        'border-b border-[var(--color-border-default-base)]',
        'overflow-x-auto scrollbar-hide',
        className,
      )}
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
      <button
        type="button"
        onClick={onNewSpace}
        aria-label={t('spaces.tab.new')}
        className={cn(
          'inline-flex items-center justify-center h-7 w-7 rounded-md',
          'text-[var(--color-text-default-secondary)] hover:bg-[var(--color-background-default-base)] hover:text-[var(--color-text-default-base)]',
          'transition-colors ml-1',
        )}
      >
        <PlusGlyph />
      </button>
    </div>
  );
});

export default TabBar;
