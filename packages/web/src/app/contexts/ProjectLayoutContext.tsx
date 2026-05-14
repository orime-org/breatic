/**
 * ProjectLayoutContext — UI state shared across the Project page shell
 * (TopBar / TabBar / ChatPanel / Canvas).
 *
 * V13 greenfield rewrite removes the right editor panel
 * (mock v13 = 2-col CSS grid; no rightPanel field anymore).
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface ProjectLayoutContextValue {
  /**
   * Whether the left ChatPanel is visible. Toggled from the TabBar's
   * left edge (single chat-toggle entry per 5/9 decision).
   * Page.tsx reads this to decide whether to render the chat aside.
   */
  chatPanelVisible: boolean;
  toggleChatPanel: () => void;
}

const ProjectLayoutContext = createContext<ProjectLayoutContextValue | null>(
  null,
);

export function ProjectLayoutProvider({ children }: { children: ReactNode }) {
  const [chatPanelVisible, setChatPanelVisible] = useState(true);

  const toggleChatPanel = useCallback(() => {
    setChatPanelVisible((v) => !v);
  }, []);

  const value = useMemo<ProjectLayoutContextValue>(
    () => ({ chatPanelVisible, toggleChatPanel }),
    [chatPanelVisible, toggleChatPanel],
  );

  return (
    <ProjectLayoutContext.Provider value={value}>
      {children}
    </ProjectLayoutContext.Provider>
  );
}

/**
 * Read the project layout context. Throws if used outside a provider —
 * surfaces missing-provider bugs early instead of returning a default
 * value that silently breaks downstream behavior.
 */
export function useProjectLayout(): ProjectLayoutContextValue {
  const ctx = useContext(ProjectLayoutContext);
  if (!ctx) {
    throw new Error('useProjectLayout must be used within ProjectLayoutProvider');
  }
  return ctx;
}
