// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  ArrowUpRight,
  Circle,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import { ICON_BUTTON, SWATCH, SWATCH_DOT, Tip } from '@web/spaces/canvas/mini-tool/DrawingControls';
import { BRUSH_SIZE, INK } from '@web/stores/drawing-draft';
import { MARK_TOOLS, markCanClear, markCanRedo, markCanUndo, type MarkTool } from '@web/stores/mark-draft';

const TOOL_ICONS: Readonly<Record<MarkTool, LucideIcon>> = {
  select: MousePointer2,
  arrow: ArrowUpRight,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  pen: Pencil,
  text: Type,
};

/**
 * The tools, undo, redo, clear, size and colour of the markup tool
 * (inner#1303 §6.2), laid out as a drawing tool's are. A text being edited is
 * left before a tool, undo, redo or clear acts, so what was typed is written
 * back first.
 * @returns The controls, or null while the draft holds no markup.
 */
export function MarkControls(): React.JSX.Element | null {
  const t = useTranslation();
  const store = useCanvasSessionStore();
  const mark = useCanvasSession((s) => s.miniTool?.mark ?? null);
  const exporting = useCanvasSession((s) => s.miniTool?.exporting ?? false);
  const onSize = React.useCallback(
    (partial: Record<string, number>): void => {
      if (partial.size !== undefined) store.getState().setMarkSize(partial.size);
    },
    [store],
  );
  /**
   * Run an action once any text being edited has been left.
   * @param act - The action.
   * @returns The click handler.
   */
  const leavingEdit =
    (act: () => void) =>
      (): void => {
        const session = store.getState();
        if (session.miniTool?.mark?.editingText != null) session.markChannel?.exitEditing();
        act();
      };
  if (mark === null) return null;
  return (
    <div className='flex flex-col gap-2.5'>
      <div className='flex items-center gap-1'>
        {MARK_TOOLS.map((id) => {
          const Icon = TOOL_ICONS[id];
          return (
            <Tip key={id} tip={t(`canvas.miniTool.mark.${id}`)}>
              <Button
                type='button'
                variant='ghost'
                size={null}
                data-testid={`mini-tool-mark-${id}`}
                aria-label={t(`canvas.miniTool.mark.${id}`)}
                aria-pressed={mark.tool === id}
                disabled={exporting}
                onFocusCapture={suppressTooltipFocusOpen}
                onClick={leavingEdit(() => store.getState().setMarkTool(id))}
                className={ICON_BUTTON}
              >
                <Icon className='h-4 w-4' aria-hidden='true' />
              </Button>
            </Tip>
          );
        })}
        <span aria-hidden='true' className='mx-1 h-4 w-px bg-border' />
        {(
          [
            { id: 'undo', Icon: Undo2, can: markCanUndo(mark), act: () => store.getState().undoMark() },
            { id: 'redo', Icon: Redo2, can: markCanRedo(mark), act: () => store.getState().redoMark() },
            { id: 'clear', Icon: Trash2, can: markCanClear(mark), act: () => store.getState().clearMark() },
          ] as const
        ).map(({ id, Icon, can, act }) => (
          <Tip key={id} tip={t(`canvas.miniTool.draw.${id}`)}>
            <Button
              type='button'
              variant='ghost'
              size={null}
              data-testid={`mini-tool-mark-${id}`}
              aria-label={t(`canvas.miniTool.draw.${id}`)}
              disabled={!can || exporting}
              onFocusCapture={suppressTooltipFocusOpen}
              onClick={leavingEdit(act)}
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
        value={mark.size}
        format={String}
        onChange={onSize}
        testIdPrefix='mini-tool-mark'
        className={undefined}
        disabled={exporting}
      />
      <div className='flex items-center justify-between'>
        <span data-testid='mini-tool-mark-color-label' className='text-xs font-medium text-muted-foreground'>
          {t('canvas.miniTool.draw.color')}
        </span>
        <div className='flex items-center gap-1.5'>
          {INK.map((ink) => (
            <Button
              key={ink}
              type='button'
              variant={null}
              size={null}
              data-testid={`mini-tool-mark-ink-${ink}`}
              aria-label={ink}
              aria-pressed={mark.color === ink}
              disabled={exporting}
              onClick={() => store.getState().setMarkColor(ink)}
              className={SWATCH}
            >
              <span className={SWATCH_DOT} style={{ background: ink }} />
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
