/**
 * Local canvas “agent generator” node: chat-style composer (toolbar + prompt + send) created from
 * connect-end {@link ConnectEndCommandMenu}. React Flow types: `gen1001`–`gen1004`.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addEdge, Position, useReactFlow, useStore, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { cn } from '@/utils/classnames';
import AgentComposerInput, {
  type AgentComposerInputHandle,
} from '@/components/base/agent/AgentInput';
import AgentSendButton from '@/components/base/agent/AgentSendButton';
import type { LocalCanvasNodeData } from '@/new/project/types';
import LocalNodeHeader from '../../common/LocalNodeHeader';
import LocalDataNodeHandle from '../../common/LocalDataNodeHandle';
import LocalNodeSkeleton, { zoomLevelShowContentSelector } from '../../common/LocalNodeSkeleton';
import { selectLocalMultiSelectOutboundRepresentativeId } from '../../common/localFlowNodeSpawn';
import { selectFlowCanvasSelectedCount } from '../../flow/flowCanvasSelection';
import GenComposerToolbar from './GenComposerToolbar';
import { buildUpstreamItems, type UpstreamItem } from './upstreamItems';
import { CANVAS_OUTPUT_PENDING_MS } from '../../common/CanvasOutputPendingProgressOverlay';
import {
  buildPendingPaletteOutputData,
  computeNextGeneratorPaletteOutputPosition,
  findEmptyDownstreamPaletteOutput,
  GENERATOR_NODE_WIDTH_PX,
  generatorHandleIds,
  generatorTitleByFlowType,
  paletteOutputDefaults,
  paletteTypeFromGeneratorFlowType,
} from './generatorPaletteOutput';

function parseGeneratorKind(flowType: string): keyof typeof generatorHandleIds | null {
  if (flowType in generatorHandleIds) return flowType as keyof typeof generatorHandleIds;
  return null;
}

const LocalGenNode: React.FC<NodeProps<Node<LocalCanvasNodeData>>> = ({ id, type, data, selected }) => {
  const { setNodes, setEdges, getEdges, getNode, getNodes } = useReactFlow();
  const kind = parseGeneratorKind(String(type));
  const handles = kind ? generatorHandleIds[kind] : generatorHandleIds.gen1001;

  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const flowCanvasSelectedCount = useStore(useCallback((s) => selectFlowCanvasSelectedCount(s), []));
  const localMultiSelectOutboundRepId = useStore(
    useCallback((s) => selectLocalMultiSelectOutboundRepresentativeId(s), []),
  );
  const showContent = useStore(zoomLevelShowContentSelector);

  const upstreamItems = useMemo(
    () => buildUpstreamItems(nodes as Node[], edges as Edge[], id),
    [nodes, edges, id],
  );

  const title = data.name?.trim() ? data.name : (kind ? generatorTitleByFlowType[kind] : 'Generator');

  const [nodeHovered, setNodeHovered] = useState(false);
  const inputRef = useRef<AgentComposerInputHandle>(null);
  const [inputEmpty, setInputEmpty] = useState(true);

  const handleRemoveUpstreamItem = useCallback(
    (item: UpstreamItem) => {
      const edge = getEdges().find((e) => e.source === item.sourceNodeId && e.target === id);
      if (!edge) return;
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [getEdges, id, setEdges],
  );

  const persistPromptHtml = useCallback(
    (html: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          const nodeRuntimeData = { ...prev.nodeRuntimeData, prompt: html };
          return { ...n, data: { ...prev, nodeRuntimeData } };
        }),
      );
    },
    [id, setNodes],
  );

  const handleSendClick = useCallback(() => {
    const input = inputRef.current;
    if (!input || input.isEmpty()) return;
    const html = input.getHtml();
    persistPromptHtml(html);

    const paletteType = paletteTypeFromGeneratorFlowType(String(type));
    if (!paletteType) {
      input.clear();
      setInputEmpty(true);
      return;
    }

    const self = getNode(id);
    if (!self) {
      input.clear();
      setInputEmpty(true);
      return;
    }

    const flowHandle = handles.source;
    const reuse = findEmptyDownstreamPaletteOutput(getNodes, getEdges, id, flowHandle, paletteType);

    const maxZ = getNodes().reduce((max, n) => Math.max(max, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
    const { w, h } = paletteOutputDefaults[paletteType];
    const pendingData = buildPendingPaletteOutputData(paletteType);

    let outputNodeId: string;

    if (reuse) {
      outputNodeId = reuse.id;
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== outputNodeId) return { ...n, selected: false };
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          return {
            ...n,
            selected: true,
            data: { ...prev, ...pendingData },
          };
        }),
      );
    } else {
      const { x, y } = computeNextGeneratorPaletteOutputPosition(self, getNodes, getEdges, id, flowHandle, paletteType);
      const newId = `${paletteType}-${Date.now()}-${nanoid(5)}`;
      outputNodeId = newId;

      const newNode: Node<LocalCanvasNodeData> & { zIndex?: number } = {
        id: newId,
        type: paletteType,
        position: { x, y },
        zIndex: maxZ + 1,
        style: { width: w, height: h },
        selected: true,
        data: pendingData,
      };

      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), newNode]);

      const edgeId = `e-${id}-${flowHandle}-${newId}-${flowHandle}`;
      setEdges((eds) => {
        if (eds.some((e) => e.id === edgeId)) return eds;
        return addEdge(
          {
            id: edgeId,
            source: id,
            target: newId,
            sourceHandle: flowHandle,
            targetHandle: flowHandle,
            type: 'default',
          },
          eds,
        );
      });
    }

    window.setTimeout(() => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== outputNodeId) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          return { ...n, data: { ...prev, localOutputPending: false } };
        }),
      );
    }, CANVAS_OUTPUT_PENDING_MS);

    input.clear();
    setInputEmpty(true);
    persistPromptHtml('');
  }, [getEdges, getNode, getNodes, handles.source, id, persistPromptHtml, setEdges, setNodes, type]);

  useLayoutEffect(() => {
    const html = data.nodeRuntimeData?.prompt?.trim();
    if (html) {
      queueMicrotask(() => inputRef.current?.setHtml(html));
    }
  }, [data.nodeRuntimeData?.prompt]);

  return (
    <div className='relative' style={{ width: GENERATOR_NODE_WIDTH_PX }}>
      <div className='absolute left-0 right-0 top-0 min-w-0 -translate-y-full overflow-hidden text-left text-foreground/60'>
        <LocalNodeHeader nodeId={id} nodeType={String(type)} title={title} />
      </div>
      <div
        className={cn(
          // `outline` can be clipped under the canvas `contain: paint`; `ring-inset` matches other nodes’ selected chrome.
          'relative flex min-h-0 flex-col rounded-[8px] bg-background-default-base pointer-events-auto ring-2 ring-inset ring-offset-0',
          selected ? 'ring-border-utilities-selected' : 'ring-transparent',
        )}
        style={{ width: GENERATOR_NODE_WIDTH_PX }}
        onMouseEnter={() => setNodeHovered(true)}
        onMouseLeave={() => setNodeHovered(false)}
      >
        <LocalDataNodeHandle
          type='target'
          position={Position.Left}
          handleId={handles.target}
          nodeId={id}
          selected={selected}
          nodeHovered={nodeHovered}
          isInsideLockedGroup={false}
          hideChrome={selected && flowCanvasSelectedCount > 1}
          keepConnectableWhenHidden={selected && flowCanvasSelectedCount > 1}
        />
        <LocalDataNodeHandle
          type='source'
          position={Position.Right}
          handleId={handles.source}
          nodeId={id}
          selected={selected}
          nodeHovered={nodeHovered}
          isInsideLockedGroup={false}
          hideChrome={selected && flowCanvasSelectedCount > 1}
          keepConnectableWhenHidden={
            selected && flowCanvasSelectedCount > 1 && id === localMultiSelectOutboundRepId
          }
          allowManualConnect={false}
        />

        <div className='flex flex-col gap-2 p-3'>
          {showContent ? (
            <>
              <GenComposerToolbar
                upstreamItems={upstreamItems}
                onRemoveUpstreamItem={handleRemoveUpstreamItem}
                onLayoutClick={() => inputRef.current?.focusEditor()}
              />

              <div className='nodrag nopan rounded-[4px] border border-[var(--color-border-default-base)] bg-background-default-base'>
                <AgentComposerInput
                  ref={inputRef}
                  canvasPickSourceId={id}
                  placeholder={'Use "/" to activate skills.\nUse "@" to add resources to the dialogue.'}
                  onEnterSend={handleSendClick}
                  onEmptyChange={setInputEmpty}
                  upstreamItems={[]}
                  uploadItems={[]}
                  className='h-[112px] break-words whitespace-pre-wrap'
                />
              </div>
              <div className='nodrag nopan'>
                <AgentSendButton disabled={inputEmpty} onClick={handleSendClick} />
              </div>
            </>
          ) : (
            <div className='nodrag nopan h-[220px] w-full flex-shrink-0'>
              <LocalNodeSkeleton />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(LocalGenNode);
