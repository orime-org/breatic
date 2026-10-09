// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A picture in the body (inner#1127 A23): its final size held from the first
 * frame, a skeleton over it until it loads, and the stored preview shown
 * while that preview is sharp enough at the width the picture is shown.
 */

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import { usePreviewSrc, usePreviewWidth } from '@web/lib/preview-src';

/** The box a picture of unknown size is drawn in while it loads. */
const UNKNOWN_SIZE: React.CSSProperties = { aspectRatio: '3 / 2' };

/** What the picture is drawn from. */
export interface DocumentMediaImageProps {
  /** The original's address. */
  readonly url: string;
  /** The width it is shown at, in CSS pixels, when the block sets one. */
  readonly shownWidth?: number;
  /** The original's pixel size, read off the file as it was added. */
  readonly mediaWidth?: number;
  readonly mediaHeight?: number;
  /** Opens the picture full screen. */
  readonly onDoubleClick: () => void;
}

/**
 * The picture.
 *
 * A stored picture starts on its preview. Once the preview has loaded its
 * width is known, and when it is narrower than the width shown times the
 * screen's pixel ratio the original takes its place: the rule the canvas
 * follows, which reads the preview's width off the loaded image.
 * @param props - The picture.
 * @returns The picture and, until it loads, its skeleton.
 */
export const DocumentMediaImage = React.memo(function DocumentMediaImage({
  url,
  shownWidth,
  mediaWidth,
  mediaHeight,
  onDoubleClick,
}: DocumentMediaImageProps): React.JSX.Element {
  const previewWidth = usePreviewWidth(url);
  const across = shownWidth ?? mediaWidth;
  const needed = across === undefined ? undefined : across * window.devicePixelRatio;
  const tooNarrow = previewWidth !== null && needed !== undefined && previewWidth < needed;
  const shown = usePreviewSrc(url, { enabled: !tooNarrow });
  const src = shown.src ?? url;
  const [loadedFor, setLoadedFor] = React.useState<string | null>(null);
  const [failedFor, setFailedFor] = React.useState<string | null>(null);
  const { onLoad: recordPreview, onError: dropPreview, isOriginal } = shown;

  const onLoad = React.useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>): void => {
      recordPreview(event);
      setLoadedFor(url);
    },
    [recordPreview, url],
  );
  const onError = React.useCallback((): void => {
    if (isOriginal) setFailedFor(url);
    else dropPreview();
  }, [isOriginal, dropPreview, url]);

  const waiting = loadedFor !== url && failedFor !== url;
  const sizeKnown = mediaWidth !== undefined && mediaHeight !== undefined;
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
        style={waiting && !sizeKnown ? UNKNOWN_SIZE : undefined}
        onDoubleClick={onDoubleClick}
        onLoad={onLoad}
        onError={onError}
      />
      {waiting ? (
        <Skeleton
          data-testid='doc-media-skeleton'
          className='pointer-events-none absolute inset-0 rounded-none'
        />
      ) : null}
    </>
  );
});
