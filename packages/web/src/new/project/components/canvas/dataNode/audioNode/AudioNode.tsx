/**
 * Local audio node (type `1004`) — shell shows waveform / placeholder only; mini-tools + generation live in {@link FlowNodeToolbar} (same pattern as image node bottom bar).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NodeToolbar as FlowNodeToolbar,
  Position,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import { message } from '@/components/base/message';
import CanvasOutputPendingProgressOverlay from '../../common/CanvasOutputPendingProgressOverlay';
import type { AudioGenerationMode, AudioNodeRuntimeData, LocalCanvasNodeData } from '@/new/project/types';
import LocalNodeHeader from '../../common/LocalNodeHeader';
import LocalDataNodeHandle from '../../common/LocalDataNodeHandle';
import { selectLocalMultiSelectOutboundRepresentativeId } from '../../common/localFlowNodeSpawn';
import LocalNodeSkeleton, { zoomLevelShowContentSelector } from '../../common/LocalNodeSkeleton';
import { selectFlowCanvasSelectedCount } from '../../flow/flowCanvasSelection';
import CanvasAudioWaveform from '../../common/CanvasAudioWaveform';
import { buildUpstreamItems } from '../generatorNode/upstreamItems';
import Toolbar from './Toolbar';
import GenerationBottomToolbar from './generation/GenerationBottomToolbar';

const targetHandleId = 'Audio_0_0';
const sourceHandleId = 'Audio_0_0';

const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

const defaultAudioRuntime = (): AudioNodeRuntimeData => ({
  generationMode: 'tts',
  stylesPrompt: '',
  lyrics: '',
  instrumental: false,
  modelLabel: 'Minimax Speech 02 hd',
  voiceLabel: '沉稳高管',
  languageLabel: '中文普通话',
});

const AudioNode: React.FC<NodeProps<Node<LocalCanvasNodeData>>> = ({ id, type, data, selected }) => {
  const { t } = useTranslation();
  const { setNodes, setEdges } = useReactFlow();
  const showContent = useStore(zoomLevelShowContentSelector);
  const nodes = useStore(useCallback((s) => s.nodes as Node<LocalCanvasNodeData>[], []));
  const edges = useStore(useCallback((s) => s.edges as Edge[], []));
  const flowCanvasSelectedCount = useStore(useCallback((s) => selectFlowCanvasSelectedCount(s), []));
  const localMultiSelectOutboundRepId = useStore(
    useCallback((s) => selectLocalMultiSelectOutboundRepresentativeId(s), []),
  );

  const title = data.name?.trim() ? data.name : 'Audio';
  const url = data.url?.trim() ?? '';
  const ar = useMemo(
    () => ({ ...defaultAudioRuntime(), ...(data.audioRuntime ?? {}) }),
    [data.audioRuntime],
  );

  const [nodeHovered, setNodeHovered] = useState(false);
  const [playbackBarVisible, setPlaybackBarVisible] = useState(false);
  /** Collapsible generator dock below the node — reopen after close via chip; resets when selection clears. */
  const [audioGenPanelOpen, setAudioGenPanelOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedCount = nodes.filter((n) => n.selected).length;
  const upstreamItems = useMemo(() => buildUpstreamItems(nodes, edges, id), [nodes, edges, id]);

  const patchAudioRuntime = useCallback(
    (patch: Partial<AudioNodeRuntimeData>) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          const nextAr = { ...defaultAudioRuntime(), ...(prev.audioRuntime ?? {}), ...patch };
          return { ...n, data: { ...prev, audioRuntime: nextAr } };
        }),
      );
    },
    [id, setNodes],
  );

  useEffect(() => {
    setPlaybackBarVisible(false);
  }, [url]);

  useEffect(() => {
    if (!selected) setPlaybackBarVisible(false);
  }, [selected]);

  useEffect(() => {
    if (!selected) setAudioGenPanelOpen(true);
  }, [selected]);

  const handlePlaceholderClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
    },
    [id, setNodes],
  );

  const handlePlaceholderDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const replaceNodeWithFile = useCallback(
    (_nid: string, file: File) => {
      const resourceUrl = URL.createObjectURL(file);
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          const oldUrl = prev.url?.trim();
          if (oldUrl?.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
          return { ...n, data: { ...prev, url: resourceUrl } };
        }),
      );
    },
    [id, setNodes],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      replaceNodeWithFile(id, file);
    },
    [id, replaceNodeWithFile],
  );

  const warnAudioToolPreview = useCallback(
    (toolLabel: string) => {
      message.warning(
        t(
          'project.toolbar.audioMinitoolPreview',
          '{{tool}}: local canvas preview only — connect the full project to run this tool.',
          { tool: toolLabel },
        ),
      );
    },
    [t],
  );

  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);

  const handleRemoveUpstreamItem = useCallback(
    (item: { sourceNodeId: string }) => {
      const edge = edges.find((e) => e.source === item.sourceNodeId && e.target === id);
      if (!edge) return;
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [edges, id, setEdges],
  );

  const canSend =
    (ar.stylesPrompt ?? '').trim().length > 0 || (ar.lyrics ?? '').trim().length > 0;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    message.warning(
      t(
        'project.toolbar.audioSendLocalOnly',
        'Local canvas preview: generation is not dispatched to the worker.',
      ),
    );
  }, [canSend, t]);

  const creditEstimate = 120;

  const showFloatingChrome = selected && selectedCount === 1;

  return (
    <>
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showFloatingChrome}>
        <Toolbar
          nodeId={id}
          onReplace={replaceNodeWithFile}
          onStemSplit={() => warnAudioToolPreview('Stem split')}
          onExtend={() => warnAudioToolPreview('Extend')}
          onNormalize={() => warnAudioToolPreview('Normalize')}
          onDenoise={() => warnAudioToolPreview('Denoise')}
          onEnhance={() => warnAudioToolPreview('Enhance')}
          onSpeed={() => warnAudioToolPreview('Speed')}
          onFadeInOut={() => warnAudioToolPreview('Fade in / out')}
          onSplit={() => warnAudioToolPreview('Split / trim')}
          onTranscription={() => warnAudioToolPreview('Transcription (ASR)')}
          onCompression={() => warnAudioToolPreview('Compression')}
          onEq={() => warnAudioToolPreview('EQ')}
          onPan={() => warnAudioToolPreview('Pan')}
          onReverb={() => warnAudioToolPreview('Reverb')}
          onVoiceEnhancement={() => warnAudioToolPreview('Voice enhancement')}
          onPitchShift={() => warnAudioToolPreview('Pitch shift')}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showFloatingChrome && audioGenPanelOpen}>
        <GenerationBottomToolbar
          panelTitle={t('project.toolbar.audioGenerationPanelTitle', 'Audio generation')}
          upstreamItems={upstreamItems}
          onRemoveUpstreamItem={handleRemoveUpstreamItem}
          onFocusComposer={focusComposer}
          onClose={() => setAudioGenPanelOpen(false)}
          generationMode={(ar.generationMode ?? 'tts') as AudioGenerationMode}
          stylesPrompt={ar.stylesPrompt ?? ''}
          lyrics={ar.lyrics ?? ''}
          instrumental={ar.instrumental ?? false}
          onStylesChange={(v: string) => patchAudioRuntime({ stylesPrompt: v })}
          onLyricsChange={(v: string) => patchAudioRuntime({ lyrics: v })}
          onInstrumentalChange={(v: boolean) => patchAudioRuntime({ instrumental: v })}
          stylesTextAreaRef={composerRef}
          modelLabel={ar.modelLabel ?? defaultAudioRuntime().modelLabel!}
          voiceLabel={ar.voiceLabel ?? defaultAudioRuntime().voiceLabel!}
          languageLabel={ar.languageLabel ?? defaultAudioRuntime().languageLabel!}
          creditEstimate={creditEstimate}
          canSend={canSend}
          onGenerationMode={(mode: AudioGenerationMode) => patchAudioRuntime({ generationMode: mode })}
          onModelLabel={(label: string) => patchAudioRuntime({ modelLabel: label })}
          onVoiceLabel={(label: string) => patchAudioRuntime({ voiceLabel: label })}
          onLanguageLabel={(label: string) => patchAudioRuntime({ languageLabel: label })}
          onSend={handleSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showFloatingChrome && !audioGenPanelOpen}>
        <button
          type='button'
          className='pointer-events-auto flex items-center gap-2 rounded-[8px] border border-[var(--color-border-default-base)] bg-background-default-base px-3 py-2 text-[13px] font-medium text-text-default-base shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)] transition-colors hover:bg-background-default-base-hover'
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setAudioGenPanelOpen(true)}
        >
          <span className='inline-flex rotate-180'>
            <Icon name='base-chevron-down-icon' width={12} height={12} color='var(--color-icon-base)' />
          </span>
          {t('project.toolbar.audioGenerationReopen', 'Audio tools')}
        </button>
      </FlowNodeToolbar>

      <div className='relative w-0 min-w-0' style={{ width: defaultNodeWidth, height: defaultNodeHeight }}>
        <input
          ref={fileInputRef}
          type='file'
          accept='.mp3,.ogg,.wav,.webm'
          className='hidden'
          aria-hidden
          onChange={handleFileChange}
        />
        <div className='absolute left-0 right-0 top-0 min-w-0 -translate-y-full overflow-hidden text-left text-foreground/60'>
          <LocalNodeHeader nodeId={id} nodeType={String(type)} title={title} />
        </div>
        <div
          className={
            'relative flex flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
            (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
          }
          style={{ width: defaultNodeWidth, height: defaultNodeHeight }}
          onMouseEnter={() => setNodeHovered(true)}
          onMouseLeave={() => setNodeHovered(false)}
        >
          <LocalDataNodeHandle
            type='target'
            position={Position.Left}
            handleId={targetHandleId}
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
            handleId={sourceHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={false}
            hideChrome={selected && flowCanvasSelectedCount > 1}
            keepConnectableWhenHidden={
              selected && flowCanvasSelectedCount > 1 && id === localMultiSelectOutboundRepId
            }
          />
          <div className='flex h-full min-h-0 w-full flex-1 overflow-hidden px-3 pb-2 pt-1'>
            {!url ? (
              <div className='flex h-full w-full min-h-0 items-center justify-center overflow-hidden rounded-[8px]'>
                <div
                  className='flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2'
                  onClick={handlePlaceholderClick}
                  onDoubleClick={handlePlaceholderDoubleClick}
                >
                  <Icon name='project-audio-node-placeholder' width={32} height={42} className='text-text-default-tertiary' />
                  <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                    {t('project.toolbar.audioNodePlaceholder')
                      .split('\n')
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                  </div>
                </div>
              </div>
            ) : !showContent ? (
              <LocalNodeSkeleton />
            ) : (
              <div
                className='relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[8px] bg-background-default-base'
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setPlaybackBarVisible((v: boolean) => !v);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <CanvasAudioWaveform key={url} src={url} showControls={playbackBarVisible} />
              </div>
            )}
          </div>
          {data.localOutputPending ? <CanvasOutputPendingProgressOverlay /> : null}
        </div>
      </div>
    </>
  );
};

export default memo(AudioNode);
