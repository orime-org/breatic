// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Hover preview for a reference chip (user 2026-07-10 item 3 + spec §9.1):
 * hovering a reference-rail chip or a prompt `@` chip pops a larger preview —
 * the source image for an image reference, the text CONTENT for a text
 * reference. Reuses the shared shadcn Tooltip (no bespoke overlay) with a
 * content-sized surface.
 *
 * NO local `TooltipProvider` — it inherits the ONE app-level provider
 * (App.tsx). The prompt `@` chip is a TipTap NodeView, but `@tiptap/react`
 * mounts NodeViews via `ReactDOM.createPortal` into the editor's contentComponent
 * (which sits under App.tsx), and a portal inherits React context — so the
 * NodeView subtree DOES see the app provider. A local provider here (verified
 * 2026-07-17 both by `@tiptap/react` v3 source and a real-browser probe of an
 * `@` chip) was a cargo-culted assumption that split skip-delay grouping and
 * overrode the calibrated delay; `lint:single-tooltip-provider` now guards it.
 */

import * as React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

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
   * (design 2026-07-12 invariant, decision C; batch-5 I5). A prompt `@` text
   * chip is a ProseMirror NodeView that does not re-render when the source text
   * node's body changes (its body is deliberately not frozen into a synced attr
   * — that would duplicate it into the Yjs prompt doc). The resolved value is
   * cached in state (seeded at mount, refreshed on open, kept on close) so the
   * preview is live yet does not blank during the fade-out. When present it
   * OVERRIDES {@link ThumbnailHoverPreviewProps.text} /
   * {@link ThumbnailHoverPreviewProps.emptyHint}. Only the TEXT chip passes it;
   * image / video use the static (attr-backed) `src` / `emptyHint` instead.
   */
  resolveOnOpen?: () => { text?: string; emptyHint?: string };
  /**
   * Dim the preview (50% opacity) to signal the source is unavailable — a t2i
   * image reference — matching the greyed chip / rail row (user 2026-07-18).
   * EXPLICIT: both the rail and the chip pass this so the preview dim is one
   * mechanism, not the fragile "an ancestor's opacity happens to wrap the inline
   * (non-portaled) tooltip" inheritance the rail used to rely on. Text previews
   * are never dimmed (text feeds every mode). STATIC path (the reference rail,
   * which re-renders on every mode change so this prop is always live). For a
   * ProseMirror NodeView chip — which does NOT re-render on a mode toggle — pass
   * {@link ThumbnailHoverPreviewProps.resolveDimmed} instead so the dim reads
   * live at hover-open time.
   */
  dimmed?: boolean;
  /**
   * Resolves the dim state at HOVER-OPEN time from the LIVE mode (same reason as
   * {@link ThumbnailHoverPreviewProps.resolveOnOpen}, user 2026-07-19): a prompt
   * `@` image chip is a ProseMirror NodeView that does NOT re-render on a mode
   * toggle, so a `dimmed` captured at NodeView render freezes at insert-time —
   * switching t2i→i2i left the hover preview greyed even though i2i uses the
   * image. Read live on open (the chip body's grey-out already updates via a
   * mode-conditional class the editor puts on `.reference-mention[data-kind=image]`,
   * which re-renders; only this JS-prop path went stale). When present it
   * OVERRIDES {@link ThumbnailHoverPreviewProps.dimmed}.
   * Only the image chip passes it; the rail uses the static `dimmed`.
   */
  resolveDimmed?: () => boolean;
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
 * @param root0.dimmed - Dim the preview (unavailable t2i image reference; static rail path).
 * @param root0.resolveDimmed - Live dim resolver read at hover-open (chip path; overrides dimmed).
 * @param root0.children - The trigger element (the chip).
 * @returns The trigger with (when it has content) a hover preview.
 */
export function ThumbnailHoverPreview({
  src,
  text,
  alt,
  emptyHint,
  resolveOnOpen,
  dimmed = false,
  resolveDimmed,
  children,
}: ThumbnailHoverPreviewProps): React.JSX.Element {
  // Live-at-open (decision C), CACHED so it survives the close animation. The
  // body/hint is resolved from the live pool and kept in state: seeded at mount,
  // refreshed on every open, and NEVER cleared on close. Radix keeps the content
  // mounted ~150ms after open→false to play the fade-out (tooltip.tsx
  // data-[state=closed]:animate-out); an open-gated resolve would blank the box
  // mid-fade (batch-5 adversarial finding 1). Static props are the fallback for
  // the rail path (no resolver — the rail re-renders on pool change).
  const [resolved, setResolved] = React.useState<
    { text?: string; emptyHint?: string } | undefined
  >(() => resolveOnOpen?.());
  // Live-at-open dim for the chip path (#1798), CACHED in state exactly like
  // `resolved`: seeded at mount, refreshed on every open. The NodeView chip does
  // not re-render on a mode toggle, so a `resolveDimmed` read at component render
  // would be as stale as the old captured `dimmed` was — it must be read when the
  // tooltip opens. The rail path (static `dimmed`) leaves this undefined.
  const [resolvedDimmed, setResolvedDimmed] = React.useState<boolean | undefined>(
    () => resolveDimmed?.(),
  );
  const previewText = resolveOnOpen ? resolved?.text : text;
  const previewHint = resolveOnOpen ? resolved?.emptyHint : emptyHint;
  const previewDimmed = resolveDimmed ? resolvedDimmed === true : dimmed;
  // Follow the canvas while the preview is open (#1796): the shadcn Tooltip is a
  // Radix float whose Floating-UI auto-update reacts to scroll / resize but NOT
  // to the ReactFlow viewport's CSS-transform pan/zoom, so an open preview drifts
  // off its chip when the canvas moves. Track the open state and nudge it to
  // reposition each frame the viewport transforms — the same fix the ratio /
  // camera / model / mode pickers use. Inert while closed.
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  // No image, no text, no hint, no resolver → render the trigger unchanged (no
  // preview). A chip of an unhandled modality passes none of these, so it gets
  // NO tooltip rather than an empty box (batch-5 adversarial finding 2).
  if (!src && !text && !emptyHint && !resolveOnOpen) return <>{children}</>;
  return (
    <Tooltip
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          if (resolveOnOpen) setResolved(resolveOnOpen());
          if (resolveDimmed) setResolvedDimmed(resolveDimmed());
        }
      }}
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side='top'
        className='overflow-hidden border border-border bg-popover p-1'
      >
        {src ? (
          <img
            src={src}
            alt={alt}
            className={
              'max-h-[220px] max-w-[220px] rounded-sm object-contain' +
              (previewDimmed ? ' opacity-50' : '')
            }
            draggable={false}
          />
        ) : previewText ? (
          <div className='max-h-[220px] max-w-[220px] overflow-hidden whitespace-pre-wrap p-1 text-xs text-popover-foreground'>
            {previewText}
          </div>
        ) : previewHint ? (
          <div className='px-2 py-1 text-xs text-muted-foreground'>
            {previewHint}
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
