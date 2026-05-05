import React, { memo, useCallback } from 'react';
import { useViewport, useReactFlow, useStore } from '@xyflow/react';
import Slider from '@/components/base/slider';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';

interface UndoRedoToolbarProps {
  /**
   * Yjs collaborative undo/redo methods (optional).
   * When `localUndo` / `localRedo` are not set, Yjs is used when these callbacks exist.
   */
  yjsUndo?: () => void;
  yjsRedo?: () => void;
  yjsCanUndo?: boolean;
  yjsCanRedo?: boolean;
  /**
   * Plain snapshot undo/redo (e.g. `new/project` canvas). When both handlers are provided,
   * they take priority over Yjs.
   */
  localUndo?: () => void;
  localRedo?: () => void;
  localCanUndo?: boolean;
  localCanRedo?: boolean;
  /** Whether the minimap is expanded */
  minimapOpen?: boolean;
  /** Toggle minimap visibility */
  onToggleMinimap?: () => void;
  /** Extra positioning class for different canvas contexts */
  className?: string;
}

/**
 * Undo/redo toolbar component.
 * Contains minimap toggle, undo, redo, zoom slider, 100% zoom, and fit-to-view.
 * Uses {@link UndoRedoToolbarProps.localUndo} when provided; otherwise Yjs when available.
 */
const UndoRedoToolbar: React.FC<UndoRedoToolbarProps> = ({
  yjsUndo,
  yjsRedo,
  yjsCanUndo = false,
  yjsCanRedo = false,
  localUndo,
  localRedo,
  localCanUndo = false,
  localCanRedo = false,
  minimapOpen = true,
  onToggleMinimap,
  className,
}) => {
  const { zoom } = useViewport();
  const { zoomTo, fitView } = useReactFlow();
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);

  const useLocalHistory = typeof localUndo === 'function' && typeof localRedo === 'function';
  const canUndo = useLocalHistory ? Boolean(localCanUndo) : Boolean(yjsCanUndo && yjsUndo);
  const canRedo = useLocalHistory ? Boolean(localCanRedo) : Boolean(yjsCanRedo && yjsRedo);

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    if (useLocalHistory) localUndo?.();
    else yjsUndo?.();
  }, [canUndo, useLocalHistory, localUndo, yjsUndo]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    if (useLocalHistory) localRedo?.();
    else yjsRedo?.();
  }, [canRedo, useLocalHistory, localRedo, yjsRedo]);

  const handleFitView = useCallback(() => {
    zoomTo(1);
  }, [zoomTo]);

  const handleFitToView = useCallback(() => {
    fitView({ padding: 0.1, duration: 300 });
  }, [fitView]);

  return (
    <div
      className={`pointer-events-auto cursor-default absolute bottom-3 left-[15px] z-20 ${className ?? ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Left button group */}
      <div className='flex items-center gap-2 flex items-center justify-between'>
        {/* Minimap toggle */}
        <Tooltip title={minimapOpen ? 'Close minimap' : 'Open minimap'} placement='top'>
          <div
            className={`flex items-center justify-center w-6 h-6 rounded cursor-pointer relative ${minimapOpen ? 'bg-white' : 'bg-transparent'}`}
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
        {minimapOpen && (
          <>
            {/* Undo button */}
            <Tooltip title='Undo (Ctrl+Z)' placement='top'>
              <div
                className={`flex items-center justify-center w-6 h-6 p-0 border-0 bg-transparent cursor-pointer relative ${canUndo ? 'text-icon-secondary' : 'text-icon-tertiary cursor-not-allowed'}`}
                onClick={handleUndo}
              >
                <Icon name='project-redo-icon' width={24} height={24} />
              </div>
            </Tooltip>

            {/* Redo button */}
            <Tooltip title='Redo (Shift+Ctrl+Z)' placement='top'>
              <div
                className={`flex items-center justify-center w-6 h-6 p-0 border-0 bg-transparent cursor-pointer relative ${canRedo ? 'text-icon-secondary' : 'text-icon-tertiary cursor-not-allowed'}`}
                onClick={handleRedo}
              >
                <Icon name='project-undo-icon' width={24} height={24} />
              </div>
            </Tooltip>

            {/* Zoom slider */}
            <Slider
              className='mx-1 !w-[100px] m-0 flex-shrink-0'
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
                className='flex items-center justify-center w-6 h-6 p-0 border-0 bg-transparent cursor-pointer relative'
                onClick={handleFitView}
              >
                <Icon name='project-expand-icon' width={18} height={18} color='var(--color-icon-secondary)' />
              </div>
            </Tooltip>

            <Tooltip title='Fit to view' placement='top'>
              <div
                className='flex items-center justify-center w-6 h-6 p-0 border-0 bg-transparent cursor-pointer relative'
                onClick={handleFitToView}
              >
                <Icon name='project-layout-icon' width={18} height={18} color='var(--color-icon-secondary)' />
              </div>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
};

export default memo(UndoRedoToolbar);
