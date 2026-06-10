// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@web/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import type { Modality } from '@web/spaces/canvas/types/node';

export interface ReferenceCandidate {
  id: string;
  modality: Modality;
  label: string;
}

interface ReferencePickerProps {
  /** The trigger element (typically `<button>@</button>` rendered by ChatComposer). */
  children: React.ReactNode;
  candidates: ReadonlyArray<ReferenceCandidate>;
  onPick: (candidate: ReferenceCandidate) => void;
}

/**
 * `@`-reference picker. Renders a popover with a command palette of
 * candidate nodes; selection delegates to the caller, which:
 *   1. Snapshots the referenced node's payload into the prompt context
 *   2. Draws a reference edge in the canvas
 *   3. Appends a `ReferenceChip` to the composer
 * @param root0 - Reference picker props.
 * @param root0.children - The trigger element that opens the popover (typically the composer's `@` button).
 * @param root0.candidates - Selectable nodes shown in the command palette.
 * @param root0.onPick - Called with the chosen candidate to snapshot it and draw the reference edge.
 * @returns The popover-wrapped reference picker element.
 */
export function ReferencePicker({
  children,
  candidates,
  onPick,
}: ReferencePickerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-72 p-0'
        data-testid='reference-picker'
      >
        <Command>
          <CommandInput placeholder='Search nodes…' />
          <CommandList>
            <CommandEmpty>No matching nodes</CommandEmpty>
            <CommandGroup>
              {candidates.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.label}
                  onSelect={() => {
                    onPick(c);
                    setOpen(false);
                  }}
                  data-testid={`reference-candidate-${c.id}`}
                >
                  <span className='mr-2 text-2xs uppercase opacity-60'>
                    {c.modality}
                  </span>
                  <span className='truncate'>{c.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
