import React, { useCallback, useRef, useState } from 'react';
import { Icon } from '@/components/base/icon';

export const stitchPlaceholderDefaultCols = 3;
export const stitchPlaceholderDefaultRows = 3;
export const stitchPlaceholderDefaultWidth = 480;
export const stitchPlaceholderDefaultHeight = 300;

export type CellImageOffset = { x: number; y: number };

const arrowButtonClass = 'pointer-events-auto absolute flex h-4 w-4 cursor-pointer items-center justify-center rounded-[4px] bg-[#E1E3E1]';

export type StitchPlaceholderPanelProps = {
  rows?: number;
  cols?: number;
  selected?: boolean;
  selectedCellIndex?: number | null;
  cellImages?: Record<string, string>;
  cellImageOffsets?: Record<string, CellImageOffset>;
  onCellClick?: (index: number) => void;
  onCellImageOffsetChange?: (index: number, offset: CellImageOffset) => void;
  onCellImageDelete?: (index: number) => void;
  onCellSwap?: (fromIndex: number, toIndex: number) => void;
};

type DragState = {
  cellIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
};

export const StitchPlaceholderPanel: React.FC<StitchPlaceholderPanelProps> = ({
  rows,
  cols,
  selected = false,
  selectedCellIndex = null,
  cellImages,
  cellImageOffsets,
  onCellClick,
  onCellImageOffsetChange,
  onCellImageDelete,
  onCellSwap,
}) => {
  const [hoveredCellIndex, setHoveredCellIndex] = useState<number | null>(null);
  const [liveDrag, setLiveDrag] = useState<{ index: number; x: number; y: number } | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const hasDraggedRef = useRef(false);
  const liveDragRef = useRef<{ index: number; x: number; y: number } | null>(null);

  const safeRows = Math.max(1, rows ?? stitchPlaceholderDefaultRows);
  const safeCols = Math.max(1, cols ?? stitchPlaceholderDefaultCols);
  const total = safeRows * safeCols;
  const borderColor = selected ? '#97A0FF' : '#D6D9E5';
  const lineColor = '#E2E5EE';
  const bgColor = '#F7F8FA';
  const textColor = '#B5BBC8';

  const handleCellClick = useCallback(
    (index: number) => {
      if (!onCellClick) return;
      onCellClick(index);
    },
    [onCellClick],
  );

  const handleImagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLImageElement>, index: number) => {
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const off = cellImageOffsets?.[String(index)] ?? { x: 50, y: 50 };
      dragRef.current = {
        cellIndex: index,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startOffsetX: off.x,
        startOffsetY: off.y,
      };
      hasDraggedRef.current = false;
    },
    [cellImageOffsets],
  );

  const handleImagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLImageElement>, index: number) => {
      const drag = dragRef.current;
      if (!drag || drag.cellIndex !== index || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDraggedRef.current = true;
      const x = Math.max(0, Math.min(100, drag.startOffsetX - dx * 0.3));
      const y = Math.max(0, Math.min(100, drag.startOffsetY - dy * 0.3));
      liveDragRef.current = { index, x, y };
      setLiveDrag({ index, x, y });
    },
    [],
  );

  const handleImagePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLImageElement>, index: number) => {
      const drag = dragRef.current;
      if (!drag || drag.cellIndex !== index) return;
      if (hasDraggedRef.current && liveDragRef.current?.index === index) {
        onCellImageOffsetChange?.(index, { x: liveDragRef.current.x, y: liveDragRef.current.y });
      }
      dragRef.current = null;
      liveDragRef.current = null;
      hasDraggedRef.current = false;
      setLiveDrag(null);
    },
    [onCellImageOffsetChange],
  );

  const handleImagePointerCancel = useCallback((index: number) => {
    if (!dragRef.current || dragRef.current.cellIndex !== index) return;
    dragRef.current = null;
    liveDragRef.current = null;
    hasDraggedRef.current = false;
    setLiveDrag(null);
  }, []);

  const handleImageClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (hasDraggedRef.current) e.stopPropagation();
  }, []);

  const handleDeleteClick = useCallback((index: number, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    onCellImageDelete?.(index);
  }, [onCellImageDelete]);

  const handleSwapClick = useCallback((fromIndex: number, toIndex: number, e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    onCellSwap?.(fromIndex, toIndex);
  }, [onCellSwap]);

  return (
    <div className='h-full w-full overflow-hidden rounded-[2px] border' style={{ borderColor, backgroundColor: bgColor }}>
      <div
        className='grid h-full w-full'
        style={{
          gridTemplateColumns: `repeat(${safeCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${safeRows}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: total }, (_, index) => {
          const row = Math.floor(index / safeCols);
          const col = index % safeCols;
          const isLastCol = col === safeCols - 1;
          const isLastRow = row === safeRows - 1;
          const cellImageSrc = cellImages?.[String(index)] ?? '';
          const hasImage = Boolean(cellImageSrc);
          const isSelectedCell = selectedCellIndex === index;
          const showHoverHint = hoveredCellIndex === index && !isSelectedCell && !hasImage;
          const isHoveredImageCell = hoveredCellIndex === index && hasImage;
          const isDraggingThis = liveDrag?.index === index;
          const effectiveOffset = isDraggingThis ? liveDrag : (cellImageOffsets?.[String(index)] ?? { x: 50, y: 50 });
          const canMoveUp = row > 0;
          const canMoveDown = row < safeRows - 1;
          const canMoveLeft = col > 0;
          const canMoveRight = col < safeCols - 1;

          return (
            <div
              key={index}
              className='relative overflow-hidden'
              style={{
                cursor: hasImage ? undefined : (onCellClick ? 'pointer' : 'default'),
                borderRight: isLastCol ? 'none' : `1px solid ${lineColor}`,
                borderBottom: isLastRow ? 'none' : `1px solid ${lineColor}`,
                backgroundColor: isSelectedCell ? '#EEF1FF' : 'transparent',
              }}
              onClick={() => handleCellClick(index)}
              onMouseEnter={() => setHoveredCellIndex(index)}
              onMouseLeave={() => setHoveredCellIndex((prev) => (prev === index ? null : prev))}
            >
              {hasImage ? (
                <>
                  <img
                    src={cellImageSrc}
                    alt={`stitch-cell-${index + 1}`}
                    className='nodrag nopan absolute inset-0 h-full w-full object-cover'
                    draggable={false}
                    style={{
                      objectPosition: `${effectiveOffset.x}% ${effectiveOffset.y}%`,
                      cursor: 'move',
                    }}
                    onPointerDown={(e) => handleImagePointerDown(e, index)}
                    onPointerMove={(e) => handleImagePointerMove(e, index)}
                    onPointerUp={(e) => handleImagePointerUp(e, index)}
                    onPointerCancel={() => handleImagePointerCancel(index)}
                    onClick={handleImageClick}
                  />
                  {isHoveredImageCell && (
                    <div className='pointer-events-none absolute inset-0'>
                      <button
                        type='button'
                        className='pointer-events-auto absolute right-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#E1E3E1] p-[2px]'
                        onClick={(e) => handleDeleteClick(index, e)}
                        aria-label='Delete cell image'
                      >
                        <Icon name='imageEditor-stitch-delete-icon' width={10} height={10} color='var(--bg-icon-base)' />
                      </button>
                      {canMoveUp && (
                        <div
                          className={`${arrowButtonClass} left-1/2 top-1 -translate-x-1/2`}
                          onClick={(e) => handleSwapClick(index, index - safeCols, e)}
                        >
                          <Icon name='base-chevron-down-icon' width={8} height={8} color='var(--bg-icon-base)' />
                        </div>
                      )}
                      {canMoveDown && (
                        <div
                          className={`${arrowButtonClass} bottom-1 left-1/2 -translate-x-1/2`}
                          onClick={(e) => handleSwapClick(index, index + safeCols, e)}
                        >
                          <Icon name='base-chevron-down-icon' width={8} height={8} color='var(--bg-icon-base)' className='rotate-180' />
                        </div>
                      )}
                      {canMoveLeft && (
                        <div
                          className={`${arrowButtonClass} left-1 top-1/2 -translate-y-1/2`}
                          onClick={(e) => handleSwapClick(index, index - 1, e)}
                        >
                          <Icon name='base-chevron-down-icon' width={8} height={8} color='var(--bg-icon-base)' className='-rotate-90' />
                        </div>
                      )}
                      {canMoveRight && (
                        <div
                          className={`${arrowButtonClass} right-1 top-1/2 -translate-y-1/2`}
                          onClick={(e) => handleSwapClick(index, index + 1, e)}
                        >
                          <Icon name='base-chevron-down-icon' width={8} height={8} color='var(--bg-icon-base)' className='rotate-90' />
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : showHoverHint ? (
                <div
                  className='absolute inset-0 flex flex-col items-center justify-center px-3 text-center'
                  style={{ color: textColor }}
                >
                  <span className='text-[22px] leading-none'>+</span>
                  <span className='text-[12px] leading-[1.15]'>Click on any image to add it to the cell</span>
                </div>
              ) : (
                <div className='absolute inset-0 flex items-center justify-center' style={{ color: textColor }}>
                  <span className='text-[22px] leading-none'>+</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
