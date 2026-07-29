// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/** Props for `NodeMediaInset`. */
export interface NodeMediaInsetProps {
  /** The media element (image / player) to inset. */
  children: React.ReactNode;
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
 * @param root0 - Component props.
 * @param root0.children - The media element to inset.
 * @returns The media wrapped in the inset box.
 */
export function NodeMediaInset({
  children,
}: NodeMediaInsetProps): React.JSX.Element {
  return (
    <div data-testid='node-media-inset' className='p-1'>
      {children}
    </div>
  );
}
