/**
 * CreditsPill — top-bar entry point showing the user's current credit
 * balance, doubling as a "buy more" trigger when clicked.
 *
 * - Reads `userInfo.total_credits` from the redux user-center slice.
 * - Below `LOW_THRESHOLD` switches to a brand-tinted "low balance"
 *   variant so the user notices before mini-tools start failing the
 *   pre-flight credit check.
 * - Clicking opens `RechargeDialog`. The pill itself does not fetch
 *   tiers — that's the dialog's job, kept lazy.
 *
 * The star / plus glyphs are inline SVG (mock 05 alignment) rather
 * than sprite icons because the sprite sheet doesn't include these
 * generic icons yet. Centralizing them into `assets/svg/base/` is a
 * follow-up (PR9 visual audit).
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useUserCenterStore } from '@/app/hooks/useUserCenterStore';
import { cn } from '@/utils/classnames';

const LOW_THRESHOLD = 100;

const StarGlyph = ({ className }: { className?: string }) => (
  <svg viewBox='0 0 24 24' fill='currentColor' stroke='none' className={className} aria-hidden>
    <polygon points='12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26' />
  </svg>
);

const PlusGlyph = ({ className }: { className?: string }) => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' className={className} aria-hidden>
    <line x1='12' y1='5' x2='12' y2='19' />
    <line x1='5' y1='12' x2='19' y2='12' />
  </svg>
);

export interface CreditsPillProps {
  /** Click handler — typically opens RechargeDialog. */
  onClick?: () => void;
  className?: string;
}

const CreditsPill = memo(function CreditsPill({ onClick, className }: CreditsPillProps) {
  const { t } = useTranslation();
  const { userInfo } = useUserCenterStore();
  const balance = userInfo?.total_credits ?? 0;
  const isLow = balance < LOW_THRESHOLD;

  return (
    <button
      type='button'
      onClick={onClick}
      aria-label={t('credits.pill.aria_label')}
      className={cn(
        'inline-flex items-center gap-1.5 h-[30px] pl-2.5 pr-1 rounded-full border text-xs transition-colors',
        isLow
          ? 'bg-status-warning/10 border-status-warning/40 text-status-warning hover:bg-status-warning/15'
          : 'bg-neutral-50 border-neutral-200 text-neutral-700 hover:bg-neutral-100 hover:border-neutral-300',
        className,
      )}
    >
      <StarGlyph className={cn('w-3 h-3', isLow ? 'text-status-warning' : 'text-neutral-900')} />
      <span className='font-mono font-semibold tabular-nums min-w-[32px]'>
        {balance.toLocaleString()}
      </span>
      <span
        className={cn(
          'w-5 h-5 rounded-full inline-flex items-center justify-center',
          isLow ? 'bg-neutral-900 text-text-on-button-base' : 'bg-neutral-200 text-neutral-600',
        )}
      >
        <PlusGlyph className='w-2.5 h-2.5' />
      </span>
    </button>
  );
});

export default CreditsPill;
