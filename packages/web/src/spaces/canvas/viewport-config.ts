// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { FitViewOptions } from '@xyflow/react';

/**
 * Zoom clamp applied to every fitView — both the auto-fit on space open
 * (`<ReactFlow fitViewOptions>`) and the toolbar "fit to window" command
 * (imperative `fitView()`). ReactFlow's fitView otherwise frames all content
 * bounded only by the canvas global `minZoom` / `maxZoom` (10%–800%, sized for
 * the manual zoom presets), so a sparse space would zoom in to 800%. Capping
 * the fit calculation at 100% (and flooring at 10%, matching the global
 * `minZoom`) keeps the open / fit framing sane without touching the global
 * bounds that the manual 400% / 800% presets rely on (#1547).
 */
export const FIT_VIEW_OPTIONS = {
  minZoom: 0.1,
  maxZoom: 1,
} satisfies FitViewOptions;
