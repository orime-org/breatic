import * as React from 'react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Modality } from '@/spaces/canvas/types/node';

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
 */
export function ReferencePicker({
  children,
  candidates,
  onPick,
}: ReferencePickerProps) {
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
                  <span className='mr-2 text-[10px] uppercase opacity-60'>
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
