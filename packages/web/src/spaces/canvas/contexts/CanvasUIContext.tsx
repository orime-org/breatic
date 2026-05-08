/**
 * CanvasUIContext — canvas-only UI state (overlay panel + comment mode).
 *
 * Mounted inside spaces/canvas/, scoped to a single canvas Space.
 *
 * Replaces the canvas-only fields of the old Redux `canvas` slice (PR-Z).
 * The cross-Space rightPanel state lives in ProjectLayoutContext.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface CanvasOverlayPanelState {
  open: boolean;
  nodeId?: string;
}

export interface CanvasCommentComposerState {
  open: boolean;
  clientX?: number;
  clientY?: number;
  flowX?: number;
  flowY?: number;
}

interface CanvasUIContextValue {
  canvasOverlayPanel: CanvasOverlayPanelState;
  openCanvasOverlayPanel: (nodeId: string) => void;
  closeCanvasOverlayPanel: () => void;
  canvasCommentMode: boolean;
  setCanvasCommentMode: (enabled: boolean) => void;
  canvasCommentComposer: CanvasCommentComposerState;
  openCanvasCommentComposer: (payload: {
    clientX: number;
    clientY: number;
    flowX: number;
    flowY: number;
  }) => void;
  closeCanvasCommentComposer: () => void;
}

const CanvasUIContext = createContext<CanvasUIContextValue | null>(null);

export function CanvasUIProvider({ children }: { children: ReactNode }) {
  const [canvasOverlayPanel, setCanvasOverlayPanel] = useState<CanvasOverlayPanelState>({
    open: false,
    nodeId: undefined,
  });
  const [canvasCommentMode, setCanvasCommentModeState] = useState<boolean>(false);
  const [canvasCommentComposer, setCanvasCommentComposer] = useState<CanvasCommentComposerState>({
    open: false,
  });

  const openCanvasOverlayPanel = useCallback((nodeId: string) => {
    setCanvasOverlayPanel({ open: true, nodeId });
  }, []);

  const closeCanvasOverlayPanel = useCallback(() => {
    setCanvasOverlayPanel({ open: false, nodeId: undefined });
  }, []);

  const setCanvasCommentMode = useCallback((enabled: boolean) => {
    setCanvasCommentModeState(enabled);
    if (!enabled) {
      setCanvasCommentComposer({ open: false });
    }
  }, []);

  const openCanvasCommentComposer = useCallback(
    (payload: { clientX: number; clientY: number; flowX: number; flowY: number }) => {
      setCanvasCommentComposer({ open: true, ...payload });
    },
    [],
  );

  const closeCanvasCommentComposer = useCallback(() => {
    setCanvasCommentComposer({ open: false });
  }, []);

  const value = useMemo<CanvasUIContextValue>(
    () => ({
      canvasOverlayPanel,
      openCanvasOverlayPanel,
      closeCanvasOverlayPanel,
      canvasCommentMode,
      setCanvasCommentMode,
      canvasCommentComposer,
      openCanvasCommentComposer,
      closeCanvasCommentComposer,
    }),
    [
      canvasOverlayPanel,
      openCanvasOverlayPanel,
      closeCanvasOverlayPanel,
      canvasCommentMode,
      setCanvasCommentMode,
      canvasCommentComposer,
      openCanvasCommentComposer,
      closeCanvasCommentComposer,
    ],
  );

  return <CanvasUIContext.Provider value={value}>{children}</CanvasUIContext.Provider>;
}

export function useCanvasUI(): CanvasUIContextValue {
  const ctx = useContext(CanvasUIContext);
  if (!ctx) {
    throw new Error('useCanvasUI must be used within CanvasUIProvider');
  }
  return ctx;
}
