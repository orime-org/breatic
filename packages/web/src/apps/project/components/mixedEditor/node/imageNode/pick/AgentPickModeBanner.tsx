import React, { useEffect } from 'react';
import type { Node } from '@xyflow/react';
import type { ImageFlowNodeData } from '../../../types';

type AgentPickModeBannerProps = {
  nodes: Node[];
  agentCanvasPickEditingNodeId: string | null;
  setAgentCanvasPickEditingNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  updateNode: (nodeId: string, updates: Partial<Node>, options?: { history?: 'skip' }) => void;
};

const AgentPickModeBanner: React.FC<AgentPickModeBannerProps> = ({
  nodes,
  agentCanvasPickEditingNodeId,
  setAgentCanvasPickEditingNodeId,
  updateNode,
}) => {
  useEffect(() => {
    const source = nodes.find(
      (node) => (node.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.fromCanvas === true,
    );
    if (source && agentCanvasPickEditingNodeId !== source.id) {
      setAgentCanvasPickEditingNodeId(source.id);
      return;
    }
    if (!agentCanvasPickEditingNodeId) return;
    const editing = nodes.find((node) => node.id === agentCanvasPickEditingNodeId);
    const stillPicking =
      editing && (editing.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.fromCanvas === true;
    if (!stillPicking) {
      setAgentCanvasPickEditingNodeId(null);
    }
  }, [nodes, agentCanvasPickEditingNodeId, setAgentCanvasPickEditingNodeId]);

  const agentCanvasPickEditMode = agentCanvasPickEditingNodeId != null;

  const exitAgentCanvasPickMode = () => {
    if (!agentCanvasPickEditingNodeId) return;
    updateNode(agentCanvasPickEditingNodeId, { data: { pickState: null } }, { history: 'skip' });
    for (const node of nodes) {
      const boxes = (node.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.resultBoxes;
      if (boxes?.length) {
        updateNode(node.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
  };

  useEffect(() => {
    if (!agentCanvasPickEditMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      exitAgentCanvasPickMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [agentCanvasPickEditMode, agentCanvasPickEditingNodeId, nodes]);

  if (!agentCanvasPickEditMode) return null;

  return (
    <div className='pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center'>
      <button
        type='button'
        className='pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border border-white/40 bg-black/50 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/65'
        onClick={exitAgentCanvasPickMode}
      >
        <span>Click here or press</span>
        <span className='rounded border border-white/55 px-1 text-[10px]'>ESC</span>
        <span>to exit</span>
      </button>
    </div>
  );
};

export default AgentPickModeBanner;
