// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which address a page shows a stored image at (inner#1320, inner#832).
 *
 * Every stored image has a 576-wide preview beside it, and anywhere a picture
 * is only looked at shows that. Older images, animations and the odd failed
 * cut have none, so a preview that does not load is remembered for the rest of
 * the session and every place showing that image falls back to the original.
 */

import * as React from 'react';
import { previewUrlFor } from '@breatic/shared';

/** Preview addresses that did not load this session. */
const failed = new Set<string>();
/** Components to re-render when a preview is found missing. */
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
 * Follow the set of failed previews.
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
 * How many previews have failed, which is what changes when one does.
 * @returns The count.
 */
function failedCount(): number {
  return failed.size;
}

/**
 * Forget every failure. For tests, which share the module across cases.
 */
export function resetPreviewFailures(): void {
  failed.clear();
}

/** What to show for one image address. */
export interface PreviewSrc {
  /** The address to put on the element, or null when there is none. */
  src: string | null;
  /** Whether `src` is the original, so its natural size is the image's own. */
  isOriginal: boolean;
  /** Hand to the element's `onError`: a preview that fails falls back. */
  onError: () => void;
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
  React.useSyncExternalStore(subscribe, failedCount, failedCount);
  const preview = enabled && url ? previewUrlFor(url) : null;
  const showsPreview = preview !== null && !failed.has(preview);

  React.useEffect(() => {
    if (!probe || !showsPreview || preview === null) return undefined;
    const image = new Image();
    image.onerror = (): void => markFailed(preview);
    image.src = preview;
    return () => {
      image.onerror = null;
    };
  }, [probe, showsPreview, preview]);

  const onError = React.useCallback((): void => {
    if (preview !== null) markFailed(preview);
  }, [preview]);

  return React.useMemo(
    () => ({
      src: showsPreview ? preview : (url ?? null),
      isOriginal: !showsPreview,
      onError,
    }),
    [showsPreview, preview, url, onError],
  );
}
