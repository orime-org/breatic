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
   * STATIC path (the reference rail, which re-renders on every pool change so
   * this prop is always live). For a ProseMirror NodeView chip — which does NOT
   * re-render on pool change — pass {@link ThumbnailHoverPreviewProps.resolveOnOpen}
   * instead so the body reads live at hover time.
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
  /**
   * Resolves the text body + empty hint at HOVER-OPEN time from the LIVE pool
   * (design 2026-07-12 invariant, decision C; batch-5 I5). A prompt `@` chip is
   * a ProseMirror NodeView that does not re-render when the source text node's
   * body changes (its body is deliberately not frozen into a synced attr — that
   * would duplicate it into the Yjs prompt doc). Reading on open keeps the hover
   * a live projection of the source without any cached copy. When present it
   * OVERRIDES {@link ThumbnailHoverPreviewProps.text} /
   * {@link ThumbnailHoverPreviewProps.emptyHint} and the wrapper always mounts
   * (content is unknown until open).
   */
  resolveOnOpen?: () => { text?: string; emptyHint?: string };
  /** The trigger element (the chip). Must accept a ref + hover handlers. */
  children: React.ReactNode;
}

/**
 * Wraps a chip so hovering it previews the source content — an image when
 * `src` is present, the text body otherwise. The text body + empty hint come
 * from the static `text` / `emptyHint` props (the rail, always live because it
 * re-renders) OR, for a NodeView chip, are resolved live at open via
 * `resolveOnOpen` (decision C). With no content and no resolver it renders the
 * trigger unchanged — no preview.
 * @param root0 - Component props.
 * @param root0.src - The image URL to preview.
 * @param root0.text - The static text body to preview (used when `src` is absent).
 * @param root0.alt - Alt text for an image preview.
 * @param root0.emptyHint - Static hint shown when the source is empty (no src/text).
 * @param root0.resolveOnOpen - Live text/hint resolver read at hover-open (overrides text/emptyHint).
 * @param root0.children - The trigger element (the chip).
 * @returns The trigger with (when it has content) a hover preview.
 */
export function ThumbnailHoverPreview({
  src,
  text,
  alt,
  emptyHint,
  resolveOnOpen,
  children,
}: ThumbnailHoverPreviewProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  // Live-at-open (decision C): re-resolve the body/hint from the pool each time
  // the tooltip opens, so the chip's preview reflects the source's CURRENT
  // content without the NodeView ever re-rendering. Static props are the
  // fallback for the rail path (no resolver).
  const resolved = open && resolveOnOpen ? resolveOnOpen() : undefined;
  const previewText = resolved ? resolved.text : text;
  const previewHint = resolved ? resolved.emptyHint : emptyHint;
  // Empty source AND no hint AND no live resolver → render the trigger unchanged
  // (no preview). With a resolver the wrapper always mounts because the content
  // is unknown until open.
  if (!src && !text && !emptyHint && !resolveOnOpen) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip onOpenChange={setOpen}>
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
          ) : previewText ? (
            <div className='max-h-[220px] max-w-[220px] overflow-hidden whitespace-pre-wrap p-1 text-xs text-popover-foreground'>
              {previewText}
            </div>
          ) : (
            <div className='px-2 py-1 text-xs text-muted-foreground'>
              {previewHint}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
