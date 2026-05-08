/**
 * ProjectLayoutContext — UI state for the project page right-side
 * editor panel (the "Editor Panel" of v10 §2.3).
 *
 * Used across multiple Space kinds and the chat sidebar, so it lives
 * at the project page layer rather than inside spaces/canvas/.
 *
 * Replaces the Redux `canvas` slice rightPanel fields (PR-Z).
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface RightPanelState {
  open: boolean;
  /** Discriminator for what to render in the right panel.
   *  Known values today: 'editor' (text editor / coming-soon placeholder),
   *  'page' (initial placeholder). 'history' is written by the toast
   *  stack click handler but currently has no renderer (legacy path). */
  panelType?: string;
  nodeId?: string;
  panelMode?: 'node' | 'assets';
}

interface ProjectLayoutContextValue {
  rightPanel: RightPanelState;
  openRightPanel: (panelType: string, nodeId?: string, panelMode?: 'node' | 'assets') => void;
  closeRightPanel: () => void;
}

const initialRightPanel: RightPanelState = {
  open: true,
  panelMode: 'node',
  panelType: 'page',
};

const ProjectLayoutContext = createContext<ProjectLayoutContextValue | null>(null);

export function ProjectLayoutProvider({ children }: { children: ReactNode }) {
  const [rightPanel, setRightPanel] = useState<RightPanelState>(initialRightPanel);

  const openRightPanel = useCallback(
    (panelType: string, nodeId?: string, panelMode?: 'node' | 'assets') => {
      setRightPanel({
        open: true,
        panelType,
        nodeId,
        panelMode: panelMode ?? 'node',
      });
    },
    [],
  );

  const closeRightPanel = useCallback(() => {
    setRightPanel((prev) => ({ ...prev, open: false }));
  }, []);

  const value = useMemo<ProjectLayoutContextValue>(
    () => ({ rightPanel, openRightPanel, closeRightPanel }),
    [rightPanel, openRightPanel, closeRightPanel],
  );

  return <ProjectLayoutContext.Provider value={value}>{children}</ProjectLayoutContext.Provider>;
}

export function useProjectLayout(): ProjectLayoutContextValue {
  const ctx = useContext(ProjectLayoutContext);
  if (!ctx) {
    throw new Error('useProjectLayout must be used within ProjectLayoutProvider');
  }
  return ctx;
}
