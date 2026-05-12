/**
 * NotificationsBell — system messages entry point in the TopBar
 * right cluster (mock 05 @1113). Placeholder visual slot for PR-Y3
 * which lands the real `meta.systemMessages` backend + bell content.
 *
 * Disabled in this PR so the cluster looks complete without
 * pretending the feature works.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const BellGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const NotificationsBell: React.FC = memo(function NotificationsBell() {
  const { t } = useTranslation();
  return (
    <button
      type='button'
      disabled
      title={t('project.header.notificationsSoon', { defaultValue: '系统通知(即将上线)' })}
      className='inline-flex items-center justify-center w-8 h-8 rounded-sm text-text-default-secondary opacity-60 cursor-not-allowed'
    >
      <BellGlyph />
    </button>
  );
});

export default NotificationsBell;
