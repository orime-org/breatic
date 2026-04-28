import { useMemo } from 'react';
import type { HistoryItem } from '@breatic/shared';

/**
 * Resolve the history item currently published to canvas for a node.
 *
 * Returns `undefined` when:
 *   - `data` is undefined
 *   - `activeHistoryId` is unset
 *   - the referenced item is not found in `history` (dangling pointer)
 *
 * @param data - The node's `data` object (from `useCanvasData` → node.data).
 * @returns The active `HistoryItem`, or `undefined`.
 */
export function useActiveHistoryItem(
  data: { activeHistoryId?: string; history: HistoryItem[] } | undefined,
): HistoryItem | undefined {
  return useMemo(() => {
    if (!data?.activeHistoryId) return undefined;
    return (data.history ?? []).find((h) => h.id === data.activeHistoryId);
  }, [data?.activeHistoryId, data?.history]);
}
