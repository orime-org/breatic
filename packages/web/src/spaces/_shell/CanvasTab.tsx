/**
 * CanvasTab — single tab in the Tab Bar.
 *
 * Renders the space name + a kind glyph; clicking switches the active
 * space. The active tab is visually emphasized; the close affordance
 * appears on hover for non-active, non-only-tab tabs (we don't allow
 * the user to close the only tab in V1 — the project would have no
 * active space).
 *
 * Rename / lock / per-tab context menu are deferred to a follow-up
 * (the Drawer carries those richer affordances).
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Space } from '@breatic/shared';
import { cn } from '@/utils/classnames';

const CloseGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3" aria-hidden>
    <line x1="12" y1="4" x2="4" y2="12" />
    <line x1="4" y1="4" x2="12" y2="12" />
  </svg>
);

const KindGlyph = ({ kind }: { kind: Space['type'] }) => {
  if (kind === 'canvas') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3" aria-hidden>
        <rect x="2" y="2" width="12" height="12" rx="1.5" />
        <path d="M2 6h12M6 2v12" />
      </svg>
    );
  }
  if (kind === 'document') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3" aria-hidden>
        <path d="M9 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5z" />
        <polyline points="9 1 9 5 13.5 5" />
      </svg>
    );
  }
  // timeline
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-3 h-3" aria-hidden>
      <line x1="2" y1="5" x2="14" y2="5" />
      <line x1="2" y1="11" x2="14" y2="11" />
      <circle cx="6" cy="5" r="1" fill="currentColor" />
      <circle cx="11" cy="11" r="1" fill="currentColor" />
    </svg>
  );
};

export interface CanvasTabProps {
  space: Space;
  isActive: boolean;
  /** When true, the close affordance is hidden (the only tab can't be closed in V1). */
  hideClose?: boolean;
  onClick: () => void;
  onClose: () => void;
}

const CanvasTab: React.FC<CanvasTabProps> = memo(function CanvasTab({
  space,
  isActive,
  hideClose,
  onClick,
  onClose,
}) {
  const { t } = useTranslation();
  return (
    <div
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      className={cn(
        'group relative flex items-center gap-1.5 h-8 pl-2.5 pr-1.5 rounded-t-md cursor-pointer select-none transition-colors',
        'border-l border-r border-t',
        isActive
          ? 'bg-[var(--color-background-default-base)] border-[var(--color-border-default-base)] -mb-px z-10'
          : 'bg-[var(--color-background-default-secondary)] border-transparent hover:bg-[var(--color-background-default-base)]/60',
      )}
    >
      <span
        className={cn(
          isActive ? 'text-brand-base' : 'text-[var(--color-text-default-tertiary)]',
        )}
      >
        <KindGlyph kind={space.type} />
      </span>
      <span
        className={cn(
          'text-[12px] font-medium max-w-[140px] truncate',
          isActive
            ? 'text-[var(--color-text-default-base)]'
            : 'text-[var(--color-text-default-secondary)]',
        )}
        title={space.name}
      >
        {space.name}
      </span>
      {!hideClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={t('spaces.tab.close')}
          className={cn(
            'inline-flex items-center justify-center w-4 h-4 rounded-sm transition-colors',
            'text-[var(--color-text-default-tertiary)] hover:bg-[var(--color-background-default-secondary)] hover:text-[var(--color-text-default-base)]',
            isActive ? 'opacity-60' : 'opacity-0 group-hover:opacity-60',
          )}
        >
          <CloseGlyph />
        </button>
      )}
    </div>
  );
});

export default CanvasTab;
