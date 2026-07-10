// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Check, ChevronDown } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { ModelIcon } from '@web/spaces/canvas/generate/ModelIcon';

interface ModelPickerProps {
  /** The available image models from the catalog. */
  models: ModelEntry[];
  /** The currently selected model id. */
  value: string;
  /** Called with the picked model id. */
  onChange: (modelId: string) => void;
}

/**
 * The Generate panel's model picker: a pill showing the current model that
 * opens a list of catalog models. Picking one fires `onChange` and closes the
 * list. Backed by the shared Radix Popover (portaled out of ReactFlow's
 * transform, so it closes on a canvas click and flips above/below to stay
 * on-screen). Falls back to the raw model id on the trigger when the current
 * value is not in the catalog.
 * @param root0 - Component props.
 * @param root0.models - The catalog image models.
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
  const current = models.find((m) => m.name === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-testid='generate-model-trigger'
          className='flex h-8 min-w-0 max-w-[8rem] items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <ModelIcon name={current?.icon} className='h-4 w-4 shrink-0' />
          <span className='truncate'>{current?.display_name ?? value}</span>
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        className='max-h-52 w-auto min-w-[13rem] overflow-auto p-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40 [&::-webkit-scrollbar-track]:bg-transparent'
      >
        <ul role='listbox'>
          {models.map((m) => (
            <li key={m.name}>
              <button
                type='button'
                role='option'
                aria-selected={m.name === value}
                data-testid={`generate-model-option-${m.name}`}
                onClick={() => {
                  onChange(m.name);
                  setOpen(false);
                }}
                className={
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:bg-accent ' +
                  (m.name === value
                    ? 'bg-accent text-accent-foreground'
                    : 'text-popover-foreground')
                }
              >
                <Check
                  className={`h-3.5 w-3.5 shrink-0 ${m.name === value ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden='true'
                />
                <ModelIcon name={m.icon} className='h-4 w-4 shrink-0' />
                {m.display_name}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
});
