/**
 * Actions shared by media node toolbars inside the local project canvas (crop modal host, duplicate node).
 */
import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';

export type CanvasNodeActionsValue = {
  /** Opens the canvas-hosted crop modal for image nodes (`1002`). */
  requestCrop: (nodeId: string) => void;
  /** Clones an image or video node with a new id and slight offset. */
  duplicateMediaNode: (nodeId: string) => void;
};

const CanvasNodeActionsContext = createContext<CanvasNodeActionsValue | null>(null);

export const CanvasNodeActionsProvider: FC<{ value: CanvasNodeActionsValue; children: ReactNode }> = ({
  value,
  children,
}) => {
  const { requestCrop, duplicateMediaNode } = value;
  const memo = useMemo(() => ({ requestCrop, duplicateMediaNode }), [requestCrop, duplicateMediaNode]);
  return <CanvasNodeActionsContext.Provider value={memo}>{children}</CanvasNodeActionsContext.Provider>;
};

/**
 * @throws When used outside {@link CanvasNodeActionsProvider}.
 */
export function useCanvasNodeActions(): CanvasNodeActionsValue {
  const v = useContext(CanvasNodeActionsContext);
  if (!v) {
    throw new Error('useCanvasNodeActions must be used under CanvasNodeActionsProvider');
  }
  return v;
}
