// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A picture in the body (inner#1127 A23): its final size held from the first
 * frame, a skeleton over it until it loads, and the stored preview shown
 * while that preview is sharp enough at the width the picture is shown.
 */

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import { useDevicePixelRatio } from '@web/lib/device-pixel-ratio';
import { usePreviewSrc, usePreviewWidth } from '@web/lib/preview-src';
import { useLatchedFor, zoomedPastPreview } from '@web/spaces/canvas/nodes/_shared/preview-zoom';

/** The box a picture of unknown size is drawn in while it loads. */
const UNKNOWN_SIZE: React.CSSProperties = { aspectRatio: '3 / 2' };

/** What the picture is drawn from. */
export interface DocumentMediaImageProps {
  /** The original's address. */
  readonly url: string;
  /** The width it is laid out at, in CSS pixels, once measured. */
  readonly shownWidth: number | null;
  /** The original's pixel size, read off the file as it was added. */
  readonly mediaWidth?: number;
  readonly mediaHeight?: number;
  /** True until the picture has loaded or failed for good. */
  readonly waiting: boolean;
  /** Called with the address once its picture has loaded or failed for good. */
  readonly onSettle: (url: string) => void;
  /** Opens the picture full screen. */
  readonly onDoubleClick: () => void;
}

/**
 * The picture.
 *
 * The canvas's rule. A stored picture with a stored size starts on its
 * preview; one without shows its original, which lays it out at its own size.
 * Once the preview has loaded its width is known, and when it is narrower than
 * the width shown times the screen's pixel ratio the original takes its place
 * and stays. The ratio is followed, so moving the window to another screen
 * judges again.
 * @param props - The picture.
 * @returns The picture and, until it loads, its skeleton.
 */
export const DocumentMediaImage = React.memo(function DocumentMediaImage({
  url,
  shownWidth,
  mediaWidth,
  mediaHeight,
  waiting,
  onSettle,
  onDoubleClick,
}: DocumentMediaImageProps): React.JSX.Element {
  const ratio = useDevicePixelRatio();
  const previewPixels = usePreviewWidth(url);
  const sizeKnown = mediaWidth !== undefined && mediaHeight !== undefined;
  // The stored ratio, stated outright: a loaded image otherwise lays out at its
  // own, and a preview's height is rounded to a whole pixel, so the box would
  // change height when the preview arrives.
  const shape = React.useMemo<React.CSSProperties>(
    () => (sizeKnown ? { aspectRatio: `${mediaWidth} / ${mediaHeight}` } : UNKNOWN_SIZE),
    [sizeKnown, mediaWidth, mediaHeight],
  );
  const showsOriginal = useLatchedFor(
    url,
    shownWidth !== null && zoomedPastPreview(shownWidth, 1, ratio, previewPixels),
  );
  const shown = usePreviewSrc(url, { enabled: sizeKnown && !showsOriginal });
  const src = shown.src ?? url;
  const { onLoad: recordPreview, onError: dropPreview, isOriginal } = shown;

  const onLoad = React.useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>): void => {
      recordPreview(event);
      onSettle(url);
    },
    [recordPreview, onSettle, url],
  );
  const onError = React.useCallback((): void => {
    if (isOriginal) onSettle(url);
    else dropPreview();
  }, [isOriginal, dropPreview, onSettle, url]);

  return (
    <>
      <img
        src={src}
        alt=''
        loading='lazy'
        decoding='async'
        draggable={false}
        width={mediaWidth}
        height={mediaHeight}
        className='block h-auto w-full'
        style={sizeKnown || waiting ? shape : undefined}
        onDoubleClick={onDoubleClick}
        onLoad={onLoad}
        onError={onError}
      />
      {waiting ? (
        <Skeleton data-testid='doc-media-skeleton' className='pointer-events-none absolute inset-0 rounded-none' />
      ) : null}
    </>
  );
});
