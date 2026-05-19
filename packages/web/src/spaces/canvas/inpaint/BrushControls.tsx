import { Eraser, Paintbrush, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

export type InpaintTool = 'brush' | 'erase';

interface BrushControlsProps {
  tool: InpaintTool;
  brushSize: number;
  opacity: number;
  canUndo: boolean;
  onToolChange: (tool: InpaintTool) => void;
  onBrushSizeChange: (size: number) => void;
  onOpacityChange: (opacity: number) => void;
  onUndo: () => void;
}

/**
 * Inpaint mask controls — brush vs erase mode, size slider, opacity
 * slider, and undo. Lives as a floating bar above the inpaint canvas.
 *
 * Native range inputs are used instead of shadcn Slider to keep the test
 * surface trivial and let users drag without pointer-events polyfills.
 */
export function BrushControls({
  tool,
  brushSize,
  opacity,
  canUndo,
  onToolChange,
  onBrushSizeChange,
  onOpacityChange,
  onUndo,
}: BrushControlsProps) {
  return (
    <div
      data-testid='brush-controls'
      className='flex items-center gap-3 rounded-md border border-border bg-background px-2 py-1 shadow-sm'
    >
      <div className='flex items-center gap-1'>
        <Button
          variant={tool === 'brush' ? 'secondary' : 'ghost'}
          size='icon'
          aria-label='Brush'
          aria-pressed={tool === 'brush'}
          onClick={() => onToolChange('brush')}
          data-testid='brush-tool-brush'
        >
          <Paintbrush className='h-4 w-4' />
        </Button>
        <Button
          variant={tool === 'erase' ? 'secondary' : 'ghost'}
          size='icon'
          aria-label='Erase'
          aria-pressed={tool === 'erase'}
          onClick={() => onToolChange('erase')}
          data-testid='brush-tool-erase'
        >
          <Eraser className='h-4 w-4' />
        </Button>
      </div>
      <div className='flex items-center gap-1'>
        <Label htmlFor='brush-size' className='text-xs'>
          Size
        </Label>
        <input
          id='brush-size'
          type='range'
          min={1}
          max={120}
          value={brushSize}
          onChange={(e) => onBrushSizeChange(Number(e.target.value))}
          data-testid='brush-size'
        />
      </div>
      <div className='flex items-center gap-1'>
        <Label htmlFor='brush-opacity' className='text-xs'>
          Opacity
        </Label>
        <input
          id='brush-opacity'
          type='range'
          min={0}
          max={100}
          value={Math.round(opacity * 100)}
          onChange={(e) =>
            onOpacityChange(Number(e.target.value) / 100)
          }
          data-testid='brush-opacity'
        />
      </div>
      <Button
        variant='ghost'
        size='icon'
        aria-label='Undo last stroke'
        disabled={!canUndo}
        onClick={onUndo}
        data-testid='brush-undo'
      >
        <Undo2 className='h-4 w-4' />
      </Button>
    </div>
  );
}
