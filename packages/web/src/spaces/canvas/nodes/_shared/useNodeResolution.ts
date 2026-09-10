// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { NodeResolution } from '@web/spaces/canvas/nodes/_shared/NodeResolutionBadge';

/**
 * The resolution a media node shows, preferring what the ledger measured.
 *
 * The asset row carries the dimensions ffprobe read at ingest (#209), so a
 * node that has them shows a badge before the browser has decoded anything —
 * and two nodes on the same asset show the same number, whatever each one's
 * `<img>` happens to report. The DOM read stays as the fallback: a row stored
 * before the container ran carries none, and a container that could not answer
 * leaves none behind.
 *
 * The DOM value resets whenever the content URL changes, so a swapped image or
 * video never shows the previous media's dimensions until the new one loads.
 * @param content - The current media content URL (undefined when the node is empty).
 * @param width - The width on the node's data, when the ledger measured one.
 * @param height - The height on the node's data.
 * @returns The resolution to show (undefined until one is known) and the
 *   setter the media element's load handler reports into.
 */
export function useNodeResolution(
  content: string | undefined,
  width?: number,
  height?: number,
): {
  resolution: NodeResolution | undefined;
  setResolution: (resolution: NodeResolution) => void;
} {
  const [measured, setMeasured] = React.useState<NodeResolution | undefined>(
    undefined,
  );
  React.useEffect(() => {
    setMeasured(undefined);
  }, [content]);
  // Both or neither: half a pair describes no frame, and the badge takes two.
  const known =
    width !== undefined && height !== undefined ? { width, height } : undefined;
  return { resolution: known ?? measured, setResolution: setMeasured };
}
