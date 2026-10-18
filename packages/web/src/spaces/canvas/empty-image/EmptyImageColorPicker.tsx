// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { HexColorInput, HexColorPicker } from 'react-colorful';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

interface EmptyImageColorPickerProps {
  /** The current hex colour, shown on the trigger swatch. */
  value: string;
  /** Called with the new hex as the user picks / types. */
  onChange: (hex: string) => void;
  /** What opens the picker, in place of the round swatch (the relight colour row's last cell). */
  trigger?: React.ReactElement;
  /** The hex field's test id. */
  inputTestId?: string;
  /** The trigger's name, shown on hover. */
  tip?: string;
  /** Where the picker opens from the trigger; above it, at its start, when absent. */
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
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
 * @param root0.trigger - What opens the picker, when not the round swatch.
 * @param root0.inputTestId - The hex field's test id.
 * @param root0.tip - The trigger's name, shown on hover.
 * @param root0.side - Which side of the trigger the picker opens on.
 * @param root0.align - Which edge of the trigger it lines up with.
 * @returns The swatch trigger + colour-picker popover.
 */
export const EmptyImageColorPicker = React.memo(function EmptyImageColorPicker({
  value,
  onChange,
  trigger,
  inputTestId,
  tip,
  side = 'top',
  align = 'start',
}: EmptyImageColorPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Track the node with the canvas while the popover is open (mandatory
  // in-canvas overlay pattern; see
  // packages/web/AGENTS.md#canvas-overlays-follow-the-viewport).
  useFollowCanvasViewport(open);
  const opener = (
    <PopoverTrigger asChild>
      {trigger ?? (
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='empty-image-color-custom'
          aria-label={t('canvas.emptyImage.color.custom')}
          style={{ backgroundColor: value }}
          // Hover = active-border colour + semi-transparent (opacity), stacked
          // for a clear affordance. Both are paint-only and never change the
          // layout rect, so the popover the trigger is anchored to can't jump
          // (a hover SCALE did change the rect — the earlier user-reported bug).
          className='h-8 w-8 rounded-full border border-border transition hover:border-active-border hover:opacity-70 focus-visible:border-active-border focus-visible:outline-none'
        />
      )}
    </PopoverTrigger>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {tip === undefined ? (
        opener
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{opener}</TooltipTrigger>
          <TooltipContent side='top'>{tip}</TooltipContent>
        </Tooltip>
      )}
      <PopoverContent
        side={side}
        align={align}
        avoidCollisions={false}
        className='w-auto rounded-overlay border border-border bg-popover p-3 shadow-md'
      >
        {/* react-colorful injects its own unlayered corners (8px); an important
            utility outranks them, so the field shares the 6px overlay corner. */}
        <div className='empty-image-color-picker flex flex-col gap-2 [&_.react-colorful__last-control]:!rounded-b-overlay [&_.react-colorful__saturation]:!rounded-t-overlay'>
          <HexColorPicker color={value} onChange={onChange} />
          <HexColorInput
            color={value}
            onChange={onChange}
            prefixed
            {...(inputTestId !== undefined && { 'data-testid': inputTestId })}
            aria-label={t('canvas.emptyImage.color.custom')}
            className='w-full rounded-content-sm border border-border bg-transparent px-2 py-1 text-sm uppercase tabular-nums text-popover-foreground focus-visible:border-active-border focus-visible:outline-none'
          />
        </div>
      </PopoverContent>
    </Popover>
  );
});
