// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Circle, Eraser, Paintbrush, Redo2, Square, Trash2, Undo2, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import type { DrawingKind } from '@web/spaces/canvas/mini-tool/paint-drawing';
import { BRUSH_SIZE, INK, MASK_DISPLAY_COLORS, visibleOps, type DrawTool } from '@web/stores/drawing-draft';

const TOOLS: ReadonlyArray<{ id: DrawTool; Icon: LucideIcon }> = [
  { id: 'brush', Icon: Paintbrush },
  { id: 'rect', Icon: Square },
  { id: 'ellipse', Icon: Circle },
  { id: 'eraser', Icon: Eraser },
];

const ICON_BUTTON =
  'h-[var(--btn-inline)] w-[var(--btn-inline)] border border-transparent p-0 ' +
  'aria-pressed:border-active-border aria-pressed:bg-accent-strong aria-pressed:hover:bg-accent-strong';

const SWATCH =
  'h-5 w-5 rounded-full border border-border p-0 ' +
  'aria-pressed:outline aria-pressed:outline-offset-2 aria-pressed:outline-active-border';

/**
 * An icon button with its name in a hover tip.
 * @param root0 - Component props.
 * @param root0.tip - The name.
 * @param root0.children - The button.
 * @returns The wrapped button.
 */
function Tip({ tip, children }: { tip: string; children: React.ReactElement }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side='top'>{tip}</TooltipContent>
    </Tooltip>
  );
}

interface DrawingControlsProps {
  kind: DrawingKind;
}

/**
 * The tools, size, colour, undo, redo and clear of a mask or sketch tool's
 * drawing (inner#1302 §6.3), read from and written to the panel's draft.
 * @param root0 - Component props.
 * @param root0.kind - Mask or sketch.
 * @returns The controls, or null while the draft holds no drawing.
 */
export function DrawingControls({ kind }: DrawingControlsProps): React.JSX.Element | null {
  const t = useTranslation();
  const drawing = useCanvasSession((s) => s.miniTool?.drawing ?? null);
  const exporting = useCanvasSession((s) => s.miniTool?.exporting ?? false);
  const setDrawingTool = useCanvasSession((s) => s.setDrawingTool);
  const setDrawingSize = useCanvasSession((s) => s.setDrawingSize);
  const setDrawingColor = useCanvasSession((s) => s.setDrawingColor);
  const setMaskColor = useCanvasSession((s) => s.setMaskColor);
  const addDrawingStep = useCanvasSession((s) => s.addDrawingStep);
  const undoDrawing = useCanvasSession((s) => s.undoDrawing);
  const redoDrawing = useCanvasSession((s) => s.redoDrawing);
  const onSize = React.useCallback(
    (partial: Record<string, number>): void => {
      if (partial.size !== undefined) setDrawingSize(partial.size);
    },
    [setDrawingSize],
  );
  if (drawing === null) return null;
  const shown = visibleOps(drawing.steps).length > 0;
  return (
    <div className='flex flex-col gap-2.5'>
      <div className='flex items-center gap-1'>
        {TOOLS.map(({ id, Icon }) => (
          <Tip key={id} tip={t(`canvas.miniTool.draw.${id}`)}>
            <Button
              type='button'
              variant='ghost'
              size={null}
              data-testid={`mini-tool-draw-${id}`}
              aria-label={t(`canvas.miniTool.draw.${id}`)}
              aria-pressed={drawing.tool === id}
              disabled={exporting}
              onFocusCapture={suppressTooltipFocusOpen}
              onClick={() => setDrawingTool(id)}
              className={ICON_BUTTON}
            >
              <Icon className='h-4 w-4' aria-hidden='true' />
            </Button>
          </Tip>
        ))}
        <span aria-hidden='true' className='mx-1 h-4 w-px bg-border' />
        {(
          [
            { id: 'undo', Icon: Undo2, can: drawing.steps.length > 0, act: undoDrawing },
            { id: 'redo', Icon: Redo2, can: drawing.undone.length > 0, act: redoDrawing },
            { id: 'clear', Icon: Trash2, can: shown, act: () => addDrawingStep({ kind: 'clear' }) },
          ] as const
        ).map(({ id, Icon, can, act }) => (
          <Tip key={id} tip={t(`canvas.miniTool.draw.${id}`)}>
            <Button
              type='button'
              variant='ghost'
              size={null}
              data-testid={`mini-tool-draw-${id}`}
              aria-label={t(`canvas.miniTool.draw.${id}`)}
              disabled={!can || exporting}
              onFocusCapture={suppressTooltipFocusOpen}
              onClick={act}
              className={ICON_BUTTON}
            >
              <Icon className='h-4 w-4' aria-hidden='true' />
            </Button>
          </Tip>
        ))}
      </div>
      <ParamSliderRow
        name='size'
        label={t('canvas.miniTool.draw.size')}
        min={BRUSH_SIZE.min}
        max={BRUSH_SIZE.max}
        step={BRUSH_SIZE.step}
        value={drawing.size}
        format={String}
        onChange={onSize}
        testIdPrefix='mini-tool-draw'
        className={undefined}
        disabled={exporting}
      />
      <div className='flex items-center justify-between'>
        <span className='text-xs font-medium text-muted-foreground'>
          {t(kind === 'mask' ? 'canvas.miniTool.draw.maskColor' : 'canvas.miniTool.draw.color')}
        </span>
        <div className='flex items-center gap-1.5'>
          {kind === 'mask'
            ? MASK_DISPLAY_COLORS.map((name) => (
              <Button
                key={name}
                type='button'
                variant={null}
                size={null}
                data-testid={`mini-tool-draw-mask-${name}`}
                aria-label={name}
                aria-pressed={drawing.maskColor === name}
                disabled={exporting}
                onClick={() => setMaskColor(name)}
                className={SWATCH}
                style={{ background: `var(--color-palette-${name})` }}
              />
            ))
            : INK.map((ink) => (
              <Button
                key={ink}
                type='button'
                variant={null}
                size={null}
                data-testid={`mini-tool-draw-ink-${ink}`}
                aria-label={ink}
                aria-pressed={drawing.color === ink}
                disabled={exporting}
                onClick={() => setDrawingColor(ink)}
                className={SWATCH}
                style={{ background: ink }}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
