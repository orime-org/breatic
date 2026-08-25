// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import { ModeToggle, type ModeOption } from '@web/spaces/canvas/generate/ModeToggle';

interface ImageModeToggleProps {
  /** The active generation sub-mode. */
  value: ImageGenMode;
  /** Called with the newly-picked mode (only when it differs from the active one). */
  onChange: (mode: ImageGenMode) => void;
  /** The modes to offer — already narrowed to what this deployment serves. */
  options: ReadonlyArray<ModeOption>;
}

/**
 * The image panel's generation-mode picker: text-to-image or image-to-image.
 *
 * A thin wrapper over the shared {@link ModeToggle} — the pill, the popover
 * and the canvas-follow behaviour are the same in every panel, and the narrow
 * `ImageGenMode` callback is what the wrapper buys: the shared control speaks
 * plain strings so it can serve mode sets it knows nothing about, and this
 * restores the type at the boundary.
 *
 * Which modes exist is no longer this component's to say (#1951). The list
 * moved to `image-mode-selection` and arrives already narrowed to the modes
 * this deployment can serve, because only the container can ask the catalog
 * that question — a module-private const here was out of its reach.
 * @param root0 - Component props.
 * @param root0.value - The active generation sub-mode.
 * @param root0.onChange - Called with the newly-picked mode.
 * @param root0.options - The modes to offer.
 * @returns The mode picker.
 */
export const ImageModeToggle = React.memo(function ImageModeToggle({
  value,
  onChange,
  options,
}: ImageModeToggleProps): React.JSX.Element {
  const handleChange = React.useCallback(
    (mode: string) => onChange(mode as ImageGenMode),
    [onChange],
  );
  return (
    <ModeToggle
      value={value}
      options={options}
      onChange={handleChange}
      triggerTestId='generate-mode-trigger'
    />
  );
});
