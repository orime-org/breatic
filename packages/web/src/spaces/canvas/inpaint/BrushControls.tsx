// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Eraser, Paintbrush, Undo2 } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';

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
 * @param root0 - Brush control props.
 * @param root0.tool - Currently active paint mode (brush adds mask, erase removes it).
 * @param root0.brushSize - Brush diameter in image pixels, bound to the size slider.
 * @param root0.opacity - Stroke alpha in [0, 1], bound to the opacity slider.
 * @param root0.canUndo - Whether at least one stroke exists, enabling the undo button.
 * @param root0.onToolChange - Called when the user switches between brush and erase.
 * @param root0.onBrushSizeChange - Called with the new brush diameter when the size slider moves.
 * @param root0.onOpacityChange - Called with the new alpha in [0, 1] when the opacity slider moves.
 * @param root0.onUndo - Called to remove the most recent stroke.
 * @returns The floating brush-controls bar.
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
}: BrushControlsProps): React.JSX.Element {
  return (
    <div
      data-testid='brush-controls'
      className='flex items-center gap-3 rounded-chrome border border-border bg-popover px-2 py-1 shadow'
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
