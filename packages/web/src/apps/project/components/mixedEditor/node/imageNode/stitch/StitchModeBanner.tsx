import React, { useEffect } from 'react';
import type { Node } from '@xyflow/react';

type StitchModeBannerProps = {
  nodes: Node[];
  stitchEditingNodeId: string | null;
  setStitchEditingNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  updateNode: (nodeId: string, updates: Partial<Node>) => void;
};

const StitchModeBanner: React.FC<StitchModeBannerProps> = ({
  nodes,
  stitchEditingNodeId,
  setStitchEditingNodeId,
  updateNode,
}) => {
  useEffect(() => {
    const selectedStitchNode = nodes.find((n) => n.type === 'stitchPlaceholderNode' && n.selected);
    const selectedStitchData = (selectedStitchNode?.data ?? {}) as { selectedCellIndex?: number | null };
    const selectedCellIndex = selectedStitchData.selectedCellIndex ?? null;
    if (selectedStitchNode && selectedCellIndex != null && stitchEditingNodeId !== selectedStitchNode.id) {
      setStitchEditingNodeId(selectedStitchNode.id);
      return;
    }
    if (!stitchEditingNodeId) return;
    const editingNode = nodes.find((n) => n.id === stitchEditingNodeId && n.type === 'stitchPlaceholderNode');
    if (!editingNode) {
      setStitchEditingNodeId(null);
      return;
    }
    const editingData = (editingNode.data ?? {}) as { selectedCellIndex?: number | null };
    if (editingData.selectedCellIndex == null) {
      setStitchEditingNodeId(null);
    }
  }, [nodes, stitchEditingNodeId, setStitchEditingNodeId]);

  const stitchEditMode = stitchEditingNodeId != null;

  const exitStitchEditMode = () => {
    if (!stitchEditingNodeId) return;
    setStitchEditingNodeId(null);
    updateNode(stitchEditingNodeId, { selected: true, data: { selectedCellIndex: null } });
  };

  useEffect(() => {
    if (!stitchEditMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      exitStitchEditMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stitchEditMode, stitchEditingNodeId]);

  if (!stitchEditMode) return null;

  return (
    <div className='pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center'>
      <button
        type='button'
        className='pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border border-white/40 bg-black/50 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/65'
        onClick={exitStitchEditMode}
      >
        <span>Click here or press</span>
        <span className='rounded border border-white/55 px-1 text-[10px]'>ESC</span>
        <span>to exit</span>
      </button>
    </div>
  );
};

export default StitchModeBanner;
