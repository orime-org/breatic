// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which address a page shows a stored image at (inner#1320, inner#832).
 *
 * Every stored image has a preview at most 576 wide beside it, and anywhere a picture
 * is only looked at shows that. Older images, animations and the odd failed
 * cut have none, so a preview that does not load is remembered for the rest of
 * the session and every place showing that image falls back to the original.
 * A preview that does load has its width remembered the same way: the canvas
 * compares a node against the preview's real width, read off the loaded image.
 */

import * as React from 'react';
import { previewUrlFor } from '@breatic/shared';

/** Preview addresses that did not load this session. */
const failed = new Set<string>();
/** The natural width of each preview that loaded this session. */
const widths = new Map<string, number>();
/** Components to re-render when a preview fails or loads. */
const listeners = new Set<() => void>();

/**
 * Remember a preview that did not load and tell every subscriber.
 * @param preview - The preview's address.
 */
function markFailed(preview: string): void {
  if (failed.has(preview)) return;
  failed.add(preview);
  for (const listener of listeners) listener();
}

/**
 * Remember how wide a loaded preview is and tell every subscriber.
 * @param preview - The preview's address.
 * @param width - Its natural width.
 */
function markLoaded(preview: string, width: number): void {
  if (width <= 0 || widths.get(preview) === width) return;
  widths.set(preview, width);
  for (const listener of listeners) listener();
}

/**
 * Follow the failed and loaded previews.
 * @param listener - Called when one is added.
 * @returns The unsubscribe call.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget every failure and every width. For tests, which share the module
 * across cases.
 */
export function resetPreviewRecords(): void {
  failed.clear();
  widths.clear();
}

/** What to show for one image address. */
export interface PreviewSrc {
  /** The address to put on the element, or null when there is none. */
  src: string | null;
  /** Whether `src` is the original, so its natural size is the image's own. */
  isOriginal: boolean;
  /** Hand to the element's `onError`: a preview that fails falls back. */
  onError: () => void;
  /** Hand to the element's `onLoad`: a preview that loads has its width kept. */
  onLoad: (event: { currentTarget: { naturalWidth: number } }) => void;
}

/**
 * The address to show an image at.
 * @param url - The image's own address, as a node or a list holds it.
 * @param options - How to show it.
 * @param options.enabled - False to show the original. A node with no known
 *   size uses this, so the size it reads off the loaded image is the image's.
 * @param options.probe - Load the preview off-screen as well, for an element
 *   with no `onError` of its own (a video's `poster`).
 * @returns The address and the error handler.
 */
export function usePreviewSrc(
  url: string | null | undefined,
  options: { enabled?: boolean; probe?: boolean } = {},
): PreviewSrc {
  const { enabled = true, probe = false } = options;
  const preview = enabled && url ? previewUrlFor(url) : null;
  // Only this image's own failure re-renders the caller.
  const isMissing = React.useCallback((): boolean => preview !== null && failed.has(preview), [preview]);
  const missing = React.useSyncExternalStore(subscribe, isMissing, isMissing);
  const showsPreview = preview !== null && !missing;

  React.useEffect(() => {
    if (!probe || !showsPreview || preview === null) return undefined;
    const image = new Image();
    image.onerror = (): void => markFailed(preview);
    image.onload = (): void => markLoaded(preview, image.naturalWidth);
    image.src = preview;
    return () => {
      image.onerror = null;
      image.onload = null;
    };
  }, [probe, showsPreview, preview]);

  const onError = React.useCallback((): void => {
    if (preview !== null) markFailed(preview);
  }, [preview]);

  const onLoad = React.useCallback(
    (event: { currentTarget: { naturalWidth: number } }): void => {
      if (showsPreview && preview !== null) markLoaded(preview, event.currentTarget.naturalWidth);
    },
    [showsPreview, preview],
  );

  return React.useMemo(
    () => ({
      src: showsPreview ? preview : (url ?? null),
      isOriginal: !showsPreview,
      onError,
      onLoad,
    }),
    [showsPreview, preview, url, onError, onLoad],
  );
}

/**
 * How wide an image's preview is, once some element on the page has loaded it.
 * @param url - The image's own address.
 * @returns The preview's natural width, or null until it has loaded.
 */
export function usePreviewWidth(url: string | null | undefined): number | null {
  const preview = url ? previewUrlFor(url) : null;
  const read = React.useCallback(
    (): number | null => (preview === null ? null : (widths.get(preview) ?? null)),
    [preview],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}
