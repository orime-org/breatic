/**
 * BackToWorkspaceLink — the `< Workspace` link in the TopBar left
 * cluster. Sits between the logo and the breadcrumb `/` separator
 * (mock 05 @1096-1099).
 *
 * Navigates with a plain `window.location.href` rather than the
 * router because Workspace is a different route tree (auth-bound
 * landing) and we want the page reload to flush any project-scoped
 * caches (Yjs providers, ChipsPickContext, etc.) on the way out.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const ChevronLeftGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const BackToWorkspaceLink: React.FC = memo(function BackToWorkspaceLink() {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => {
        window.location.href = '/workspace';
      }}
      title={t('project.header.backToWorkspace', { defaultValue: 'Back to Workspace' })}
      className="inline-flex items-center gap-1 text-[13px] text-text-default-secondary px-2 py-1 rounded-sm hover:bg-background-default-secondary hover:text-text-default-base transition-colors"
    >
      <ChevronLeftGlyph />
      <span>{t('project.header.workspace', { defaultValue: 'Workspace' })}</span>
    </button>
  );
});

export default BackToWorkspaceLink;
