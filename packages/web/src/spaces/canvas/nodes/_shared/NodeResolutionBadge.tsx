// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { cn } from '@web/lib/utils';

/** Intrinsic pixel size of a media node's content (image or video). */
export interface NodeResolution {
  width: number;
  height: number;
}

/**
 * Formats a pixel resolution as `<w>×<h>` using the × multiplication sign
 * (U+00D7), e.g. `1920×1080`. The aspect ratio is deliberately omitted — the
 * dimensions already imply it, and arbitrary resolutions (common in AI output)
 * reduce to meaningless ratios (decision #1616: no ratio).
 * @param width - Intrinsic pixel width.
 * @param height - Intrinsic pixel height.
 * @returns The `<w>×<h>` resolution string.
 */
export function formatResolution(width: number, height: number): string {
  return `${width}×${height}`;
}

interface NodeResolutionBadgeProps {
  /** Intrinsic pixel width of the media. */
  width: number;
  /** Intrinsic pixel height of the media. */
  height: number;
  /** Selected — deepens/brightens to match the node name header. */
  selected?: boolean;
}

/**
 * The pixel-resolution badge floated above a media node's top-right corner,
 * mirroring the {@link NodeHeader} name (top-left): same `text-xs` size and the
 * same selected/muted foreground tokens, so both read as one label pair. Pure
 * presentational — the anchoring + zoom counter-scale live in the parent frame
 * (mirroring how the name header's anchor lives in `ContentNodeFrame`).
 * @param root0 - Node resolution badge props.
 * @param root0.width - Intrinsic pixel width of the media.
 * @param root0.height - Intrinsic pixel height of the media.
 * @param root0.selected - Whether the node is selected; deepens the text.
 * @returns The resolution badge element.
 */
export function NodeResolutionBadge({
  width,
  height,
  selected = false,
}: NodeResolutionBadgeProps): React.JSX.Element {
  return (
    <div
      data-testid='node-resolution-badge'
      className={cn(
        // `shrink-0` + `whitespace-nowrap`: the badge never shrinks or wraps in
        // the shared header row — the name yields space instead (#1616).
        'shrink-0 whitespace-nowrap px-1 text-xs',
        selected ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {formatResolution(width, height)}
    </div>
  );
}
