import React, { memo, useCallback } from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';

type ImageEditorUndoBarProps = {
  yjsUndo: () => void;
  yjsRedo: () => void;
  yjsCanUndo: boolean;
  yjsCanRedo: boolean;
};

/**
 * Image editor canvas undo/redo (Yjs UndoManager; same idea as main canvas).
 */
const ImageEditorUndoBar: React.FC<ImageEditorUndoBarProps> = ({ yjsUndo, yjsRedo, yjsCanUndo, yjsCanRedo }) => {
  const canUndo = yjsCanUndo;
  const canRedo = yjsCanRedo;

  const handleUndo = useCallback(() => {
    if (canUndo) yjsUndo();
  }, [canUndo, yjsUndo]);

  const handleRedo = useCallback(() => {
    if (canRedo) yjsRedo();
  }, [canRedo, yjsRedo]);

  return (
    <div
      className='pointer-events-auto absolute right-3 top-[108px] z-20 flex items-center gap-1 rounded-lg bg-background-default-base px-1 py-0.5 shadow-[0px_4px_16px_-1px_rgba(12,12,13,0.05)]'
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip title='Undo' placement='top'>
        <button
          type='button'
          className={`flex h-8 w-8 items-center justify-center rounded border-0 bg-transparent p-0 ${
            canUndo ? 'cursor-pointer text-icon-secondary' : 'cursor-not-allowed text-icon-tertiary'
          }`}
          onClick={handleUndo}
          disabled={!canUndo}
          aria-label='Undo'
        >
          <Icon name='project-redo-icon' width={22} height={22} />
        </button>
      </Tooltip>
      <Tooltip title='Redo' placement='top'>
        <button
          type='button'
          className={`flex h-8 w-8 items-center justify-center rounded border-0 bg-transparent p-0 ${
            canRedo ? 'cursor-pointer text-icon-secondary' : 'cursor-not-allowed text-icon-tertiary'
          }`}
          onClick={handleRedo}
          disabled={!canRedo}
          aria-label='Redo'
        >
          <Icon name='project-undo-icon' width={22} height={22} />
        </button>
      </Tooltip>
    </div>
  );
};

export default memo(ImageEditorUndoBar);
