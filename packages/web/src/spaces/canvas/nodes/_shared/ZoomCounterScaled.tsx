// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';

interface ZoomCounterScaledProps {
  /** Stable test id for the scaled anchor div. */
  testId?: string;
  /** Positioning + transform-origin classes for the anchor. */
  className?: string;
  /** The overlay content to keep at constant screen size. */
  children: React.ReactNode;
}

/**
 * A canvas overlay anchor that counter-scales its children against the canvas
 * zoom so they keep a constant screen size — down to a floor zoom, below which
 * they shrink with the canvas. Used for the node name header, the resolution
 * badge, and the group name label.
 *
 * It is a LEAF consumer of {@link NodeScaleContext} (the counter-scale factor,
 * provided by the ReactFlow node wrapper). Isolating the zoom read to this small
 * leaf is the perf fix (#1647 R2): on zoom only these overlays re-render — the
 * node body + shell (which no longer read the scale) are left untouched. Outside
 * the canvas the context defaults to `1`, so a node frame still renders in
 * isolation (component tests with no provider). The `transform-origin` must be
 * set by the caller's `className` (e.g. `origin-bottom-left`) so the scale pins
 * to the right corner.
 * @param root0 - Zoom-counter-scale props.
 * @param root0.testId - Stable test id for the scaled anchor div.
 * @param root0.className - Positioning + transform-origin classes for the anchor.
 * @param root0.children - The overlay content to keep at constant screen size.
 * @returns The counter-scaled overlay anchor element.
 */
export function ZoomCounterScaled({
  testId,
  className,
  children,
}: ZoomCounterScaledProps): React.JSX.Element {
  const scale = React.useContext(NodeScaleContext);
  return (
    <div
      data-testid={testId}
      className={className}
      style={{ transform: `scale(${scale})` }}
    >
      {children}
    </div>
  );
}
