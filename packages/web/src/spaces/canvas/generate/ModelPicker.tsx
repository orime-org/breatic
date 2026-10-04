// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { modelLabel, type ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { cn } from '@web/lib/utils';
import { ModelIcon } from '@web/spaces/canvas/generate/ModelIcon';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

interface ModelPickerProps {
  /** The catalog models this picker offers (image or video, per panel). */
  models: ModelEntry[];
  /** The currently selected model id. */
  value: string;
  /** Called with the picked model id. */
  onChange: (modelId: string) => void;
}

/**
 * The Generate panel's model picker: a pill showing the current model that
 * opens a list of catalog models, each row naming the model and, under it,
 * what that model is good at. Picking one fires `onChange` and closes the
 * list. Backed by the shared Radix Popover (portaled out of ReactFlow's
 * transform, so it closes on a canvas click and flips above/below to stay
 * on-screen). Falls back to the raw model id on the trigger when the current
 * value is not in the catalog.
 * @param root0 - Component props.
 * @param root0.models - The catalog models to offer.
 * @param root0.value - The current model id.
 * @param root0.onChange - Called with the picked model id.
 * @returns The model picker.
 */
export const ModelPicker = React.memo(function ModelPicker({
  models,
  value,
  onChange,
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  // Follow the ReactFlow viewport while open (#1796): Radix's Floating-UI
  // auto-update reacts to scroll / resize but not to the canvas's CSS-transform
  // pan/zoom, so the popover would drift off its trigger — the same fix the
  // ratio / camera pickers use. Inert while closed.
  useFollowCanvasViewport(open);
  const current = models.find((m) => m.name === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-model-trigger'
          className='flex h-8 min-w-0 max-w-[8rem] items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <ModelIcon name={current?.icon} className='h-4 w-4 shrink-0' />
          <span className='truncate'>{current ? modelLabel(current, models) : value}</span>
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        // Clip, don't flip/shift, at a screen edge (like the ratio / camera
        // pickers): a following popover (useFollowCanvasViewport) that flipped
        // would fight the follow and jump around as the canvas pans (user's
        // clip-not-jump decision, #1788).
        avoidCollisions={false}
        className='w-auto min-w-[13rem] max-w-[20rem] p-0 shadow-md'
      >
        {/* ScrollArea (#1773): overlay scrollbar (scroll-only, no layout
            space, hover = color change). The height cap and inner padding
            live on the viewport — the element that actually scrolls. */}
        <ScrollArea viewportClassName='max-h-52 p-1'>
          {/* Same option pattern as LangSwitcher / ThemeToggle: a gap-0.5
              column of ghost menu-item Buttons — the gap keeps the hover and
              chosen highlights visually separate. Single-choice, so the fill is
              the whole mark; a check mark reads as "more than one can be on at
              once" (DESIGN.md §5.3). The vendor icon below names the model, it
              reports no choice. */}
          <div className='flex flex-col gap-0.5'>
            {models.map((m) => (
              <Button
                key={m.name}
                variant='ghost'
                size='menu-item'
                aria-pressed={m.name === value}
                data-testid={`generate-model-option-${m.name}`}
                className={cn(
                  'justify-start',
                  m.name === value &&
                    'bg-accent-strong hover:bg-accent-strong',
                )}
                onClick={() => {
                  onChange(m.name);
                  setOpen(false);
                }}
              >
                <ModelIcon name={m.icon} className='h-4 w-4 shrink-0' />
                {/* Two lines, the same shape VoiceList gives its voices: the
                    name, and under it what this model is good at. The catalog's
                    `description` is written for this line — it says what sets a
                    model apart, which is the only thing that tells a reader
                    which of several models for one mode to pick. Empty when the
                    catalog leaves it blank, and then the row is one line again.
                    truncate on both: the catalog puts no length cap on either
                    and Button's base carries whitespace-nowrap, so unbounded,
                    one long string would stretch the popover past the viewport. */}
                <span className='flex min-w-0 flex-1 flex-col items-start'>
                  <span className='w-full truncate text-left'>
                    {modelLabel(m, models)}
                  </span>
                  {m.description !== '' && (
                    <span className='w-full truncate text-left text-xs text-muted-foreground'>
                      {m.description}
                    </span>
                  )}
                </span>
              </Button>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
});
