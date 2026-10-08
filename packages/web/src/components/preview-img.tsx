// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { usePreviewSrc } from '@web/lib/preview-src';

/** An `<img>`'s own props, with the address it would show the original at. */
export interface PreviewImgProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** The image's own address, as a node or a list holds it. */
  src: string;
}

/**
 * An image that is only looked at: it loads the 576-wide preview stored beside
 * the image and falls back to the original when there is none (inner#1320).
 * Anything that needs the original's pixels — a crop, a download, a model's
 * input — reads the original address, never this element.
 * @param props - The image's props.
 * @param props.src - The original's address.
 * @param props.onError - Called after the fallback has been taken.
 * @returns The image.
 */
export const PreviewImg = React.memo(function PreviewImg({
  src,
  onError,
  ...rest
}: PreviewImgProps): React.JSX.Element {
  const shown = usePreviewSrc(src);
  const { onError: fallBack } = shown;
  const handleError = React.useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>): void => {
      fallBack();
      onError?.(event);
    },
    [fallBack, onError],
  );
  // eslint-disable-next-line jsx-a11y/alt-text -- alt arrives in `rest` from the caller.
  return <img {...rest} src={shown.src ?? src} onError={handleError} />;
});
