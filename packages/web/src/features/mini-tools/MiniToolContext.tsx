/**
 * MiniToolContext — single source of truth for "what mini-tool is
 * currently active, on which node, with which parameter values".
 *
 * Why a context: BottomToolbar lives at the canvas root (absolute
 * positioning at the bottom of the viewport, like ViewportToolbar)
 * while NodeFloatMenu lives inside individual ImageNode / VideoNode /
 * AudioNode subtrees. They have to agree on a single active tool —
 * passing props through every node component would be nightmare
 * fuel. Provider + hook keeps it tidy and lets either side reset
 * the state on Cancel / unmount / node deselect.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { defaultValues, findToolSchema } from './tool-schemas';
import type { ToolSchema } from './types';

interface MiniToolState {
  /** The node the tool is being applied to. */
  nodeId: string;
  /** Tool id (matches a row in {@link IMAGE_TOOLS} etc). */
  toolId: string;
  /** Live parameter values, keyed by `ParamConfig.id`. */
  values: Record<string, unknown>;
  /** Resolved schema cached so consumers don't re-look it up. */
  schema: ToolSchema;
}

interface MiniToolContextValue {
  active: MiniToolState | null;
  /**
   * Set the active tool. Defaults `values` from the schema when the
   * caller passes none. Replaces any previous tool wholesale —
   * picking a different tool on the same node simply overwrites.
   */
  pickTool: (
    nodeId: string,
    toolId: string,
    overrideValues?: Record<string, unknown>,
  ) => void;
  /** Update a single param. No-op when the tool isn't active. */
  setValue: (paramId: string, value: unknown) => void;
  /** Clear the active tool (Cancel / Apply success / node unmount). */
  clear: () => void;
}

const MiniToolContext = createContext<MiniToolContextValue | undefined>(undefined);

export function MiniToolProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<MiniToolState | null>(null);

  const pickTool = useCallback(
    (nodeId: string, toolId: string, overrideValues?: Record<string, unknown>) => {
      const schema = findToolSchema(toolId);
      if (!schema) {
        // Unknown tool id — ignore. Future-safe: removing a tool from
        // tool-schemas.ts won't crash callers that still reference it.
        return;
      }
      setActive({
        nodeId,
        toolId,
        values: overrideValues ?? defaultValues(schema),
        schema,
      });
    },
    [],
  );

  const setValue = useCallback((paramId: string, value: unknown) => {
    setActive((cur) =>
      cur ? { ...cur, values: { ...cur.values, [paramId]: value } } : cur,
    );
  }, []);

  const clear = useCallback(() => setActive(null), []);

  const ctx = useMemo<MiniToolContextValue>(
    () => ({ active, pickTool, setValue, clear }),
    [active, pickTool, setValue, clear],
  );

  return <MiniToolContext.Provider value={ctx}>{children}</MiniToolContext.Provider>;
}

/**
 * Read MiniToolContext. Throws if called outside the provider —
 * deliberate so misuse is caught at first render rather than failing
 * silently with a default-empty state.
 */
export function useMiniTool(): MiniToolContextValue {
  const ctx = useContext(MiniToolContext);
  if (!ctx) {
    throw new Error('useMiniTool must be used inside <MiniToolProvider>');
  }
  return ctx;
}
