// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Hover preview for a reference chip (user 2026-07-10 item 3 + spec §9.1):
 * hovering a reference-rail chip or a prompt `@` chip pops a larger preview —
 * the source image for an image reference, the text CONTENT for a text
 * reference. Reuses the shared shadcn Tooltip (no bespoke overlay) with a
 * content-sized surface. Self-contained `TooltipProvider` so it works inside
 * the TipTap NodeView (the `@` chip), whose React subtree may not sit under
 * App.tsx's global provider.
 */

import * as React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@web/components/ui/tooltip';

/** Props for {@link ThumbnailHoverPreview}. */
export interface ThumbnailHoverPreviewProps {
  /** The image URL to preview (image / video-cover source). */
  src?: string;
  /**
   * The text body to preview (text source, spec §9.1). Used when `src` is
   * absent; long content is clamped to the same footprint as an image preview.
   */
  text?: string;
  /** Alt text for an image preview. */
  alt: string;
  /**
   * Shown when the source is EMPTY (no `src`, no `text`) — a hint that the node
   * is not yet generated / uploaded, so the user knows why the reference is
   * blank instead of seeing nothing (user 2026-07-12 H). Absent → no preview.
   */
  emptyHint?: string;
  /** The trigger element (the chip). Must accept a ref + hover handlers. */
  children: React.ReactNode;
}

/**
 * Wraps a chip so hovering it previews the source content — an image when
 * `src` is present, the text body when only `text` is. With neither (an empty
 * source) it renders the trigger unchanged — no preview.
 * @param root0 - Component props.
 * @param root0.src - The image URL to preview.
 * @param root0.text - The text body to preview (used when `src` is absent).
 * @param root0.alt - Alt text for an image preview.
 * @param root0.emptyHint - Hint shown when the source is empty (no src/text).
 * @param root0.children - The trigger element (the chip).
 * @returns The trigger with (when it has content) a hover preview.
 */
export function ThumbnailHoverPreview({
  src,
  text,
  alt,
  emptyHint,
  children,
}: ThumbnailHoverPreviewProps): React.JSX.Element {
  // Empty source AND no hint → render the trigger unchanged (no preview). An
  // empty source WITH a hint shows the hint so the user learns the node is not
  // yet filled (H) rather than getting no feedback at all.
  if (!src && !text && !emptyHint) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side='top'
          className='overflow-hidden border border-border bg-popover p-1'
        >
          {src ? (
            <img
              src={src}
              alt={alt}
              className='max-h-[220px] max-w-[220px] rounded-sm object-contain'
              draggable={false}
            />
          ) : text ? (
            <div className='max-h-[220px] max-w-[220px] overflow-hidden whitespace-pre-wrap p-1 text-xs text-popover-foreground'>
              {text}
            </div>
          ) : (
            <div className='px-2 py-1 text-xs text-muted-foreground'>
              {emptyHint}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
