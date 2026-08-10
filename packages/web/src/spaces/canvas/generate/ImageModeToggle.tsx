// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import { ModeToggle } from '@web/spaces/canvas/generate/ModeToggle';

interface ImageModeToggleProps {
  /** The active generation sub-mode. */
  value: ImageGenMode;
  /** Called with the newly-picked mode (only when it differs from the active one). */
  onChange: (mode: ImageGenMode) => void;
  /**
   * Disable the whole control — set while the model catalog is empty (still
   * loading or failed to load). A switch then could not resolve a model for the
   * target mode and would clobber the node's stored model / params in Yjs, so
   * switching is blocked until the catalog resolves.
   */
  disabled?: boolean;
}

/**
 * The two image modes, in display order (text-to-image first — the default).
 * Labels are English only, never localized (user 2026-07-10 item 15): they are
 * product mode names in the do-not-translate spirit of the DNT glossary, so
 * they read identically across all locales.
 */
const OPTIONS = [
  { value: 't2i', label: 'Text to Image', testId: 'generate-mode-t2i' },
  { value: 'i2i', label: 'Image to Image', testId: 'generate-mode-i2i' },
] as const;

/**
 * The image panel's generation-mode picker: text-to-image or image-to-image.
 *
 * A thin wrapper over the shared {@link ModeToggle} — which modes exist is this
 * panel's decision, while the pill, the popover and the canvas-follow behaviour
 * are the same in every panel. The narrow `ImageGenMode` callback is what the
 * wrapper buys: the shared control speaks plain strings so it can serve mode
 * sets it knows nothing about, and this restores the type at the boundary.
 * @param root0 - Component props.
 * @param root0.value - The active generation sub-mode.
 * @param root0.onChange - Called with the newly-picked mode.
 * @param root0.disabled - Disable switching while the catalog is empty.
 * @returns The mode picker.
 */
export const ImageModeToggle = React.memo(function ImageModeToggle({
  value,
  onChange,
  disabled = false,
}: ImageModeToggleProps): React.JSX.Element {
  const handleChange = React.useCallback(
    (mode: string) => onChange(mode as ImageGenMode),
    [onChange],
  );
  return (
    <ModeToggle
      value={value}
      options={OPTIONS}
      onChange={handleChange}
      triggerTestId='generate-mode-trigger'
      disabled={disabled}
    />
  );
});
