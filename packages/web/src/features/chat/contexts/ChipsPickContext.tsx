/**
 * ChipsPickContext — clean React-state bridge between `ChatPanel`
 * and `ProjectCanvasContent` for the v13 "click chat → click a
 * canvas node → chip appears in chat input" flow.
 *
 * Why a new context instead of reusing the v12 `pickState`-on-Yjs
 * mechanism: v12 stored the pick mode on each canvas node's Yjs
 * `data.pickState` map (so it's visible to collaborators briefly
 * during a pick). That's a known design wart (#135) — pick state
 * is per-user UI state, not collaborative content. The v13 flow
 * goes through this context as plain React state and skips Yjs
 * entirely. B.2 will lift the v12 pickState off Yjs as the same
 * #135 cleanup; B.1 just leaves it alone (the v12 path won't
 * trigger because AgentInput isn't rendered).
 *
 * Lifecycle:
 *   1. ChatPanel calls `enterPickMode(handler)` when the user clicks
 *      "pick from canvas" — `handler` is the chip-add callback.
 *   2. ProjectCanvasContent reads `pickMode` and on the next
 *      `onNodeClick` calls `pickedNode(nodeId)`. The handler fires
 *      with the picked node's id; the host (ChatPanel) deep-clones
 *      `data` for the chip and exits pick mode.
 *   3. Esc / re-click the pick button → `exitPickMode()`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Handler invoked when the user clicks a node while pick mode is
 * active. The host decides what to do with the id (build a chip,
 * close the panel, etc.).
 */
export type ChipsPickedHandler = (nodeId: string) => void;

interface ChipsPickContextValue {
  /** True when canvas should treat the next node click as a chip pick. */
  pickMode: boolean;
  /**
   * Open pick mode and stash the callback. Re-entering replaces the
   * previous callback (uncommon — single chat panel today).
   */
  enterPickMode: (onPicked: ChipsPickedHandler) => void;
  /** Close pick mode without picking anything. Idempotent. */
  exitPickMode: () => void;
  /**
   * Called by the canvas surface when a node was clicked in pick
   * mode. Forwards to the stashed handler and auto-exits pick mode
   * so the canvas returns to normal interaction.
   */
  pickNode: (nodeId: string) => void;
}

const ChipsPickContext = createContext<ChipsPickContextValue | null>(null);

export function ChipsPickProvider({ children }: { children: ReactNode }) {
  const [pickMode, setPickMode] = useState(false);
  // Stash on a ref so opening pick mode + reading the callback stay
  // in sync within the same React tick — putting it in state would
  // make the canvas read a stale handler when pickMode flips false.
  const handlerRef = useRef<ChipsPickedHandler | null>(null);

  const enterPickMode = useCallback((onPicked: ChipsPickedHandler) => {
    handlerRef.current = onPicked;
    setPickMode(true);
  }, []);

  const exitPickMode = useCallback(() => {
    handlerRef.current = null;
    setPickMode(false);
  }, []);

  const pickNode = useCallback((nodeId: string) => {
    const handler = handlerRef.current;
    handlerRef.current = null;
    setPickMode(false);
    handler?.(nodeId);
  }, []);

  const ctx = useMemo<ChipsPickContextValue>(
    () => ({ pickMode, enterPickMode, exitPickMode, pickNode }),
    [pickMode, enterPickMode, exitPickMode, pickNode],
  );

  return <ChipsPickContext.Provider value={ctx}>{children}</ChipsPickContext.Provider>;
}

/**
 * Read the chips-pick context. Throws when called outside a
 * provider — deliberate so misuse is caught at first render
 * rather than failing silently with a no-op default.
 */
export function useChipsPick(): ChipsPickContextValue {
  const ctx = useContext(ChipsPickContext);
  if (!ctx) {
    throw new Error('useChipsPick must be used inside <ChipsPickProvider>');
  }
  return ctx;
}
