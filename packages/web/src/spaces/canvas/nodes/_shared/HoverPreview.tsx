// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@web/components/ui/hover-card';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import {
  HOVER_OPEN_DELAY_MS,
  HOVER_CLOSE_DELAY_MS,
} from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** Which content form the large preview renders. */
export type HoverPreviewKind = 'image' | 'text' | 'audio' | 'video';

/** Props for {@link HoverPreview}. */
export interface HoverPreviewProps {
  /** Content form — decides how the large preview renders. */
  kind: HoverPreviewKind;
  /** Media / image URL (image / audio / video). `text` form uses `text`. */
  src?: string;
  /** Video poster (video only); ignored for audio / image. */
  poster?: string;
  /** Static text body (`text` form; #1815 chip). */
  text?: string;
  /** Image alt text. */
  alt?: string;
  /** Hint shown when the source is empty (no src / text; #1815 chip not-yet-generated). */
  emptyHint?: string;
  /**
   * Resolves the text body + hint at HOVER-OPEN time from the live source
   * (#1815 prompt `@` chip live projection). A ProseMirror NodeView chip does
   * not re-render when its source text changes, so its body must be read when
   * the card opens rather than captured at render. When present it OVERRIDES
   * `text` / `emptyHint`. The resolved value is cached (seeded at mount,
   * refreshed on open, kept on close) so the preview stays live yet does not
   * blank during the close animation.
   */
  resolveOnOpen?: () => { text?: string; emptyHint?: string };
  /** Dim the image preview (#1815 unavailable t2i reference). */
  dimmed?: boolean;
  /**
   * Resolves the dim state at HOVER-OPEN time (#1815 `@` image chip on a mode
   * toggle; same live-at-open reason as {@link HoverPreviewProps.resolveOnOpen}).
   * When present it OVERRIDES `dimmed`.
   */
  resolveDimmed?: () => boolean;
  /**
   * Keep the open card glued to its trigger while the ReactFlow canvas pans /
   * zooms (#1814 node history, which lives inside the canvas). Activity-feed
   * usage omits it — its Sheet is screen-space and never transforms. When set,
   * the card opens to the `top` and does not flip on collision (clip-not-jump,
   * matching the canvas pickers); otherwise it opens to the `left` (toward
   * screen centre, since the activity Sheet hugs the right edge) and may flip.
   */
  followCanvas?: boolean;
  /** The trigger element (the small thumbnail / chip). */
  children: React.ReactNode;
}

/**
 * Unified hover preview (#1622): hovering a small thumbnail / chip pops a large
 * preview whose form depends on `kind` — a static `<img>` for image, the static
 * text body for text, and a PLAYABLE {@link MediaPlayer} (`variant='preview'`)
 * for audio / video so the user can sense the content, not just see a frame.
 * Backed by a Radix HoverCard (auto-closes on leave, hosts interactive content),
 * it is the single mechanism for every hover surface — activity feed here, node
 * history (#1814) and generate chips (#1815) migrate onto it next.
 *
 * The content is portaled (escapes container `overflow` / ReactFlow transform
 * clipping) and carries `pointer-events: auto` so its play / seek stay clickable
 * even inside a modal Sheet (whose body is `pointer-events: none`). Media never
 * autoplays — click-to-play. With no source at all it renders the trigger
 * unchanged (no card).
 * @param root0 - Component props.
 * @param root0.kind - Content form (image / text / audio / video).
 * @param root0.src - Media / image URL.
 * @param root0.poster - Video poster (video only).
 * @param root0.text - Static text body (text form).
 * @param root0.alt - Image alt text.
 * @param root0.emptyHint - Hint shown when the source is empty.
 * @param root0.resolveOnOpen - Live text/hint resolver read at hover-open (overrides text/emptyHint).
 * @param root0.dimmed - Dim the image preview (unavailable reference).
 * @param root0.resolveDimmed - Live dim resolver read at hover-open (overrides dimmed).
 * @param root0.followCanvas - Follow the ReactFlow viewport while open (canvas surfaces).
 * @param root0.children - The trigger element (thumbnail / chip).
 * @returns The trigger with (when it has content) a hover preview.
 */
export function HoverPreview({
  kind,
  src,
  poster,
  text,
  alt = '',
  emptyHint,
  resolveOnOpen,
  dimmed = false,
  resolveDimmed,
  followCanvas = false,
  children,
}: HoverPreviewProps): React.JSX.Element {
  // Live-at-open cache (decision C from ThumbnailHoverPreview): seed at mount,
  // refresh on every open, NEVER clear on close — Radix keeps the content
  // mounted through the close animation, so an open-gated resolve would blank
  // the box mid-fade. Static props are the fallback (no resolver).
  const [resolved, setResolved] = React.useState<
    { text?: string; emptyHint?: string } | undefined
  >(() => resolveOnOpen?.());
  const [resolvedDimmed, setResolvedDimmed] = React.useState<boolean | undefined>(
    () => resolveDimmed?.(),
  );
  // Track open so the canvas-follow nudge is inert while closed and the
  // live-at-open resolvers fire at the right moment.
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(followCanvas ? open : false);

  const previewText = resolveOnOpen ? resolved?.text : text;
  const previewHint = resolveOnOpen ? resolved?.emptyHint : emptyHint;
  const previewDimmed = resolveDimmed ? resolvedDimmed === true : dimmed;

  // No image, no text, no hint, no resolver → render the trigger unchanged (no
  // card), so an unhandled / empty source gets nothing rather than an empty box.
  if (!src && !text && !emptyHint && !resolveOnOpen) return <>{children}</>;

  const isMedia = kind === 'audio' || kind === 'video';
  let content: React.ReactNode = null;
  if (isMedia && src) {
    content = (
      <div className='w-[220px] max-w-[220px]'>
        <MediaPlayer
          modality={kind}
          src={src}
          poster={poster}
          variant='preview'
        />
      </div>
    );
  } else if (kind === 'image' && src) {
    content = (
      <img
        src={src}
        alt={alt}
        draggable={false}
        className={
          'max-h-[220px] max-w-[220px] rounded-content-sm object-contain' +
          (previewDimmed ? ' opacity-50' : '')
        }
      />
    );
  } else if (previewText) {
    content = (
      <div className='max-h-[220px] max-w-[220px] overflow-hidden whitespace-pre-wrap p-1 text-xs text-popover-foreground'>
        {previewText}
      </div>
    );
  } else if (previewHint) {
    content = (
      <div className='px-2 py-1 text-xs text-muted-foreground'>{previewHint}</div>
    );
  }

  return (
    <HoverCard
      openDelay={HOVER_OPEN_DELAY_MS}
      closeDelay={HOVER_CLOSE_DELAY_MS}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          if (resolveOnOpen) setResolved(resolveOnOpen());
          if (resolveDimmed) setResolvedDimmed(resolveDimmed());
        }
      }}
    >
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        data-testid='hover-preview-content'
        side={followCanvas ? 'top' : 'left'}
        avoidCollisions={followCanvas ? false : undefined}
        // Re-enable clicks inside a modal Sheet: the modal sets the body to
        // `pointer-events: none`, which the portaled content inherits; an
        // explicit `auto` on the content lets its play / seek subtree be
        // clicked (verified with elementFromPoint). Harmless outside a modal
        // (already auto there). See the hover-preview spec §3.10 / INV-11.
        style={{ pointerEvents: 'auto' }}
      >
        {content}
      </HoverCardContent>
    </HoverCard>
  );
}
