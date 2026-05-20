import { Download, FileImage, FileJson, FileText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const EXPORT_FORMATS = [
  { id: 'png', label: 'PNG (current view)', icon: FileImage },
  { id: 'pdf', label: 'PDF (whole canvas)', icon: FileText },
  { id: 'json', label: 'JSON (raw data)', icon: FileJson },
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
        <Button variant='chrome-ghost' size='chrome' aria-label='Export'>
          <Download className='h-[18px] w-[18px]' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-56 p-1'
        data-testid='export-popover'
      >
        <div className='flex flex-col gap-0.5'>
          {EXPORT_FORMATS.map((f) => {
            const ItemIcon = f.icon;
            return (
              <Button
                key={f.id}
                variant='ghost'
                size='menu-item'
                className='justify-start'
                onClick={() => onExport?.(f.id)}
              >
                <ItemIcon className='h-4 w-4' />
                {f.label}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
