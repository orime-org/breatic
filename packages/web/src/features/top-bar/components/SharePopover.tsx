/**
 * SharePopover — share / invite button in the TopBar right cluster
 * (mock 05 @1112). Placeholder shell for V1: shows a tooltip and
 * copies the project URL on click.
 *
 * The full popover (invite link with editable role + members list
 * preview) lands in a follow-up; this PR just gets the visual slot
 * in place so the cluster reads right against the mock.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { message } from '@/ui/message';

const ShareGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);

const SharePopover: React.FC = memo(function SharePopover() {
  const { t } = useTranslation();
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      message.success(t('project.header.linkCopied', { defaultValue: '链接已复制' }));
    } catch {
      message.warning(t('project.header.copyFailed', { defaultValue: '复制失败' }));
    }
  };
  return (
    <button
      type='button'
      onClick={handleClick}
      title={t('project.header.share', { defaultValue: 'Share' })}
      className='inline-flex items-center justify-center w-8 h-8 rounded-sm text-text-default-secondary hover:bg-background-default-secondary hover:text-text-default-base transition-colors'
    >
      <ShareGlyph />
    </button>
  );
});

export default SharePopover;
