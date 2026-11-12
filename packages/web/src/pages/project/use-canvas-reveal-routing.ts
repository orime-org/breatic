// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';

/**
 * Open the canvas a "View" press names (#1411 design 5.4), or switch to it;
 * the canvas takes the request up once it has loaded. A request for a Space
 * that is gone or is not a canvas is dropped. The canvas is opened once per
 * request; once it has been in front, the user moving to another tab drops the
 * request, as a document card's "View" ends when its document is left. Judged
 * only once the project's Spaces have arrived, like the document cards.
 * @param spaces - The project's Spaces.
 * @param activeId - The Space in front, if any.
 * @param open - Opens a Space's tab, or switches to it.
 * @param ready - Whether the project's Spaces have arrived.
 */
export function useCanvasRevealRouting(
  spaces: readonly ProjectSpace[],
  activeId: string | null,
  open: (spaceId: string) => void,
  ready: boolean,
): void {
  const request = useCanvasRevealStore((s) => s.request);
  // The request this hook already opened a canvas for, and whether that canvas has been in front since.
  const routed = React.useRef<{ request: typeof request; front: boolean } | null>(null);
  React.useEffect(() => {
    if (!ready || request === null) return;
    if (spaces.find((space) => space.id === request.spaceId)?.type !== 'canvas') {
      useCanvasRevealStore.setState({ request: null });
      return;
    }
    const was = routed.current?.request === request ? routed.current : null;
    if (was === null) {
      routed.current = { request, front: activeId === request.spaceId };
      if (activeId !== request.spaceId) open(request.spaceId);
    } else if (activeId === request.spaceId) {
      was.front = true;
    } else if (was.front) {
      useCanvasRevealStore.setState({ request: null });
    }
  }, [activeId, open, ready, request, spaces]);
}
