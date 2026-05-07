/**
 * Undo/redo + zoom chrome for the local-only canvas (React Flow history), independent of `apps/project`.
 */
import React, { memo, useCallback } from 'react';
import { useViewport, useReactFlow, useStore } from '@xyflow/react';
import Slider from '@/components/base/slider';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';

export interface LocalUndoRedoToolbarProps {
  undo?: () => void;
  redo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  minimapOpen?: boolean;
  onToggleMinimap?: () => void;
  className?: string;
}

const LocalUndoRedoToolbar: React.FC<LocalUndoRedoToolbarProps> = ({
  undo,
  redo,
  canUndo = false,
  canRedo = false,
  minimapOpen = true,
  onToggleMinimap,
  className,
}) => {
  const { zoom } = useViewport();
  const { zoomTo, fitView } = useReactFlow();
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);

  const effectiveCanUndo = Boolean(undo && canUndo);
  const effectiveCanRedo = Boolean(redo && canRedo);

  const handleUndo = useCallback(() => {
    if (effectiveCanUndo && undo) undo();
  }, [effectiveCanUndo, undo]);

  const handleRedo = useCallback(() => {
    if (effectiveCanRedo && redo) redo();
  }, [effectiveCanRedo, redo]);

  const handleFitView = useCallback(() => {
    zoomTo(1);
  }, [zoomTo]);

  const handleFitToView = useCallback(() => {
    fitView({ padding: 0.1, duration: 300 });
  }, [fitView]);

  return (
    <div
      className={`pointer-events-auto absolute bottom-3 left-[15px] z-20 cursor-default ${className ?? ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className='flex items-center justify-between gap-2'>
        <Tooltip title={minimapOpen ? 'Close minimap' : 'Open minimap'} placement='top'>
          <div
            className={`relative flex h-6 w-6 cursor-pointer items-center justify-center rounded ${minimapOpen ? 'bg-white' : 'bg-transparent'}`}
            style={{ width: 24, height: 24 }}
            onClick={onToggleMinimap}
            role='button'
            aria-pressed={minimapOpen}
          >
            <Icon
              name='project-minimap-icon'
              width={17}
              height={17}
              color={minimapOpen ? '#444444' : 'var(--color-icon-secondary)'}
            />
          </div>
        </Tooltip>
        {minimapOpen ? (
          <>
            <Tooltip title='Undo (Ctrl+Z)' placement='top'>
              <div
                className={`relative flex h-6 w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 ${effectiveCanUndo ? 'text-icon-secondary' : 'cursor-not-allowed text-icon-tertiary'}`}
                onClick={handleUndo}
              >
                <Icon name='project-redo-icon' width={24} height={24} />
              </div>
            </Tooltip>

            <Tooltip title='Redo (Shift+Ctrl+Z)' placement='top'>
              <div
                className={`relative flex h-6 w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 ${effectiveCanRedo ? 'text-icon-secondary' : 'cursor-not-allowed text-icon-tertiary'}`}
                onClick={handleRedo}
              >
                <Icon name='project-undo-icon' width={24} height={24} />
              </div>
            </Tooltip>

            <Slider
              className='m-0 mx-1 !w-[100px] flex-shrink-0'
              value={zoom}
              min={minZoom}
              max={maxZoom}
              step={0.01}
              activeColor='#5A5A5A'
              inactiveColor='#E3E3E3'
              trackHeight={6}
              thumbWidth={20}
              thumbHeight={16}
              thumbColor='#B3B3B3'
              showValueTooltipOnDrag
              formatTooltip={(value) => `${Math.round(value * 100)}%`}
              onChange={(value) => zoomTo(value)}
            />

            <Tooltip title='100%' placement='top'>
              <div
                className='relative flex h-6 w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0'
                onClick={handleFitView}
              >
                <Icon name='project-expand-icon' width={18} height={18} color='var(--color-icon-secondary)' />
              </div>
            </Tooltip>

            <Tooltip title='Fit to view' placement='top'>
              <div
                className='relative flex h-6 w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0'
                onClick={handleFitToView}
              >
                <Icon name='project-layout-icon' width={18} height={18} color='var(--color-icon-secondary)' />
              </div>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default memo(LocalUndoRedoToolbar);
