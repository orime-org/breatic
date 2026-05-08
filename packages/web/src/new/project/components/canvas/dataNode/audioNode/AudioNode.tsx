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
import CanvasAudio from '../../common/CanvasAudio';
import CanvasAudioWaveform from '../../common/CanvasAudioWaveform';
import type { VideoPlaybackSnapshot, VideoRef } from '../../common/CanvasVideo';
import PlaybackPanel, { type TimelineCutMarker } from '../videoNode/playback/PlaybackPanel';
import { cutAudioWithFfmpeg } from '@/utils/videoEditor/audioCutWithFfmpeg';
import { speedAudioWithFfmpeg } from '@/utils/videoEditor/audioSpeedWithFfmpeg';
import type { VideoExtendDurationSec } from '../videoNode/extend/ExtendBottomToolbar';
import { useLocalAudioFlowActions } from './useLocalAudioFlowActions';
import CutBottomToolbar from '../videoNode/cut/CutBottomToolbar';
import ExtendBottomToolbar from '../videoNode/extend/ExtendBottomToolbar';
import SpeedBottomToolbar from '../videoNode/speed/SpeedBottomToolbar';
import AudioDenoiseBottomToolbar from '../videoNode/audioDenoise/AudioDenoiseBottomToolbar';
import { buildUpstreamItems } from '../generatorNode/upstreamItems';
import Toolbar from './Toolbar';
import GenerationBottomToolbar from './generation/GenerationBottomToolbar';
import AudioNormalizeBottomToolbar from './AudioNormalizeBottomToolbar';
import AudioEnhanceBottomToolbar from './AudioEnhanceBottomToolbar';
import AudioFadeBottomToolbar from './AudioFadeBottomToolbar';
import {
  AudioCompressionBottomToolbar,
  AudioEqBottomToolbar,
  AudioPanBottomToolbar,
  AudioPitchShiftBottomToolbar,
  AudioReverbBottomToolbar,
  AudioTranscriptionBottomToolbar,
  AudioVoiceEnhancementBottomToolbar,
} from './AudioMoreBottomToolbars';

const targetHandleId = 'Audio_0_0';
const sourceHandleId = 'Audio_0_0';

const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

/** Primary + “More” mini-edit flows — hide default playback/generation chrome while active (same idea as {@link VideoNode} `editingMode`). */
type AudioQuickEditMode =
  | 'stem'
  | 'extend'
  | 'normalize'
  | 'denoise'
  | 'enhance'
  | 'speed'
  | 'fade'
  | 'splitTrim'
  | 'transcription'
  | 'compression'
  | 'eq'
  | 'pan'
  | 'reverb'
  | 'voiceEnhancement'
  | 'pitchShift'
  | null;

const defaultAudioRuntime = (): AudioNodeRuntimeData => ({
  generationMode: 'tts',
  stylesPrompt: '',
  lyrics: '',
  instrumental: false,
  modelLabel: 'Minimax Speech 02 hd',
  voiceLabel: '沉稳高管',
  languageLabel: '中文-普通话',
});

const AudioNode: React.FC<NodeProps<Node<LocalCanvasNodeData>>> = ({ id, type, data, selected }) => {
  const { t } = useTranslation();
  const { setNodes, setEdges, getNodes } = useReactFlow();
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
  const nodeFrameRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<VideoRef | null>(null);
  const [playback, setPlayback] = useState<VideoPlaybackSnapshot>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    volume: 1,
  });
  /** Collapsible generator dock below the node — reopen after close via chip; resets when selection clears. */
  const [audioGenPanelOpen, setAudioGenPanelOpen] = useState(true);
  const [audioQuickEditMode, setAudioQuickEditMode] = useState<AudioQuickEditMode>(null);
  const [normalizeAmount, setNormalizeAmount] = useState(70);
  const [denoiseIntensity, setDenoiseIntensity] = useState(50);
  const [isAudioCutSaving, setIsAudioCutSaving] = useState(false);
  const [isAudioSpeedSaving, setIsAudioSpeedSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedCount = nodes.filter((n) => n.selected).length;
  const upstreamItems = useMemo(() => buildUpstreamItems(nodes, edges, id), [nodes, edges, id]);

  const getNodesSnapshot = useCallback(() => getNodes() as Node<LocalCanvasNodeData>[], [getNodes]);

  const {
    removeNode,
    createAudioPlaceholderNodeRight,
    resolveAudioResultNode,
    createCutAudioResultNodesRight,
  } = useLocalAudioFlowActions(getNodesSnapshot, setNodes, setEdges);

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

  const handlePlaybackUpdate = useCallback((snapshot: VideoPlaybackSnapshot) => {
    setPlayback(snapshot);
  }, []);

  useEffect(() => {
    if (!url) {
      setPlayback({ currentTime: 0, duration: 0, isPlaying: false, volume: 1 });
    }
  }, [url]);

  useEffect(() => {
    if (!selected) setAudioGenPanelOpen(true);
  }, [selected]);

  useEffect(() => {
    if (!selected) setAudioQuickEditMode(null);
  }, [selected]);

  useEffect(() => {
    if (!url) setAudioQuickEditMode(null);
  }, [url]);

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

  const warnNeedAudioFirst = useCallback(() => {
    message.warning(t('project.toolbar.audioNeedClipFirst', 'Load an audio file first.'));
  }, [t]);

  const closeAudioQuickEdit = useCallback(() => setAudioQuickEditMode(null), []);

  /**
   * Local canvas: spawn an output audio tile to the right, then fill it with the same URL (no worker yet).
   */
  const spawnAudioOutputCopy = useCallback(
    (nameSuffix: string) => {
      if (!url) return;
      const placeholderId = createAudioPlaceholderNodeRight(id, { nameSuffix, state: 'localPending' });
      if (!placeholderId) return;
      closeAudioQuickEdit();
      window.setTimeout(() => resolveAudioResultNode(placeholderId, url, { state: 'idle' }), 280);
    },
    [closeAudioQuickEdit, createAudioPlaceholderNodeRight, id, resolveAudioResultNode, url],
  );

  const handleAudioCutSave = useCallback(
    async (payload: { cutMarkers: TimelineCutMarker[]; segments: Array<{ start: number; end: number }> }) => {
      if (!url || isAudioCutSaving) return;
      setIsAudioCutSaving(true);
      try {
        const clipSources = await cutAudioWithFfmpeg(url, payload.segments);
        if (clipSources.length === 0) return;
        createCutAudioResultNodesRight(id, payload, clipSources, 200);
        closeAudioQuickEdit();
      } catch {
        message.error(
          t(
            'project.toolbar.audioCutExportFailed',
            'Could not split audio in the browser. Try a smaller file or a different format.',
          ),
        );
      } finally {
        setIsAudioCutSaving(false);
      }
    },
    [closeAudioQuickEdit, createCutAudioResultNodesRight, id, isAudioCutSaving, t, url],
  );

  const handleAudioSpeedSave = useCallback(
    async (payload: { playbackRate: number }) => {
      if (!url || isAudioSpeedSaving) return;
      const placeholderId = createAudioPlaceholderNodeRight(id, { nameSuffix: 'speed', state: 'localPending' });
      if (!placeholderId) return;
      closeAudioQuickEdit();
      setIsAudioSpeedSaving(true);
      try {
        const nextSrc = await speedAudioWithFfmpeg(url, payload.playbackRate);
        if (!nextSrc) {
          removeNode(placeholderId);
          return;
        }
        resolveAudioResultNode(placeholderId, nextSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        message.error(
          t(
            'project.toolbar.audioSpeedExportFailed',
            'Could not change speed in the browser. Try a smaller file.',
          ),
        );
      } finally {
        setIsAudioSpeedSaving(false);
      }
    },
    [
      closeAudioQuickEdit,
      createAudioPlaceholderNodeRight,
      id,
      isAudioSpeedSaving,
      removeNode,
      resolveAudioResultNode,
      t,
      url,
    ],
  );

  const handleExtendSend = useCallback(
    (_payload: { durationSec: VideoExtendDurationSec; prompt: string }) => {
      spawnAudioOutputCopy('extend');
    },
    [spawnAudioOutputCopy],
  );

  const handleNormalizeSend = useCallback(
    (_payload: { amount: number }) => {
      spawnAudioOutputCopy('normalize');
    },
    [spawnAudioOutputCopy],
  );

  const handleDenoiseSend = useCallback(() => {
    spawnAudioOutputCopy('denoise');
  }, [spawnAudioOutputCopy]);

  const handleEnhanceSend = useCallback(() => {
    spawnAudioOutputCopy('enhance');
  }, [spawnAudioOutputCopy]);

  const handleFadeSend = useCallback(() => {
    spawnAudioOutputCopy('fade');
  }, [spawnAudioOutputCopy]);

  const handleTranscriptionSend = useCallback(() => {
    spawnAudioOutputCopy('transcription');
  }, [spawnAudioOutputCopy]);

  const handleCompressionSend = useCallback(() => {
    spawnAudioOutputCopy('compression');
  }, [spawnAudioOutputCopy]);

  const handleEqSend = useCallback(() => {
    spawnAudioOutputCopy('eq');
  }, [spawnAudioOutputCopy]);

  const handlePanSend = useCallback(() => {
    spawnAudioOutputCopy('pan');
  }, [spawnAudioOutputCopy]);

  const handleReverbSend = useCallback(() => {
    spawnAudioOutputCopy('reverb');
  }, [spawnAudioOutputCopy]);

  const handleVoiceEnhancementSend = useCallback(() => {
    spawnAudioOutputCopy('voice');
  }, [spawnAudioOutputCopy]);

  const handlePitchShiftSend = useCallback(() => {
    spawnAudioOutputCopy('pitch');
  }, [spawnAudioOutputCopy]);

  const openStem = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'stem') return;
    setAudioQuickEditMode('stem');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openExtend = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'extend') return;
    setAudioQuickEditMode('extend');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openNormalize = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'normalize') return;
    setAudioQuickEditMode('normalize');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openDenoise = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'denoise') return;
    setAudioQuickEditMode('denoise');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openEnhance = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'enhance') return;
    setAudioQuickEditMode('enhance');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openSpeed = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'speed') return;
    setAudioQuickEditMode('speed');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openFade = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'fade') return;
    setAudioQuickEditMode('fade');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openSplitTrim = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'splitTrim') return;
    setAudioQuickEditMode('splitTrim');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openTranscription = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'transcription') return;
    setAudioQuickEditMode('transcription');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openCompression = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'compression') return;
    setAudioQuickEditMode('compression');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openEq = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'eq') return;
    setAudioQuickEditMode('eq');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openPan = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'pan') return;
    setAudioQuickEditMode('pan');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openReverb = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'reverb') return;
    setAudioQuickEditMode('reverb');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openVoiceEnhancement = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'voiceEnhancement') return;
    setAudioQuickEditMode('voiceEnhancement');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

  const openPitchShift = useCallback(() => {
    if (!url) {
      warnNeedAudioFirst();
      return;
    }
    if (audioQuickEditMode === 'pitchShift') return;
    setAudioQuickEditMode('pitchShift');
  }, [audioQuickEditMode, url, warnNeedAudioFirst]);

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
    if (!canSend || !url) return;
    const suffix =
      (ar.stylesPrompt ?? '').trim().slice(0, 24) ||
      (ar.lyrics ?? '').trim().slice(0, 24) ||
      'generate';
    spawnAudioOutputCopy(suffix);
    message.success(
      t(
        'project.toolbar.audioSendLocalPreviewTile',
        'Added an output audio node to the right (local preview — generation is not dispatched to the worker).',
      ),
    );
  }, [ar.lyrics, ar.stylesPrompt, canSend, spawnAudioOutputCopy, t, url]);

  const creditEstimate = 120;

  const showFloatingChrome = selected && selectedCount === 1;
  const soloChrome = showFloatingChrome;
  const showDefaultBottomChrome = showFloatingChrome && audioQuickEditMode === null;
  const showQuickEditChrome = soloChrome && audioQuickEditMode !== null && Boolean(url);

  return (
    <>
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showFloatingChrome}>
        <Toolbar
          nodeId={id}
          onReplace={replaceNodeWithFile}
          onStemSplit={openStem}
          onExtend={openExtend}
          onNormalize={openNormalize}
          onDenoise={openDenoise}
          onEnhance={openEnhance}
          onSpeed={openSpeed}
          onFadeInOut={openFade}
          onSplit={openSplitTrim}
          onTranscription={openTranscription}
          onCompression={openCompression}
          onEq={openEq}
          onPan={openPan}
          onReverb={openReverb}
          onVoiceEnhancement={openVoiceEnhancement}
          onPitchShift={openPitchShift}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showDefaultBottomChrome}>
        <div className='flex flex-col items-center gap-1' onMouseDown={(e) => e.stopPropagation()}>
          {url ? (
            <PlaybackPanel
              audioOnly
              videoRef={audioRef}
              mediaSrc={url}
              currentTime={playback.currentTime}
              duration={playback.duration}
              isPlaying={playback.isPlaying}
              volume={playback.volume}
              fullscreenTargetRef={nodeFrameRef}
            />
          ) : null}
          {audioGenPanelOpen ? (
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
          ) : (
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
          )}
        </div>
      </FlowNodeToolbar>

      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'stem'}>
        <CutBottomToolbar
          active={audioQuickEditMode === 'stem'}
          variant='stem'
          audioOnly
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSave={handleAudioCutSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'extend'}>
        <ExtendBottomToolbar
          active={audioQuickEditMode === 'extend'}
          audioOnly
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleExtendSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'normalize'}>
        <AudioNormalizeBottomToolbar
          active={audioQuickEditMode === 'normalize'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          amount={normalizeAmount}
          onChange={setNormalizeAmount}
          onClose={closeAudioQuickEdit}
          onSend={handleNormalizeSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'denoise'}>
        <AudioDenoiseBottomToolbar
          active={audioQuickEditMode === 'denoise'}
          audioOnly
          toolbarTitle='Denoise'
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          intensity={denoiseIntensity}
          onChange={setDenoiseIntensity}
          onClose={closeAudioQuickEdit}
          onSend={handleDenoiseSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'enhance'}>
        <AudioEnhanceBottomToolbar
          active={audioQuickEditMode === 'enhance'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleEnhanceSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'speed'}>
        <SpeedBottomToolbar
          active={audioQuickEditMode === 'speed'}
          audioOnly
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSave={handleAudioSpeedSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'fade'}>
        <AudioFadeBottomToolbar
          active={audioQuickEditMode === 'fade'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleFadeSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'splitTrim'}>
        <CutBottomToolbar
          active={audioQuickEditMode === 'splitTrim'}
          variant='split'
          audioOnly
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSave={handleAudioCutSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'transcription'}>
        <AudioTranscriptionBottomToolbar
          active={audioQuickEditMode === 'transcription'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleTranscriptionSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'compression'}>
        <AudioCompressionBottomToolbar
          active={audioQuickEditMode === 'compression'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleCompressionSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'eq'}>
        <AudioEqBottomToolbar
          active={audioQuickEditMode === 'eq'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleEqSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'pan'}>
        <AudioPanBottomToolbar
          active={audioQuickEditMode === 'pan'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handlePanSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'reverb'}>
        <AudioReverbBottomToolbar
          active={audioQuickEditMode === 'reverb'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleReverbSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'voiceEnhancement'}>
        <AudioVoiceEnhancementBottomToolbar
          active={audioQuickEditMode === 'voiceEnhancement'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handleVoiceEnhancementSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showQuickEditChrome && audioQuickEditMode === 'pitchShift'}>
        <AudioPitchShiftBottomToolbar
          active={audioQuickEditMode === 'pitchShift'}
          videoRef={audioRef}
          mediaSrc={url}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={closeAudioQuickEdit}
          onSend={handlePitchShiftSend}
        />
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
          ref={nodeFrameRef}
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
                onMouseDown={(e) => e.stopPropagation()}
              >
                <CanvasAudio ref={audioRef} src={url} onPlaybackUpdate={handlePlaybackUpdate} />
                <CanvasAudioWaveform key={url} src={url} showControls={false} />
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
