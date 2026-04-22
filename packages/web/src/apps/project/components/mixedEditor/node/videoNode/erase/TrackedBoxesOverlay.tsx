import React, { memo } from 'react';
import type { ImageEditorPickResultBox } from '../../../types';
import type { EraseBoxResizeDirection } from './useVideoEraseInteractions';

type DraftBox = {
  cxPct: number;
  cyPct: number;
  wPct: number;
  hPct: number;
  tool: 'rectangle' | 'circle';
};

type TrackedBoxesOverlayProps = {
  boxes: ImageEditorPickResultBox[];
  draftBox: DraftBox | null;
  onBoxMouseDown: (box: ImageEditorPickResultBox, e: React.MouseEvent<HTMLDivElement>) => void;
  onResizeHandleMouseDown: (
    box: ImageEditorPickResultBox,
    direction: EraseBoxResizeDirection,
    e: React.MouseEvent<HTMLDivElement>,
  ) => void;
};

const stopClickPropagation = (e: React.MouseEvent<HTMLDivElement>) => {
  e.preventDefault();
  e.stopPropagation();
};

const handleDotClass = 'h-3 w-3 rounded-full border border-[rgb(99,102,241)] bg-white';

const TrackedBoxesOverlay: React.FC<TrackedBoxesOverlayProps> = ({ boxes, draftBox, onBoxMouseDown, onResizeHandleMouseDown }) => {
  return (
    <>
      {boxes.map((box, boxIdx) => (
        <div
          key={box.placeholderId ?? `${box.cxPct}-${box.cyPct}-${boxIdx}`}
          className={`pointer-events-auto absolute z-[5] box-border border-2 border-dashed border-[rgb(99,102,241)] bg-[rgba(99,102,241,0.22)] shadow-[0_0_0_1px_rgba(255,255,255,0.25)_inset] cursor-move ${
            box.maskShape === 'circle' ? 'rounded-full' : ''
          }`}
          style={{
            left: `${box.cxPct}%`,
            top: `${box.cyPct}%`,
            width: `${box.wPct}%`,
            height: `${box.hPct}%`,
            transform: 'translate(-50%, -50%)',
          }}
          onMouseDown={(e) => onBoxMouseDown(box, e)}
          onClick={stopClickPropagation}
        >
          {box.maskShape === 'circle' ? (
            <>
              <div
                className={`absolute -top-1.5 left-1/2 -translate-x-1/2 cursor-n-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'top', e)}
                onClick={stopClickPropagation}
              />
              <div
                className={`absolute -bottom-1.5 left-1/2 -translate-x-1/2 cursor-s-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'bottom', e)}
                onClick={stopClickPropagation}
              />
              <div
                className={`absolute -left-1.5 top-1/2 -translate-y-1/2 cursor-w-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'left', e)}
                onClick={stopClickPropagation}
              />
              <div
                className={`absolute -right-1.5 top-1/2 -translate-y-1/2 cursor-e-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'right', e)}
                onClick={stopClickPropagation}
              />
            </>
          ) : (
            <>
              <div
                className={`absolute -left-1.5 -top-1.5 cursor-nw-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'top-left', e)}
                onClick={stopClickPropagation}
              />
              <div
                className={`absolute -right-1.5 -top-1.5 cursor-ne-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'top-right', e)}
                onClick={stopClickPropagation}
              />
              <div
                className={`absolute -left-1.5 -bottom-1.5 cursor-sw-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'bottom-left', e)}
                onClick={stopClickPropagation}
              />
              <div
                className={`absolute -right-1.5 -bottom-1.5 cursor-se-resize ${handleDotClass}`}
                onMouseDown={(e) => onResizeHandleMouseDown(box, 'bottom-right', e)}
                onClick={stopClickPropagation}
              />
            </>
          )}
        </div>
      ))}
      {draftBox && (
        <div
          className={`pointer-events-none absolute z-[6] border-2 border-dashed border-[rgb(99,102,241)] bg-[rgb(99,102,241)]/10 box-border ${
            draftBox.tool === 'circle' ? 'rounded-full' : ''
          }`}
          style={{
            left: `${draftBox.cxPct}%`,
            top: `${draftBox.cyPct}%`,
            width: `${draftBox.wPct}%`,
            height: `${draftBox.hPct}%`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}
    </>
  );
};

export default memo(TrackedBoxesOverlay);
