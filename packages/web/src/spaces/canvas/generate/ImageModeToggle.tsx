// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';

interface ImageModeToggleProps {
  /** The active generation sub-mode. */
  value: ImageGenMode;
  /** Called with the newly-picked mode (only when it differs from the active one). */
  onChange: (mode: ImageGenMode) => void;
  /**
   * Disable the whole toggle — set while the model catalog is empty (still
   * loading or failed to load). A toggle then could not resolve a model for the
   * target mode and would clobber the node's stored model / params in Yjs, so
   * switching is blocked until the catalog resolves.
   */
  disabled?: boolean;
}

/** The two toggle options, in display order (text-to-image first — the default). */
const OPTIONS: ReadonlyArray<{
  mode: ImageGenMode;
  labelKey: string;
  testId: string;
}> = [
  { mode: 't2i', labelKey: 'canvas.generatePanel.modeT2i', testId: 'generate-mode-t2i' },
  { mode: 'i2i', labelKey: 'canvas.generatePanel.modeI2i', testId: 'generate-mode-i2i' },
];

/**
 * The generation-mode segmented control sitting to the LEFT of the model picker
 * (mode toggle 2026-07-09 §2.1): a two-state switch between text-to-image
 * (`t2i`) and image-to-image (`i2i`). Presentational — the active mode + the
 * change handler are threaded in by the container, which writes the switch to
 * Yjs via `setNodeMode`. Clicking the already-active mode is a no-op so a
 * redundant write never resets the node's model / params.
 * @param root0 - Component props.
 * @param root0.value - The active generation sub-mode.
 * @param root0.onChange - Called with the newly-picked mode.
 * @returns The mode segmented control.
 */
export const ImageModeToggle = React.memo(function ImageModeToggle({
  value,
  onChange,
  disabled = false,
}: ImageModeToggleProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      role='group'
      className={`flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-border bg-muted p-0.5 ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      {OPTIONS.map(({ mode, labelKey, testId }) => {
        const active = mode === value;
        return (
          <button
            key={mode}
            type='button'
            data-testid={testId}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange(mode);
            }}
            className={`flex h-full items-center rounded-full px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed ${
              active
                ? 'bg-background font-medium text-foreground'
                : 'text-muted-foreground enabled:hover:text-foreground'
            }`}
          >
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
});
