// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { MediaFullscreenButton } from '@web/spaces/canvas/nodes/_shared/MediaFullscreenButton';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { ZoomCounterScaled } from '@web/spaces/canvas/nodes/_shared/ZoomCounterScaled';
import { miniToolOpenOn } from '@web/stores/canvas-session';

/** Props for `NodeMediaInset`. */
export interface NodeMediaInsetProps {
  /** The media element (image / player) to inset. */
  children: React.ReactNode;
  /** Opens the media full screen, from a button over its top-right corner. */
  onFullscreen?: () => void;
}

/**
 * Holds a canvas node's media a fixed 4px clear of the shell's 1px border.
 *
 * Media flush against the border merges with it: the picture's own edge and
 * the node's boundary become one line, so the node stops reading as a bounded
 * object on the canvas (user 2026-07-29). A constant gap of card background
 * separates the two, which is what the hover preview card has always done —
 * `HoverCardContent` carries `p-1`, and the same image inside it reads as a
 * distinct picture within a card.
 *
 * The value lives here rather than in each node so the gap cannot drift
 * between modalities; image and video share it, and any future medium that
 * fills its node adopts it by wrapping.
 *
 * On geometry: the shell is `rounded-sm` (6px) and clips its children, so
 * before this inset the media was pressed into the rounded box and had to
 * carry no radius of its own (a child radius curves faster than the border's
 * inner arc and opens corner gaps — #1550). Inset by 4px the media no longer
 * reaches those corners at all, so it stays square-cornered and the clip
 * simply never engages, matching the preview card exactly.
 *
 * The full-screen button (inner#1844) sits outside whatever transforms the
 * media and keeps its screen size at any zoom. It is left out while the
 * canvas is picking, where a press anywhere on the node picks it, and while a
 * mini-tool is open on the node, whose layer covers the picture.
 * @param root0 - Component props.
 * @param root0.children - The media element to inset.
 * @param root0.onFullscreen - Opens the media full screen.
 * @returns The media wrapped in the inset box.
 */
export function NodeMediaInset({
  children,
  onFullscreen,
}: NodeMediaInsetProps): React.JSX.Element {
  const nodeId = React.useContext(NodeIdContext);
  const mediaFree = useCanvasSession(
    (s) => s.pickSession === null && miniToolOpenOn(nodeId)(s) === null,
  );
  return (
    <div data-testid='node-media-inset' className='relative p-1'>
      {children}
      {onFullscreen && mediaFree ? (
        // Pinned to the picture's corner; the 6px gap scales with the button,
        // so neither changes on screen with the zoom.
        <ZoomCounterScaled className='absolute right-1 top-1 origin-top-right'>
          <div className='pr-1.5 pt-1.5'>
            <MediaFullscreenButton onOpen={onFullscreen} />
          </div>
        </ZoomCounterScaled>
      ) : null}
    </div>
  );
}
