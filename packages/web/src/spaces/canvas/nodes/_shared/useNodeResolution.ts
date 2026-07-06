// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import type { NodeResolution } from '@web/spaces/canvas/nodes/_shared/NodeResolutionBadge';

/**
 * Holds the intrinsic pixel resolution read from a media element's DOM
 * (`<img>` naturalWidth/Height, `<video>` videoWidth/Height), resetting to
 * `undefined` whenever the content URL changes so a swapped image/video never
 * shows the previous media's dimensions until the new one loads.
 * @param content - The current media content URL (undefined when the node is empty).
 * @returns The current resolution (undefined until loaded) and its setter.
 */
export function useNodeResolution(content: string | undefined): {
  resolution: NodeResolution | undefined;
  setResolution: (resolution: NodeResolution) => void;
} {
  const [resolution, setResolution] = React.useState<
    NodeResolution | undefined
  >(undefined);
  React.useEffect(() => {
    setResolution(undefined);
  }, [content]);
  return { resolution, setResolution };
}
