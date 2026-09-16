// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * Refuse the focus change a press inside an element would otherwise cause.
 *
 * A press on anything that cannot take focus moves it to `<body>`, and for a
 * panel wrapped around a live box that is the end of whatever was being
 * written: the box blurs, and a blur is how these panels are told the person
 * is done. Padding, borders, gaps and buttons are all such surfaces, so the
 * refusal belongs on the panel rather than on each of them — measured on a
 * board, a press 4px inside a note box's own left edge, the ordinary way to
 * miss when repositioning the caret, threw away what had been typed.
 *
 * Same move as Slate's official hovering-toolbar example, whose comment reads
 * "prevent toolbar from taking focus away from editor"
 * (`site/examples/ts/hovering-toolbar.tsx`).
 *
 * A native listener rather than React's `onMouseDown`, for two reasons: the
 * same press must be refused wherever inside the panel it lands, including in
 * anything portalled or mounted into it later; and a JSX mouse handler on a
 * plain element is an interaction as far as `jsx-a11y` can tell, while this
 * is the opposite of one — nothing happens, focus simply stays put.
 *
 * `keep` decides which presses are refused. A panel whose only focusable
 * child is its own box passes one that lets that box through; a panel with no
 * focusable child at all can leave it out and refuse every press.
 * @param element - The panel to guard, or null before it mounts.
 * @param keep - Whether this press should be allowed to move focus. Called
 *   with the press; default refuses every press.
 */
export function usePressKeepsFocus(
  element: HTMLElement | null,
  keep?: (event: MouseEvent) => boolean,
): void {
  // Read through a ref so a caller can pass an inline predicate without
  // re-attaching the listener on every render.
  const keepRef = React.useRef(keep);
  keepRef.current = keep;

  React.useEffect(() => {
    if (element === null) return undefined;
    /**
     * Refuse the focus change this press would cause.
     * @param event - The press.
     */
    const onMouseDown = (event: MouseEvent): void => {
      if (keepRef.current?.(event) === true) return;
      event.preventDefault();
    };
    element.addEventListener('mousedown', onMouseDown);
    return () => {
      element.removeEventListener('mousedown', onMouseDown);
    };
  }, [element]);
}

/**
 * Whether a press landed on something that is allowed to take focus.
 *
 * The predicate {@link usePressKeepsFocus} wants for a panel built around one
 * text box: the box keeps the caret it is given, everything else in the panel
 * leaves it where it is.
 * @param event - The press.
 * @returns True when the press landed on the box itself.
 */
export function pressLandedOnTheBox(event: MouseEvent): boolean {
  return (event.target as HTMLElement | null)?.tagName === 'TEXTAREA';
}
