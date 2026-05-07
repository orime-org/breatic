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
} from '@/features/chat/components/AgentInput';
import AgentSendButton from '@/features/chat/components/AgentSendButton';
import type { LocalCanvasNodeData } from '@/new/project/types';
import LocalNodeHeader from '../../common/LocalNodeHeader';
import LocalDataNodeHandle from '../../common/LocalDataNodeHandle';
import GenComposerToolbar from './GenComposerToolbar';
import { buildUpstreamItems, type UpstreamItem } from './upstreamItems';
import { CANVAS_OUTPUT_PENDING_MS } from '../../common/CanvasOutputPendingProgressOverlay';
import { CANVAS_SPAWNED_OUTPUT_GAP_PX } from '../../canvasSpawnLayout';

const defaultWidth = 420;

const paletteOutputDefaults: Record<string, { w: number; h: number }> = {
  '1001': { w: 300, h: 250 },
  '1002': { w: 300, h: 250 },
  '1003': { w: 300, h: 250 },
  '1004': { w: 472, h: 200 },
};

const paletteHandlesForOutput: Record<string, NonNullable<LocalCanvasNodeData['handles']>> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }] },
};

/** Default `data.name` for palette nodes — same as {@link LocalDataNodeHandle} `agentNodes` labels (send does not rename). */
const paletteOutputNodeName: Record<string, string> = {
  '1001': 'Text',
  '1002': 'Image',
  '1003': 'Video',
  '1004': 'Audio',
};

function paletteTypeFromGeneratorFlowType(flowType: string): keyof typeof paletteOutputDefaults | null {
  if (flowType === 'gen1001') return '1001';
  if (flowType === 'gen1002') return '1002';
  if (flowType === 'gen1003') return '1003';
  if (flowType === 'gen1004') return '1004';
  return null;
}

/** Left target (upstream) + right source (edge to spawned output on send). */
const handleSpec: Record<string, { target: string; source: string }> = {
  gen1001: { target: 'Text_0_0', source: 'Text_0_0' },
  gen1002: { target: 'Image_0_0', source: 'Image_0_0' },
  gen1003: { target: 'Video_0_0', source: 'Video_0_0' },
  gen1004: { target: 'Audio_0_0', source: 'Audio_0_0' },
};

const titleByType: Record<string, string> = {
  gen1001: 'Text Generator',
  gen1002: 'Image Generator',
  gen1003: 'Video Generator',
  gen1004: 'Audio Generator',
};

function parseGeneratorKind(flowType: string): keyof typeof handleSpec | null {
  if (flowType in handleSpec) return flowType as keyof typeof handleSpec;
  return null;
}

const LocalGenNode: React.FC<NodeProps<Node<LocalCanvasNodeData>>> = ({ id, type, data, selected }) => {
  const { setNodes, setEdges, getEdges, getNode, getNodes } = useReactFlow();
  const kind = parseGeneratorKind(String(type));
  const handles = kind ? handleSpec[kind] : handleSpec.gen1001;

  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);

  const upstreamItems = useMemo(
    () => buildUpstreamItems(nodes as Node[], edges as Edge[], id),
    [nodes, edges, id],
  );

  const title = data.name?.trim() ? data.name : (kind ? titleByType[kind] : 'Generator');

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
    const pos = self?.position ?? { x: 0, y: 0 };
    const x = pos.x + defaultWidth + CANVAS_SPAWNED_OUTPUT_GAP_PX;
    const y = pos.y;
    const newId = `${paletteType}-${Date.now()}-${nanoid(5)}`;
    const maxZ = getNodes().reduce((max, n) => Math.max(max, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
    const { w, h } = paletteOutputDefaults[paletteType];
    const handlesOut = paletteHandlesForOutput[paletteType];
    const outputName = paletteOutputNodeName[paletteType] ?? 'Output';

    let nextData: LocalCanvasNodeData;
    if (paletteType === '1001') {
      nextData = { name: outputName, text: '', handles: handlesOut, localOutputPending: true };
    } else if (paletteType === '1003') {
      nextData = {
        name: outputName,
        url: '',
        content: '',
        handles: handlesOut,
        localOutputPending: true,
        nodeRuntimeData: {},
      };
    } else {
      nextData = { name: outputName, url: '', handles: handlesOut, localOutputPending: true };
    }

    const newNode: Node<LocalCanvasNodeData> & { zIndex?: number } = {
      id: newId,
      type: paletteType,
      position: { x, y },
      zIndex: maxZ + 1,
      style: { width: w, height: h },
      selected: true,
      data: nextData,
    };

    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), newNode]);

    const flowHandle = handles.source;
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

    window.setTimeout(() => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== newId) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          return { ...n, data: { ...prev, localOutputPending: false } };
        }),
      );
    }, CANVAS_OUTPUT_PENDING_MS);

    input.clear();
    setInputEmpty(true);
    persistPromptHtml('');
  }, [getNode, getNodes, handles.source, id, persistPromptHtml, setEdges, setNodes, type]);

  useLayoutEffect(() => {
    const html = data.nodeRuntimeData?.prompt?.trim();
    if (html) {
      queueMicrotask(() => inputRef.current?.setHtml(html));
    }
  }, [data.nodeRuntimeData?.prompt]);

  return (
    <div className='relative' style={{ width: defaultWidth }}>
      <div className='absolute left-0 right-0 top-0 min-w-0 -translate-y-full overflow-hidden text-left text-foreground/60'>
        <LocalNodeHeader nodeId={id} nodeType={String(type)} title={title} />
      </div>
      <div
        className={cn(
          // `outline` can be clipped under the canvas `contain: paint`; `ring-inset` matches other nodes’ selected chrome.
          'relative flex min-h-0 flex-col rounded-[8px] bg-background-default-base pointer-events-auto ring-2 ring-inset ring-offset-0',
          selected ? 'ring-border-utilities-selected' : 'ring-transparent',
        )}
        style={{ width: defaultWidth }}
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
        />
        <LocalDataNodeHandle
          type='source'
          position={Position.Right}
          handleId={handles.source}
          nodeId={id}
          selected={selected}
          nodeHovered={nodeHovered}
          isInsideLockedGroup={false}
          allowManualConnect={false}
        />

        <div className='flex flex-col gap-2 p-3'>
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
        </div>
      </div>
    </div>
  );
};

export default memo(LocalGenNode);
