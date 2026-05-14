/**
 * Project page shell — V13 greenfield rewrite (M0).
 *
 * Layout: vertical stack (TopBar / TabBar / 2-col grid).
 * Grid: 320px ChatPanel + 1fr Canvas; collapses to single column
 * when ChatPanel is hidden.
 *
 * All four regions are placeholders in M0 — real implementations
 * land in M1 (TopBar / TabBar / Canvas shell) and M2 (ChatPanel).
 */

import { useTranslation } from 'react-i18next';
import {
  ProjectLayoutProvider,
  useProjectLayout,
} from '@/app/contexts/ProjectLayoutContext';

function ProjectShell() {
  const { t } = useTranslation();
  const { chatPanelVisible } = useProjectLayout();
  const gridCols = chatPanelVisible
    ? 'grid-cols-[320px_1fr]'
    : 'grid-cols-1';

  return (
    <div className='flex h-screen flex-col bg-background text-foreground'>
      <header
        data-testid='top-bar'
        className='flex h-12 items-center border-b border-border px-4 text-sm text-muted-foreground'
      >
        {t('project.shell.topBar')}
      </header>
      <nav
        data-testid='tab-bar'
        className='flex h-10 items-center border-b border-border px-4 text-sm text-muted-foreground'
      >
        {t('project.shell.tabBar')}
      </nav>
      <div className={`grid min-h-0 flex-1 ${gridCols}`}>
        {chatPanelVisible && (
          <aside
            data-testid='chat-panel'
            className='flex min-w-0 items-center justify-center border-r border-border text-sm text-muted-foreground'
          >
            {t('project.shell.chatPanel')}
          </aside>
        )}
        <main
          data-testid='canvas'
          className='flex min-w-0 items-center justify-center text-sm text-muted-foreground'
        >
          {t('project.shell.canvas')}
        </main>
      </div>
    </div>
  );
}

export default function ProjectPage() {
  return (
    <ProjectLayoutProvider>
      <ProjectShell />
    </ProjectLayoutProvider>
  );
}
