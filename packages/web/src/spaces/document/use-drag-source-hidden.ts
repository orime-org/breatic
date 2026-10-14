// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Hides a drag's source handle while its drag runs (inner#1350 §5.2).
 *
 * The handle is kept in the page for the drag, so its `dragend` reaches the
 * document, but frozen it no longer follows its rows as the body scrolls under
 * the drag, so it is hidden. Not during the `dragstart` itself: a source
 * hidden then makes Chrome cancel the drag (measured on the block handle,
 * inner#1350), so it goes from the next frame, once the drag is under way —
 * the same reason Pragmatic drag and drop calls its `onDragStart` a frame
 * after the native one.
 */

import * as React from 'react';

/** The hidden flag and the two moments that change it. */
export interface DragSourceHidden {
  /** Whether the handle is hidden. */
  readonly hidden: boolean;
  /** Hides it from the next frame on; call in `dragstart`. */
  readonly hideAfterStart: () => void;
  /** Shows it again; call when the drag ends. */
  readonly show: () => void;
}

/**
 * Hides a drag's source from the frame after its drag starts until it ends.
 * @returns The flag and its setters.
 */
export function useDragSourceHidden(): DragSourceHidden {
  const [hidden, setHidden] = React.useState(false);
  const frame = React.useRef<number | null>(null);
  const cancel = React.useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const hideAfterStart = React.useCallback((): void => {
    cancel();
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setHidden(true);
    });
  }, [cancel]);
  const show = React.useCallback((): void => {
    cancel();
    setHidden(false);
  }, [cancel]);
  React.useEffect(() => cancel, [cancel]);
  return React.useMemo(() => ({ hidden, hideAfterStart, show }), [hidden, hideAfterStart, show]);
}
