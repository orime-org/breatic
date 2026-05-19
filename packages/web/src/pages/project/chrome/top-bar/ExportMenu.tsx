import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const EXPORT_FORMATS = [
  { id: 'png', label: 'PNG (current view)' },
  { id: 'pdf', label: 'PDF (whole canvas)' },
  { id: 'json', label: 'JSON (raw data)' },
] as const;

/**
 * Export menu — popover with the supported export formats. Actually
 * triggering the export goes through `data/api/canvas.ts` in a later PR;
 * here we just register click handlers so the chrome wires up.
 */
export function ExportMenu({
  onExport,
}: {
  onExport?: (format: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant='ghost' size='icon' aria-label='Export'>
          <Download className='h-4 w-4' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-56 p-1'
        data-testid='export-popover'
      >
        <div className='flex flex-col gap-0.5'>
          {EXPORT_FORMATS.map((f) => (
            <Button
              key={f.id}
              variant='ghost'
              size='sm'
              className='justify-start'
              onClick={() => onExport?.(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
