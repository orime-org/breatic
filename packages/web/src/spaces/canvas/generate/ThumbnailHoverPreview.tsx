// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Hover preview for a reference thumbnail (user 2026-07-10 item 3, option A):
 * hovering a reference-rail chip or a prompt `@` chip pops a larger preview of
 * the source image. Reuses the shared shadcn Tooltip (no bespoke overlay) with
 * an image-sized content surface. Self-contained `TooltipProvider` so it works
 * inside the TipTap NodeView (the `@` chip), whose React subtree may not sit
 * under App.tsx's global provider.
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
  /** The image URL to preview; when absent (non-image source) no preview shows. */
  src?: string;
  /** Alt text for the preview image. */
  alt: string;
  /** The trigger element (the chip). Must accept a ref + hover handlers. */
  children: React.ReactNode;
}

/**
 * Wraps a chip so hovering it previews the source image. With no `src` (a
 * non-image source) it renders the trigger unchanged — no preview.
 * @param root0 - Component props.
 * @param root0.src - The image URL to preview (absent = no preview).
 * @param root0.alt - Alt text for the preview image.
 * @param root0.children - The trigger element (the chip).
 * @returns The trigger with (when it has an image) a hover preview.
 */
export function ThumbnailHoverPreview({
  src,
  alt,
  children,
}: ThumbnailHoverPreviewProps): React.JSX.Element {
  if (!src) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side='top'
          className='overflow-hidden border border-border bg-popover p-1'
        >
          <img
            src={src}
            alt={alt}
            className='max-h-[220px] max-w-[220px] rounded-sm object-contain'
            draggable={false}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
