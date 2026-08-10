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
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** One selectable generation mode. */
export interface ModeOption {
  /** The mode id written to the node (`t2i` / `i2v` / …). */
  value: string;
  /**
   * Display label — English only, never localized (user 2026-07-10 item 15).
   * These are product mode names in the do-not-translate spirit of the DNT
   * glossary, so they read identically across all locales.
   */
  label: string;
  /** Stable test id for this option row. */
  testId: string;
}

interface ModeToggleProps {
  /** The active mode. */
  value: string;
  /** The modes this panel offers, in display order. */
  options: ReadonlyArray<ModeOption>;
  /** Called with the newly-picked mode (only when it differs from the active one). */
  onChange: (mode: string) => void;
  /** Test id for the trigger pill. */
  triggerTestId: string;
  /**
   * Disable the whole control — set while the model catalog is empty (still
   * loading or failed to load). A switch then could not resolve a model for the
   * target mode and would clobber the node's stored model / params in Yjs, so
   * switching is blocked until the catalog resolves.
   */
  disabled?: boolean;
}

/**
 * The generation-mode picker sitting to the LEFT of the model picker (mode
 * toggle 2026-07-09 §2.1; popover form per user 2026-07-10 item 1): a pill
 * showing the active mode that opens a popover to switch.
 *
 * One component for every panel: which modes exist is the caller's business,
 * but the pill, the popover, the canvas-follow and the no-op-on-reselect rule
 * are the same question each time — and the video panel would otherwise be a
 * second copy of sixty lines of popover wiring that could drift on any of them.
 * Presentational: the active mode + change handler are threaded in by the
 * container, which writes the switch to Yjs. Picking the already-active mode is
 * a no-op so a redundant write never resets the node's model / params.
 * @param root0 - Component props.
 * @param root0.value - The active generation mode.
 * @param root0.options - The modes this panel offers.
 * @param root0.onChange - Called with the newly-picked mode.
 * @param root0.triggerTestId - Test id for the trigger pill.
 * @param root0.disabled - Disable switching while the catalog is empty.
 * @returns The mode picker.
 */
export const ModeToggle = React.memo(function ModeToggle({
  value,
  options,
  onChange,
  triggerTestId,
  disabled = false,
}: ModeToggleProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  // Follow the ReactFlow viewport while open (#1796): Radix's Floating-UI
  // auto-update does not track the canvas's CSS-transform pan/zoom, so the
  // popover would drift off its trigger — same fix as the ratio / camera / model
  // pickers. Inert while closed.
  useFollowCanvasViewport(open);
  const active = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid={triggerTestId}
          disabled={disabled}
          className='flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
        >
          {/* Falls back to the raw id when the active mode is not offered here
              — the same degradation the model picker makes, so a node carrying
              a mode from another panel still reads as something. */}
          {active?.label ?? value}
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </Button>
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
          {options.map(({ value: mode, label, testId }) => (
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
              {label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
});
