/**
 * `ActiveCanvasSpaceContext` — current active canvas Space's Yjs
 * manager, scoped to the project page.
 *
 * Replaces the pre-v10 module-singleton (`canvasYjsRef`). Singletons
 * don't fit v10 multi-Space because a project can have several
 * canvas docs alive in the LRU pool, but only one is the user's
 * active tab. The context delivers exactly that: "manager for the
 * tab the user is currently looking at".
 *
 * Consumers (`useCanvasActions` etc.) read this once per render and
 * receive `null` while the active Space is being switched or
 * bootstrapped.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { CanvasSpaceManager } from '@/data/yjs/canvas-space';

const ActiveCanvasSpaceContext = createContext<CanvasSpaceManager | null>(null);

export function ActiveCanvasSpaceProvider({
  manager,
  children,
}: {
  manager: CanvasSpaceManager | null;
  children: ReactNode;
}) {
  return (
    <ActiveCanvasSpaceContext.Provider value={manager}>
      {children}
    </ActiveCanvasSpaceContext.Provider>
  );
}

/** @returns the active canvas Space manager, or `null` when inactive. */
export function useActiveCanvasSpace(): CanvasSpaceManager | null {
  return useContext(ActiveCanvasSpaceContext);
}
