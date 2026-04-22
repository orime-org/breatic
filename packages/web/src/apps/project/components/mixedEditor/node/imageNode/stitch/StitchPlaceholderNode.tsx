import React, { memo, useCallback, useMemo } from 'react';
import { NodeToolbar as FlowNodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { useMixedEditorActions } from '@/hooks/useMixedEditorActions';
import { message } from '@/components/base/message';
import { createEditorImageNodeData, imageEditorImageNodeType } from '../../../types';
import StitchBottomToolbar from './StitchBottomToolbar';
import {
  StitchPlaceholderPanel,
  stitchPlaceholderDefaultCols,
  stitchPlaceholderDefaultHeight,
  stitchPlaceholderDefaultRows,
  stitchPlaceholderDefaultWidth,
  type CellImageOffset,
} from './StitchPlaceholderPanel';

const stitchResultMinLoadingMs = 3000;

const StitchPlaceholderNode: React.FC<NodeProps> = ({ id, data, selected, width, height }) => {
  const { updateNode } = useMixedEditorActions();
  const stitchData = (data ?? {}) as {
    rows?: number;
    cols?: number;
    selectedCellIndex?: number | null;
    cellImages?: Record<string, string>;
    cellImageOffsets?: Record<string, CellImageOffset>;
  };
  const rows = Math.max(1, stitchData.rows ?? stitchPlaceholderDefaultRows);
  const cols = Math.max(1, stitchData.cols ?? stitchPlaceholderDefaultCols);
  const nodeWidth = Math.max(1, Math.round(width ?? stitchPlaceholderDefaultWidth));
  const nodeHeight = Math.max(1, Math.round(height ?? stitchPlaceholderDefaultHeight));
  const selectedCellIndex = stitchData.selectedCellIndex ?? null;
  const showStitchToolbar = Boolean(selected);
  const cellImages = useMemo(() => stitchData.cellImages ?? {}, [stitchData.cellImages]);
  const cellImageOffsets = useMemo(() => stitchData.cellImageOffsets ?? {}, [stitchData.cellImageOffsets]);
  const loadImage = useCallback((src: string) => {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
      img.src = src;
    });
  }, []);

  const handleToolbarSend = useCallback(async () => {
    const startedAt = Date.now();
    const total = rows * cols;
    const indices = Array.from({ length: total }, (_, i) => i);
    const filledIndices = indices.filter((index) => Boolean(cellImages[String(index)]));
    if (filledIndices.length === 0) {
      message.warning('No images to stitch');
      return;
    }

    const sourceCellWidth = nodeWidth / cols;
    const sourceCellHeight = nodeHeight / rows;
    const outputWidth = Math.max(1, Math.round(sourceCellWidth * cols));
    const outputHeight = Math.max(1, Math.round(sourceCellHeight * rows));

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      message.error('Failed to create stitch image');
      return;
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outputWidth, outputHeight);

    // Switch to an image node with empty `src` to show the standard loading UI.
    updateNode(id, {
      type: imageEditorImageNodeType,
      selected: true,
      style: { width: outputWidth, height: outputHeight },
      data: createEditorImageNodeData('Stitch Result', ''),
    });

    const cellWidth = sourceCellWidth;
    const cellHeight = sourceCellHeight;

    for (const index of filledIndices) {
      const src = cellImages[String(index)];
      if (!src) continue;
      try {
        const img = await loadImage(src);
        const offset = cellImageOffsets[String(index)] ?? { x: 50, y: 50 };
        const originalRow = Math.floor(index / cols);
        const originalCol = index % cols;
        const cellX = originalCol * cellWidth;
        const cellY = originalRow * cellHeight;
        const scale = Math.max(cellWidth / img.naturalWidth, cellHeight / img.naturalHeight);
        const drawWidth = img.naturalWidth * scale;
        const drawHeight = img.naturalHeight * scale;
        const maxShiftX = Math.max(0, drawWidth - cellWidth);
        const maxShiftY = Math.max(0, drawHeight - cellHeight);
        const drawX = cellX - (maxShiftX * Math.max(0, Math.min(100, offset.x))) / 100;
        const drawY = cellY - (maxShiftY * Math.max(0, Math.min(100, offset.y))) / 100;

        ctx.save();
        ctx.beginPath();
        ctx.rect(cellX, cellY, cellWidth, cellHeight);
        ctx.clip();
        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
        ctx.restore();
      } catch {
        // Skip failed cell image and continue stitching remaining cells.
      }
    }

    const stitchedSrc = canvas.toDataURL('image/png');
    const elapsed = Date.now() - startedAt;
    if (elapsed < stitchResultMinLoadingMs) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, stitchResultMinLoadingMs - elapsed);
      });
    }
    updateNode(id, {
      selected: true,
      data: createEditorImageNodeData('Stitch Result', stitchedSrc),
    });
  }, [cellImageOffsets, cellImages, cols, id, loadImage, nodeHeight, nodeWidth, rows, updateNode]);

  const handleGridSliceChange = useCallback((next: { rows: number; cols: number }) => {
    const nextRows = Math.max(1, next.rows);
    const nextCols = Math.max(1, next.cols);
    let nextSelectedCellIndex = selectedCellIndex;
    if (nextSelectedCellIndex != null) {
      const maxIndex = nextRows * nextCols - 1;
      if (nextSelectedCellIndex > maxIndex) nextSelectedCellIndex = null;
    }
    updateNode(id, {
      data: {
        rows: nextRows,
        cols: nextCols,
        selectedCellIndex: nextSelectedCellIndex,
        cellImages: Object.fromEntries(
          Object.entries(cellImages).filter(([key]) => {
            const idx = Number(key);
            return Number.isFinite(idx) && idx >= 0 && idx < nextRows * nextCols;
          }),
        ),
        cellImageOffsets: Object.fromEntries(
          Object.entries(cellImageOffsets).filter(([key]) => {
            const idx = Number(key);
            return Number.isFinite(idx) && idx >= 0 && idx < nextRows * nextCols;
          }),
        ),
      },
    });
  }, [cellImageOffsets, cellImages, id, selectedCellIndex, updateNode]);

  const handlePanelCellClick = useCallback((index: number) => {
    updateNode(id, {
      selected: true,
      data: { selectedCellIndex: index },
    });
  }, [id, updateNode]);

  const handleDimensionChange = useCallback((next: { width: number; height: number }) => {
    updateNode(id, {
      style: {
        width: Math.max(1, next.width),
        height: Math.max(1, next.height),
      },
    });
  }, [id, updateNode]);

  const handleCellImageOffsetChange = useCallback((index: number, offset: CellImageOffset) => {
    updateNode(id, {
      data: { cellImageOffsets: { ...cellImageOffsets, [String(index)]: offset } },
    });
  }, [id, cellImageOffsets, updateNode]);

  const handleCellImageDelete = useCallback((index: number) => {
    const key = String(index);
    const nextCellImages = Object.fromEntries(Object.entries(cellImages).filter(([k]) => k !== key));
    const nextCellImageOffsets = Object.fromEntries(Object.entries(cellImageOffsets).filter(([k]) => k !== key));
    updateNode(id, {
      selected: true,
      data: {
        cellImages: nextCellImages,
        cellImageOffsets: nextCellImageOffsets,
        selectedCellIndex: index,
      },
    });
  }, [cellImageOffsets, cellImages, id, updateNode]);

  const handleCellSwap = useCallback((fromIndex: number, toIndex: number) => {
    const fromKey = String(fromIndex);
    const toKey = String(toIndex);
    const fromImage = cellImages[fromKey];
    const toImage = cellImages[toKey];
    const fromOffset = cellImageOffsets[fromKey];
    const toOffset = cellImageOffsets[toKey];

    const nextCellImages = { ...cellImages };
    const nextCellImageOffsets = { ...cellImageOffsets };

    if (toImage) {
      nextCellImages[fromKey] = toImage;
    } else {
      delete nextCellImages[fromKey];
    }
    if (fromImage) {
      nextCellImages[toKey] = fromImage;
    } else {
      delete nextCellImages[toKey];
    }

    if (toOffset) {
      nextCellImageOffsets[fromKey] = toOffset;
    } else {
      delete nextCellImageOffsets[fromKey];
    }
    if (fromOffset) {
      nextCellImageOffsets[toKey] = fromOffset;
    } else {
      delete nextCellImageOffsets[toKey];
    }

    updateNode(id, {
      selected: true,
      data: {
        cellImages: nextCellImages,
        cellImageOffsets: nextCellImageOffsets,
        selectedCellIndex: toIndex,
      },
    });
  }, [cellImageOffsets, cellImages, id, updateNode]);

  return (
    <>
      <FlowNodeToolbar isVisible={showStitchToolbar} position={Position.Bottom} offset={10} align='center'>
        <StitchBottomToolbar
          active={Boolean(selected)}
          onSend={handleToolbarSend}
          gridSlice={{ rows, cols }}
          onGridSliceChange={handleGridSliceChange}
          width={nodeWidth}
          height={nodeHeight}
          onDimensionChange={handleDimensionChange}
        />
      </FlowNodeToolbar>
      <StitchPlaceholderPanel
        rows={rows}
        cols={cols}
        selected={Boolean(selected)}
        selectedCellIndex={selectedCellIndex}
        cellImages={cellImages}
        cellImageOffsets={cellImageOffsets}
        onCellClick={handlePanelCellClick}
        onCellImageOffsetChange={handleCellImageOffsetChange}
        onCellImageDelete={handleCellImageDelete}
        onCellSwap={handleCellSwap}
      />
    </>
  );
};

export default memo(StitchPlaceholderNode);
