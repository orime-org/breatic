/**
 * CanvasTab — a single tab in the Tab Bar.
 *
 * Visual language matches `design/project/mocks/05-canvas-native-tailwind.html`
 * (CanvasTab @1122) — pill-style with a bottom underline on the active
 * tab, kind glyph on the left, optional lock indicator when the space
 * is locked, hover-revealed close button on the right.
 *
 * Rename / per-tab context menu are deferred to a follow-up (the
 * Drawer carries those richer affordances).
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Space } from '@breatic/shared';
import { cn } from '@/utils/classnames';

const CloseGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5" aria-hidden>
    <line x1="12" y1="4" x2="4" y2="12" />
    <line x1="4" y1="4" x2="12" y2="12" />
  </svg>
);

const LockGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 flex-shrink-0" aria-hidden>
    <rect x="3" y="7" width="10" height="7" rx="1" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" />
  </svg>
);

const KindGlyph = ({ kind }: { kind: Space['type'] }) => {
  if (kind === 'canvas') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 flex-shrink-0" aria-hidden>
        <rect x="2" y="2" width="12" height="12" rx="1.5" />
        <path d="M2 6h12M6 2v12" />
      </svg>
    );
  }
  if (kind === 'document') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 flex-shrink-0" aria-hidden>
        <path d="M9 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5z" />
        <polyline points="9 1 9 5 13.5 5" />
      </svg>
    );
  }
  // timeline
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-3 h-3 flex-shrink-0" aria-hidden>
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
      data-space-id={space.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      className={cn(
        'group relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sm cursor-pointer select-none transition-colors flex-shrink-0 max-w-[200px]',
        'text-[13px]',
        // Active tab: stronger fill + brand-coloured bottom underline
        // (via after-pseudo) per mock CanvasTab @1135.
        isActive
          ? 'bg-[var(--color-background-default-base)] text-[var(--color-text-default-base)] after:absolute after:bottom-[-9px] after:left-2 after:right-2 after:h-[2px] after:bg-brand-500 after:rounded-full'
          : 'text-[var(--color-text-default-secondary)] hover:bg-[var(--color-background-default-base)]/60 hover:text-[var(--color-text-default-base)]',
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
        className="truncate"
        title={space.name}
      >
        {space.name}
      </span>
      {space.locked && (
        <span
          className="text-[var(--color-text-default-tertiary)]"
          aria-label={t('spaces.tab.locked', { defaultValue: 'Locked' })}
        >
          <LockGlyph />
        </span>
      )}
      {!hideClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={t('spaces.tab.close')}
          className={cn(
            'inline-flex items-center justify-center w-4 h-4 rounded-full transition-colors flex-shrink-0',
            'text-[var(--color-text-default-tertiary)] hover:bg-[var(--color-background-default-secondary)] hover:text-[var(--color-text-default-base)]',
            isActive ? 'opacity-60 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <CloseGlyph />
        </button>
      )}
    </div>
  );
});

export default CanvasTab;
