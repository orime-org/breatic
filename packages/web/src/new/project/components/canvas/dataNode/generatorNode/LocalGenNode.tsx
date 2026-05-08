/**
 * Local canvas generator node (`gen1001`–`gen1004`): composer + {@link GeneratorModelFooter} (mode dropdown only on audio).
 * Created from connect-end {@link ConnectEndCommandMenu}.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addEdge, Position, useReactFlow, useStore, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { cn } from '@/utils/classnames';
import AgentComposerInput, {
  type AgentComposerInputHandle,
} from '@/components/base/agent/AgentInput';
import type { ImageEditorNodeRuntimeData, LocalCanvasNodeData } from '@/new/project/types';
import type { MenuItemType } from '@/components/base/dropdown';
import LocalNodeHeader from '../../common/LocalNodeHeader';
import LocalDataNodeHandle from '../../common/LocalDataNodeHandle';
import LocalNodeSkeleton, { zoomLevelShowContentSelector } from '../../common/LocalNodeSkeleton';
import { selectLocalMultiSelectOutboundRepresentativeId } from '../../common/localFlowNodeSpawn';
import { selectFlowCanvasSelectedCount } from '../../flow/flowCanvasSelection';
import GenComposerToolbar from './GenComposerToolbar';
import { buildUpstreamItems, type UpstreamItem } from './upstreamItems';
import { CANVAS_OUTPUT_PENDING_MS } from '../../common/CanvasOutputPendingProgressOverlay';
import GeneratorModelFooter from './GeneratorModelFooter';
import AudioGenerationModelSettingsPanel from './AudioGenerationModelSettingsPanel';
import SimpleModelPickerPanel from './SimpleModelPickerPanel';
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
import {
  AUDIO_GENERATOR_MODE_ITEMS,
  AUDIO_MODEL_OPTIONS_BY_MODE,
  defaultModelLabelForAudioMode,
  normalizeAudioGeneratorCategoryKey,
} from './audioGeneratorStaticModels';

function parseGeneratorKind(flowType: string): keyof typeof generatorHandleIds | null {
  if (flowType in generatorHandleIds) return flowType as keyof typeof generatorHandleIds;
  return null;
}

const TEXT_MODEL_OPTIONS = ['Gemini 2K', 'GPT-4o'] as const;
const IMAGE_MODEL_OPTIONS = ['Nano Banana', 'Flux dev'] as const;
const VIDEO_MODEL_OPTIONS = ['Kling 1.5', 'Minimax Video'] as const;

/** Legacy persisted label without hyphen — maps to menu key. */
const normalizeLanguageLabel = (label: string): string =>
  label === '中文普通话' ? '中文-普通话' : label;

function defaultCategoryKey(kind: keyof typeof generatorHandleIds): string {
  if (kind === 'gen1004') return 'tts';
  if (kind === 'gen1001') return 'chat';
  return 'gen';
}

function defaultModelLabel(kind: keyof typeof generatorHandleIds): string {
  if (kind === 'gen1001') return 'Gemini 2K';
  if (kind === 'gen1002') return 'Nano Banana';
  if (kind === 'gen1003') return 'Kling 1.5';
  return 'Minimax Speech 02 hd';
}

const CREDIT_ESTIMATE = 120;

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

  const nrd = data.nodeRuntimeData ?? {};
  const categoryKey = useMemo(() => {
    const raw = nrd.generatorCategoryKey ?? (kind ? defaultCategoryKey(kind) : 'chat');
    if (kind === 'gen1004') return normalizeAudioGeneratorCategoryKey(String(raw));
    return String(raw);
  }, [kind, nrd.generatorCategoryKey]);
  const modelLabel = nrd.modelLabel ?? (kind ? defaultModelLabel(kind) : 'Gemini 2K');
  const voiceLabel = nrd.voiceLabel ?? '创新设计师';
  const languageLabel = nrd.languageLabel ?? '中文-普通话';

  const patchRuntime = useCallback(
    (patch: Partial<ImageEditorNodeRuntimeData>) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          const nodeRuntimeData = { ...prev.nodeRuntimeData, ...patch };
          return { ...n, data: { ...prev, nodeRuntimeData } };
        }),
      );
    },
    [id, setNodes],
  );

  const [nodeHovered, setNodeHovered] = useState(false);
  const inputRef = useRef<AgentComposerInputHandle>(null);
  const [inputEmpty, setInputEmpty] = useState(true);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);

  const categoryMenuItems: MenuItemType[] = useMemo(() => {
    if (kind !== 'gen1004') return [];
    return AUDIO_GENERATOR_MODE_ITEMS.map((m) => ({
      key: m.key,
      label: <span className='text-[13px] font-medium text-text-default-base'>{m.label}</span>,
    }));
  }, [kind]);

  const categoryDisplayLabel = useMemo(() => {
    if (kind !== 'gen1004') return '';
    return AUDIO_GENERATOR_MODE_ITEMS.find((x) => x.key === categoryKey)?.label ?? 'TTS';
  }, [kind, categoryKey]);

  const audioModeResolved = useMemo(
    () => (kind === 'gen1004' ? normalizeAudioGeneratorCategoryKey(String(categoryKey)) : null),
    [kind, categoryKey],
  );

  const audioFooterSummary = useMemo(() => {
    if (kind === 'gen1004' && audioModeResolved && audioModeResolved !== 'tts') {
      return modelLabel;
    }
    const lang = normalizeLanguageLabel(languageLabel);
    const langShort = lang.includes('中文') ? '中文' : lang;
    return `${modelLabel} ${langShort} ${voiceLabel}`.replace(/\s+/g, ' ').trim();
  }, [audioModeResolved, kind, languageLabel, modelLabel, voiceLabel]);

  const modelPillSummary = kind === 'gen1004' ? audioFooterSummary : modelLabel;

  const simpleModelOptions = useMemo(() => {
    if (!kind) return [];
    if (kind === 'gen1001') return [...TEXT_MODEL_OPTIONS];
    if (kind === 'gen1002') return [...IMAGE_MODEL_OPTIONS];
    if (kind === 'gen1003') return [...VIDEO_MODEL_OPTIONS];
    return [];
  }, [kind]);

  useEffect(() => {
    if (kind !== 'gen1004' || !audioModeResolved) return;
    const allowed = AUDIO_MODEL_OPTIONS_BY_MODE[audioModeResolved];
    if (!allowed.includes(modelLabel)) {
      patchRuntime({ modelLabel: defaultModelLabelForAudioMode(audioModeResolved) });
    }
  }, [audioModeResolved, kind, modelLabel, patchRuntime]);

  const modelPanelContent = useMemo(() => {
    if (!kind) return null;
    if (kind === 'gen1004' && audioModeResolved) {
      return (
        <AudioGenerationModelSettingsPanel
          modelOptions={[...AUDIO_MODEL_OPTIONS_BY_MODE[audioModeResolved]]}
          showVoiceAndLanguage={audioModeResolved === 'tts'}
          modelLabel={modelLabel}
          voiceLabel={voiceLabel}
          languageLabel={languageLabel}
          onModelLabel={(v) => patchRuntime({ modelLabel: v })}
          onVoiceLabel={(v) => patchRuntime({ voiceLabel: v })}
          onLanguageLabel={(v) => patchRuntime({ languageLabel: v })}
          onVoiceCommit={() => setModelPanelOpen(false)}
        />
      );
    }
    return (
      <SimpleModelPickerPanel
        options={simpleModelOptions}
        selected={modelLabel}
        onSelect={(v) => {
          patchRuntime({ modelLabel: v });
          setModelPanelOpen(false);
        }}
      />
    );
  }, [
    audioModeResolved,
    kind,
    languageLabel,
    modelLabel,
    patchRuntime,
    simpleModelOptions,
    voiceLabel,
  ]);

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

  const onCategorySelect = useCallback(
    (key: string) => {
      const mode = normalizeAudioGeneratorCategoryKey(key);
      patchRuntime({
        generatorCategoryKey: mode,
        modelLabel: defaultModelLabelForAudioMode(mode),
      });
    },
    [patchRuntime],
  );

  return (
    <div className='relative' style={{ width: GENERATOR_NODE_WIDTH_PX }}>
      <div className='absolute left-0 right-0 top-0 min-w-0 -translate-y-full overflow-hidden text-left text-foreground/60'>
        <LocalNodeHeader nodeId={id} nodeType={String(type)} title={title} />
      </div>
      <div
        className={cn(
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
                <GeneratorModelFooter
                  showCategoryDropdown={kind === 'gen1004'}
                  categoryMenuItems={categoryMenuItems}
                  categoryDisplayLabel={categoryDisplayLabel}
                  onCategorySelect={onCategorySelect}
                  modelPillSummary={modelPillSummary}
                  modelPanelOpen={modelPanelOpen}
                  onModelPanelOpenChange={setModelPanelOpen}
                  modelPanelContent={modelPanelContent}
                  creditEstimate={CREDIT_ESTIMATE}
                  sendDisabled={inputEmpty}
                  onSend={handleSendClick}
                />
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
