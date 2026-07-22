// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { HexColorInput, HexColorPicker } from 'react-colorful';
import * as React from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

interface EmptyImageColorPickerProps {
  /** The current hex colour, shown on the trigger swatch. */
  value: string;
  /** Called with the new hex as the user picks / types. */
  onChange: (hex: string) => void;
}

/**
 * Custom fill-colour picker for the reset-empty panel (#1623, user-ratified A):
 * a swatch showing the CURRENT colour that opens a `react-colorful` picker in a
 * Radix Popover. Replaces the native `<input type="color">` whose swatch AND OS
 * dialog render differently per browser — this looks identical on every engine.
 * The popover tracks the node WITH the canvas (`useFollowCanvasViewport` +
 * `avoidCollisions={false}`, the mandatory canvas-overlay pattern), same as the
 * Generate panel's pickers.
 * @param root0 - Component props.
 * @param root0.value - The current hex colour.
 * @param root0.onChange - Called with the new hex on pick / type.
 * @returns The swatch trigger + colour-picker popover.
 */
export const EmptyImageColorPicker = React.memo(function EmptyImageColorPicker({
  value,
  onChange,
}: EmptyImageColorPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Track the node with the canvas while the popover is open (mandatory
  // in-canvas overlay pattern; see web/CLAUDE.md).
  useFollowCanvasViewport(open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-testid='empty-image-color-custom'
          aria-label={t('canvas.emptyImage.color.custom')}
          style={{ backgroundColor: value }}
          // Hover = active-border colour + semi-transparent (opacity), stacked
          // for a clear affordance. Both are paint-only and never change the
          // layout rect, so the popover the trigger is anchored to can't jump
          // (a hover SCALE did change the rect — the earlier user-reported bug).
          className='h-8 w-8 rounded-full border border-border transition hover:border-active-border hover:opacity-70 focus-visible:border-active-border focus-visible:outline-none'
        />
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        avoidCollisions={false}
        className='w-auto rounded-overlay border border-border bg-popover p-3'
      >
        <div className='empty-image-color-picker flex flex-col gap-2'>
          <HexColorPicker color={value} onChange={onChange} />
          <HexColorInput
            color={value}
            onChange={onChange}
            prefixed
            aria-label={t('canvas.emptyImage.color.custom')}
            className='w-full rounded-content-sm border border-border bg-transparent px-2 py-1 text-sm uppercase tabular-nums text-popover-foreground focus-visible:border-active-border focus-visible:outline-none'
          />
        </div>
      </PopoverContent>
    </Popover>
  );
});
