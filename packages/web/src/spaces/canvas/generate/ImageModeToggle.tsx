// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Check, ChevronDown } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

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
 * Mode display labels — English only, never localized (user 2026-07-10 item 15).
 * These are product mode names in the do-not-translate spirit of the DNT
 * glossary, so they read identically across all locales.
 */
const MODE_LABELS: Record<ImageGenMode, string> = {
  t2i: 'Text to Image',
  i2i: 'Image to Image',
};

/** The two mode options, in display order (text-to-image first — the default). */
const OPTIONS: ReadonlyArray<{ mode: ImageGenMode; testId: string }> = [
  { mode: 't2i', testId: 'generate-mode-t2i' },
  { mode: 'i2i', testId: 'generate-mode-i2i' },
];

/**
 * The generation-mode picker sitting to the LEFT of the model picker (mode
 * toggle 2026-07-09 §2.1; popover form per user 2026-07-10 item 1): a pill
 * showing the active mode that opens a popover to switch between text-to-image
 * (`t2i`) and image-to-image (`i2i`). Backed by the shared Radix Popover (same
 * as the model / ratio pickers). Presentational — the active mode + change
 * handler are threaded in by the container, which writes the switch to Yjs via
 * `setNodeMode`. Picking the already-active mode is a no-op so a redundant write
 * never resets the node's model / params.
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
  const [open, setOpen] = React.useState(false);
  // Follow the ReactFlow viewport while open (#1796): Radix's Floating-UI
  // auto-update does not track the canvas's CSS-transform pan/zoom, so the
  // popover would drift off its trigger — same fix as the ratio / camera / model
  // pickers. Inert while closed.
  useFollowCanvasViewport(open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-testid='generate-mode-trigger'
          disabled={disabled}
          className='flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
        >
          {MODE_LABELS[value]}
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        // Clip, don't flip/shift, at a screen edge (like the ratio / camera / model
        // pickers): a following popover (useFollowCanvasViewport) that flipped would
        // fight the follow and jump as the canvas pans (user's clip-not-jump, #1788).
        avoidCollisions={false}
        className='w-auto min-w-[10rem] p-1'
      >
        {/* Same option pattern as LangSwitcher / ThemeToggle (spec §9.4): a
            gap-0.5 column of ghost menu-item Buttons — the gap keeps the hover
            and selected highlights visually separate. */}
        <div className='flex flex-col gap-0.5'>
          {OPTIONS.map(({ mode, testId }) => (
            <Button
              key={mode}
              variant='ghost'
              size='menu-item'
              aria-pressed={mode === value}
              data-testid={testId}
              className={cn('justify-start', mode === value && 'bg-accent')}
              onClick={() => {
                if (mode !== value) onChange(mode);
                setOpen(false);
              }}
            >
              <Check
                className={`h-3.5 w-3.5 shrink-0 ${mode === value ? 'opacity-100' : 'opacity-0'}`}
                aria-hidden='true'
              />
              {MODE_LABELS[mode]}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
});
