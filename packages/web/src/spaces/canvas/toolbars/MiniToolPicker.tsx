import { Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Modality } from '@/spaces/canvas/types/node';

interface MiniToolPickerProps {
  modality: Modality;
  onPick?: (toolId: string) => void;
}

/**
 * Right-zone "Mini-tool" entry on the node toolbar. Opens a popover with
 * tools filtered by the modality. Selecting a tool creates a NEW sibling
 * node + primary edge (ADR mini-tool-unified-output) — the current node
 * is never mutated.
 *
 * PR 7 renders a short demo list per modality. The full 47-tool catalog
 * + per-tool inputs lands in PR 10 (mini-tool 47-tool batch).
 */
const DEMO_TOOLS: Record<Modality, ReadonlyArray<{ id: string; label: string }>> = {
  text: [
    { id: 'polish', label: 'Polish' },
    { id: 'summarize', label: 'Summarize' },
    { id: 'translate', label: 'Translate' },
  ],
  image: [
    { id: 'inpaint', label: 'Inpaint' },
    { id: 'remove-bg', label: 'Remove background' },
    { id: 'upscale', label: 'Upscale' },
  ],
  audio: [
    { id: 'transcribe', label: 'Transcribe' },
    { id: 'denoise', label: 'Denoise' },
  ],
  video: [
    { id: 'extract-audio', label: 'Extract audio' },
    { id: 'extract-cover', label: 'Extract cover' },
  ],
};

export function MiniToolPicker({ modality, onPick }: MiniToolPickerProps) {
  const tools = DEMO_TOOLS[modality];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size='sm'
          className='h-7 gap-1 px-2'
          data-testid='mini-tool-trigger'
        >
          <Wand2 className='h-3.5 w-3.5' />
          <span className='text-xs'>Mini-tool</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-48 p-1'
        data-testid='mini-tool-popover'
      >
        <div className='flex flex-col gap-0.5'>
          {tools.map((t) => (
            <Button
              key={t.id}
              variant='ghost'
              size='sm'
              className='justify-start'
              onClick={() => onPick?.(t.id)}
              data-testid={`mini-tool-${t.id}`}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
