// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { arrayMove } from '@dnd-kit/sortable';

/** Where a released tab landed, said in the terms the reorder RPC takes. */
export interface TabDrop {
  /** The tab that moved. */
  spaceId: string;
  /** The tab it now sits in front of, null when it landed at the end. */
  beforeSpaceId: string | null;
}

/**
 * Turn a released drag into the move to send.
 *
 * dnd-kit says where a tab landed by naming the tab it was dropped onto, and
 * the strip it drew during the drag is `arrayMove` of that pair. The wire and
 * the server both speak in terms of the neighbour a tab sits in front of, so
 * the landed order is what this reads that neighbour off — the two descriptions
 * then describe the same strip, whichever side redraws it.
 * @param ids - The order on screen when the drag started.
 * @param activeId - The tab that was dragged.
 * @param overId - The tab it was released onto, null when released over nothing.
 * @returns The move to send, or null when nothing moved.
 */
export function resolveTabDrop(
  ids: ReadonlyArray<string>,
  activeId: string,
  overId: string | null,
): TabDrop | null {
  if (overId === null || overId === activeId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return null;
  // arrayMove leaves the dragged id at `to`, so its successor is the anchor.
  const landed = arrayMove([...ids], from, to);
  return { spaceId: activeId, beforeSpaceId: landed[to + 1] ?? null };
}
