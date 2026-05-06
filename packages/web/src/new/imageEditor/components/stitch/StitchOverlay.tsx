import React, { useState } from 'react';

type StitchOverlayProps = {
  rows: number;
  cols: number;
  viewportScale?: number;
};

const StitchOverlay: React.FC<StitchOverlayProps> = ({ rows, cols, viewportScale }) => {
  const [hoveredCellKey, setHoveredCellKey] = useState<string | null>(null);

  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const safeScale = Math.max(0.0001, viewportScale ?? 1);
  const inverseScale = 1 / safeScale;
  const borderWidth = Math.max(1 * inverseScale, 0.5);
  const plusFontSize = Math.max(22 * inverseScale, 14);
  const hintFontSize = Math.max(12 * inverseScale, 8);

  return (
    <div className='pointer-events-none absolute inset-0'>
      <div
        className='grid h-full w-full'
        style={{
          gridTemplateColumns: `repeat(${safeCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${safeRows}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: safeRows }).map((_, rowIndex) =>
          Array.from({ length: safeCols }).map((__, colIndex) => {
            const row = rowIndex + 1;
            const col = colIndex + 1;
            const cellKey = `${row}-${col}`;
            return (
              <div
                key={cellKey}
                className='pointer-events-auto relative flex cursor-pointer items-center justify-center border-solid border-[#98A2FF]'
                style={{
                  borderTopWidth: borderWidth,
                  borderLeftWidth: borderWidth,
                  borderRightWidth: col === safeCols ? borderWidth : 0,
                  borderBottomWidth: row === safeRows ? borderWidth : 0,
                }}
                onMouseEnter={() => setHoveredCellKey(cellKey)}
                onMouseLeave={() => setHoveredCellKey((prev) => (prev === cellKey ? null : prev))}
              >
                {hoveredCellKey === cellKey ? (
                  <div className='flex flex-col items-center justify-center px-3 text-center text-[#B5BBC8]'>
                    <span style={{ fontSize: plusFontSize }} className='leading-none'>
                      +
                    </span>
                    <span style={{ fontSize: hintFontSize }} className='leading-[1.15]'>
                      Click on any image to add it to the cell
                    </span>
                  </div>
                ) : (
                  <span style={{ fontSize: plusFontSize }} className='leading-none text-[#B5BBC8]'>
                    +
                  </span>
                )}
              </div>
            );
          }),
        )}
      </div>
    </div>
  );
};

export default StitchOverlay;
