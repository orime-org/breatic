/**
 * Audio input node (AudioNode)
 * - Supports audio upload, audio URL input, and recording
 * - Shows NodeToolbar on selection
 * - Uses WaveSurfer + RecordPlugin for recording and waveform
 */
import React, { useState, useEffect, memo, useRef } from 'react';
import { type NodeProps, Position, NodeToolbar as FlowNodeToolbar, useStore } from '@xyflow/react';
import { Upload } from '@/components/base/upload';
import { message } from '@/components/base/message';
import { useTranslation } from 'react-i18next';
import NodeHeader from '../../common/NodeHeader';
import { Icon } from '@/components/base/icon';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import {
  shouldHideNodeChatComposerForChatRecordCanvasPick,
  type CanvasWorkflowNodeData,
} from '@/apps/project/components/canvas/types';
import { Modal } from '@/components/modals/Modal';
import { Input } from '@/components/base/input';
import WaveSurfer from 'wavesurfer.js';
// @ts-expect-error - RecordPlugin typing issue; use ESM import directly.
import RecordPlugin from 'wavesurfer.js/dist/plugins/record.esm.js';
import AudioNodeToolbar from './NodeToolbar';
import DataNodeHandle from '../../common/DataNodeHandle';
import NodeSkeleton, { zoomLevelShowContentSelector } from '../../common/NodeSkeleton';
import AudioNodePlayer from './AudioNodePlayer';
import NodeChatComposer from '@/apps/project/components/agent/NodeChatComposer';

/** Edge handle IDs aligned with canvas conventions. */
const targetHandleId = 'Audio_0_0';
const sourceHandleId = 'Audio_0_0';

type AudioNodeData = Partial<CanvasWorkflowNodeData>;

/** Maximum recording duration (ms). */
const maxRecordingTime = 60000;

/** Format seconds as mm:ss. */
const formatTime = (seconds: number): string => {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const AudioNode: React.FC<NodeProps> = ({ id, selected, dragging }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const { updateNode, onNodesChange } = useCanvasActions();
  const {
    openRightPanel,
    requestAddResourceToInput,
    openCanvasOverlayPanel,
    closeCanvasOverlayPanel,
    canvasOverlayPanel,
  } = useCanvasUI();
  const showContent = useStore(zoomLevelShowContentSelector);
  const [nodeHovered, setNodeHovered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [showRecordView, setShowRecordView] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const recordPluginRef = useRef<RecordPlugin | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  /** Auto-focus URL input after modal opens (wait for transition mount). */
  useEffect(() => {
    if (!modalVisible) return;
    const timerId = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
    return () => window.clearTimeout(timerId);
  }, [modalVisible]);

  // ---------- Derived from node data: current audio URL and pending file ----------
  const currentNode = nodes.find((n: { id: string }) => n.id === id);
  const nodeData = currentNode?.data as AudioNodeData | undefined;
  const wf = nodeData as Partial<CanvasWorkflowNodeData> | undefined;
  const audioUrlFromData = typeof wf?.content === 'string' ? wf.content : '';
  const [audioUrl, setAudioUrl] = useState(audioUrlFromData);

  /** Sync local audio URL when store content changes. */
  useEffect(() => {
    if (audioUrlFromData !== audioUrl) {
      setAudioUrl(audioUrlFromData);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrlFromData]);

  /** Local file: object URL only (no OSS / workflow APIs). */
  const customRequest = async (options: {
    file: File;
    onSuccess: (response: unknown) => void;
    onError: (error: Error) => void;
  }) => {
    const { file, onSuccess, onError } = options;
    setIsLoading(true);
    try {
      const resourceUrl = URL.createObjectURL(file);
      const current = nodes.find((n: { id: string }) => n.id === id);
      const currentData = (current?.data as Record<string, unknown>) || {};
      const { pendingFileId: _pf, nodeSelectedResultData: _legacy, ...restData } = currentData;
      void _pf;
      void _legacy;
      updateNode(id, {
        data: {
          ...restData,
          name: typeof restData.name === 'string' && restData.name ? restData.name : 'audio',
          content: resourceUrl,
          state: 'idle',
          runType: 'parameter',
        },
      });
      setIsLoading(false);
      onSuccess(resourceUrl);
    } catch (error) {
      console.error('Upload failed:', error);
      message.warning('Audio upload failed');
      setIsLoading(false);
      onError(error as Error);
    }
  };

  // TODO: replaced by presigned URL upload hook

  /** Stop recording; upload is triggered by RecordPlugin record-end. */
  const handleStopRecording = () => {
    if (!recordPluginRef.current) return;
    recordPluginRef.current.stopRecording();
  };

  /** Record view: create/destroy WaveSurfer + RecordPlugin and handle upload on finish. */
  useEffect(() => {
    if (!waveformRef.current || !showRecordView) {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
        recordPluginRef.current = null;
      }
      return;
    }
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
      recordPluginRef.current = null;
    }

    const wavesurfer = WaveSurfer.create({
      container: waveformRef.current,
      /* Waveform styles */
      waveColor: '#B3B3B3',
      progressColor: '#262626',
      cursorColor: '#EC221F',
      cursorWidth: 2,
      barWidth: 2,
      barRadius: 0,
      barGap: 2,
      height: 40,
      normalize: true,
      backend: 'WebAudio',
      mediaControls: false,
      interact: false,
    });

    const recordPlugin = RecordPlugin.create({
      mimeType: 'audio/webm',
      /* Recording params and realtime waveform */
      audioBitsPerSecond: 128000,
      lineWidth: 2,
      realtimeWaveColor: '#262626',
      renderRecordedAudio: false,
      scrollingWaveform: false,
      continuousWaveform: true,
      continuousWaveformDuration: 60,
    });
    wavesurfer.registerPlugin(recordPlugin);

    /** Subscribe to recording lifecycle; upload webm and write back on record-end. */
    const subscriptions = [
      recordPlugin.on('record-start', () => {
        setIsRecording(true);
        setRecordingTime(0);
      }),
      recordPlugin.on('record-progress', (time: number) => {
        const timeInSeconds = Math.floor(time / 1000);
        setRecordingTime(timeInSeconds);
        if (time >= maxRecordingTime) {
          recordPlugin.stopRecording();
        }
      }),
      recordPlugin.on('record-end', async (blob: Blob) => {
        setIsRecording(false);
        setRecordingTime(0);
        setIsLoading(true);
        try {
          const resourceUrl = URL.createObjectURL(blob);
          const current = nodes.find((n: { id: string }) => n.id === id);
          const currentData = (current?.data as Record<string, unknown>) || {};
          const { pendingFileId: _pf, nodeSelectedResultData: _legacy, ...restData } = currentData;
          void _pf;
          void _legacy;
          updateNode(id, {
            data: {
              ...restData,
              name: typeof restData.name === 'string' && restData.name ? restData.name : 'audio',
              content: resourceUrl,
              state: 'idle',
              runType: 'parameter',
            },
          });
          setShowRecordView(false);
          setIsLoading(false);
        } catch (error) {
          console.error('Recording upload failed:', error);
          message.warning('Recording upload failed');
          setIsLoading(false);
        }
      }),
      recordPlugin.on('record-pause', () => setIsRecording(false)),
      recordPlugin.on('record-resume', () => setIsRecording(true)),
    ];

    wavesurferRef.current = wavesurfer;
    recordPluginRef.current = recordPlugin;
    return () => {
      subscriptions.forEach((unsub) => unsub());
      if (wavesurfer) wavesurfer.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRecordView]);

  /** Cleanup WaveSurfer instance on unmount. */
  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    return () => {
      if (wavesurfer) wavesurfer.destroy();
    };
  }, []);

  /** Validate URL format and supported audio extensions (.mp3/.ogg/.wav/.webm). */
  const validateAudioUrl = (url: string): boolean => {
    if (!url.trim()) return false;
    try {
      new URL(url);
    } catch {
      return false;
    }
    const urlLower = url.toLowerCase();
    return ['.mp3', '.ogg', '.wav', '.webm'].some((ext) => urlLower.includes(ext));
  };

  /** Confirm URL: validate -> store URL directly (no proxy API). */
  const handleUrlConfirm = async () => {
    const trimmedUrl = urlValue.trim();
    if (!trimmedUrl) return;
    if (!validateAudioUrl(trimmedUrl)) {
      message.warning(t('project.toolbar.uploadFailedUrlIncorrect'));
      setUrlValue('');
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    setModalVisible(false);
    setUrlValue('');
    setIsLoading(true);
    try {
      const cur = (nodes.find((n: { id: string }) => n.id === id)?.data as Record<string, unknown>) || {};
      const { nodeSelectedResultData: _legacy, ...rest } = cur;
      void _legacy;
      updateNode(id, {
        data: {
          ...rest,
          name: typeof rest.name === 'string' && rest.name ? rest.name : 'audio',
          content: trimmedUrl,
          state: 'idle',
          runType: 'parameter',
        },
      });
      setIsLoading(false);
    } catch (error) {
      console.error('Failed to set URL:', error);
      message.warning('Audio upload failed');
      setIsLoading(false);
    }
  };

  /** Request microphone permission and start recording (requires ready recordPluginRef). */
  const handleStartRecording = async () => {
    if (!recordPluginRef.current) {
      message.warning(t('project.toolbar.recordingNotReady'));
      return;
    }
    try {
      setIsRecording(true);
      setRecordingTime(0);
      await recordPluginRef.current.startRecording();
    } catch (error) {
      console.error('Failed to start recording:', error);
      message.warning(t('project.toolbar.cannotAccessMicrophone'));
      setIsRecording(false);
      setRecordingTime(0);
    }
  };

  const selectedCount = nodes.filter((n: { selected?: boolean }) => n.selected).length;
  const parentNode = currentNode?.parentId ? nodes.find((n) => n.id === currentNode.parentId) : null;
  const isInsideLockedGroup =
    parentNode?.type === 'group' && (parentNode.data as { locked?: boolean })?.locked === true;
  const showToolbar = selected && selectedCount === 1 && !dragging && !isInsideLockedGroup;
  const showBottomNodeChatComposer = showToolbar && !shouldHideNodeChatComposerForChatRecordCanvasPick(wf);

  /** Open right chat panel as audio editor (resource list + resizable editor area). */
  /** Toolbar Upload: trigger hidden file input. */
  const handleToolbarUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleToolbarInfoClick = () => {
    const isCurrentNodePanelOpen = canvasOverlayPanel.open && canvasOverlayPanel.nodeId === id;
    if (isCurrentNodePanelOpen) {
      closeCanvasOverlayPanel();
      return;
    }
    openCanvasOverlayPanel(id);
  };

  /** Hidden file input change handler uses customRequest. */
  const handleToolbarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    customRequest({
      file,
      onSuccess: () => {},
      onError: () => {},
    });
  };

  /** Placeholder click: stop propagation and select current node. */
  const handlePlaceholderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNodesChange(nodes.map((n: { id: string }) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
  };

  const handleChatInputSend = (content: string, imageUrls?: string[]) => {
    // eslint-disable-next-line no-console
    console.log('AudioNode ChatInput send:', { nodeId: id, content, imageUrls });
    // TODO: Wire to the ChatMessage list bound to this node.
  };

  return (
    <>
      <input
        ref={uploadInputRef}
        type='file'
        accept='.mp3,.ogg,.wav,.webm'
        className='hidden'
        aria-hidden
        onChange={handleToolbarFileChange}
      />
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showToolbar}>
        <div className='rounded-[8px] pointer-events-auto' onMouseDown={(e) => e.stopPropagation()}>
          <AudioNodeToolbar
            nodeId={id}
            isUploading={isLoading}
            showRecordView={showRecordView}
            onRecordToggle={() => setShowRecordView(!showRecordView)}
            onUploadClick={handleToolbarUploadClick}
            onInfoClick={handleToolbarInfoClick}
          />
        </div>
      </FlowNodeToolbar>
      <div className='relative'>
        <div className='absolute -translate-y-full text-left left-0 -top-0 text-foreground/60 overflow-hidden text-ellipsis whitespace-nowrap'>
          <NodeHeader nodeId={id} title={t('project.panel.audios')} editable={true} />
        </div>
        <div
          className={
            'relative flex w-[300px] h-[250px] flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
            (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
          }
          onMouseEnter={() => setNodeHovered(true)}
          onMouseLeave={() => setNodeHovered(false)}
        >
          <DataNodeHandle
            type='target'
            position={Position.Left}
            handleId={targetHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={isInsideLockedGroup}
          />
          <DataNodeHandle
            type='source'
            position={Position.Right}
            handleId={sourceHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={isInsideLockedGroup}
          />
          <div className='flex-1'>
            {!showContent ? (
              <NodeSkeleton />
            ) : isLoading ? (
              <div className='w-full flex-1 h-full flex flex-col items-center justify-center text-center'>
                <Icon name='base-loading-spinner' width={32} height={32} className='animate-spin' />
                <div className='text-[12px] text-text-default-tertiary font-normal mt-2'>
                  {t('project.toolbar.loadingAudio')}
                </div>
              </div>
            ) : (
              <div className='w-full flex-1 h-full flex items-center justify-center overflow-hidden'>
                {showRecordView ? (
                  <div className='w-full h-full flex flex-col items-center justify-center text-center px-4 relative overflow-hidden'>
                    {!isRecording ? (
                      <>
                        <div
                          className='cursor-pointer'
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartRecording();
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <Icon name='project-microphone-icon' width={56} height={56} color='#B3B3B3' />
                        </div>
                        <div className='text-[14px] font-semibold text-text-default-secondary mb-[24px] mt-[10px]'>
                          {t('project.toolbar.clickToStartRecord')}
                        </div>
                        <div className='text-[11px] text-text-default-tertiary'>
                          {t('project.toolbar.clickStopButtonToFinish')}
                        </div>
                      </>
                    ) : (
                      <>
                        <div
                          className='cursor-pointer flex items-center justify-center mb-2'
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStopRecording();
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <Icon name='project-stop-record-icon' width={47} height={47} />
                        </div>
                        <div className='text-[14px] font-semibold text-text-default-secondary'>
                          {formatTime(recordingTime)}
                        </div>
                      </>
                    )}
                    <div
                      ref={waveformRef}
                      className={`w-[200px] h-[40px] ${!isRecording ? 'opacity-0 pointer-events-none absolute' : 'mb-2'}`}
                      style={{ overflowX: 'hidden', overflowY: 'visible' }}
                      onMouseDown={(e) => e.stopPropagation()}
                    />
                  </div>
                ) : audioUrl ? (
                  <div className='w-full h-full'>
                    <AudioNodePlayer
                      src={audioUrl}
                      selected={selected}
                      onMentionClick={(e) => {
                        e.stopPropagation();
                        if (audioUrl) {
                          const nameFromUrl = audioUrl.split('/').pop()?.split('?')[0] || 'audio';
                          requestAddResourceToInput({ url: audioUrl, name: nameFromUrl, type: 'audio' });
                        }
                        openRightPanel('editor', id, undefined, true);
                      }}
                    />
                  </div>
                ) : (
                  <Upload
                    customRequest={customRequest}
                    showUploadList={false}
                    accept='.mp3,.ogg,.wav,.webm'
                    className='w-full h-full'
                  >
                    <div
                      className='w-full h-full flex flex-col items-center justify-center cursor-pointer gap-2 h-full'
                      onClick={handlePlaceholderClick}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        uploadInputRef.current?.click();
                      }}
                    >
                      <Icon
                        name='project-audio-node-placeholder'
                        width={32}
                        height={42}
                        className='text-text-default-tertiary'
                      />
                      <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                        {t('project.toolbar.audioNodePlaceholder')
                          .split('\n')
                          .map((line, i) => (
                            <div key={i}>{line}</div>
                          ))}
                      </div>
                    </div>
                  </Upload>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Bottom FlowNodeToolbar: show a floating ChatInput below when selected. */}
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={20} isVisible={showBottomNodeChatComposer}>
        <NodeChatComposer
          className='w-[526px] min-h-[160px] pointer-events-auto rounded-[16px]'
          onSend={handleChatInputSend}
          targetNodeId={id}
        />
      </FlowNodeToolbar>
      <Modal
        open={modalVisible}
        title={null}
        closable={false}
        width={472}
        onConfirm={handleUrlConfirm}
        onCancel={() => {
          setModalVisible(false);
          setUrlValue('');
        }}
        confirmDisabled={!urlValue.trim() || isLoading}
      >
        <div className='flex flex-col items-center gap-6'>
          <div className='flex flex-col items-start gap-0 w-full'>
            <div className='text-[14px] text-[#0C0C0D] text-left font-bold'>
              {t('project.toolbar.audioFormatsSupported')}
            </div>
            <div className='text-[14px] text-[#0C0C0D] text-left font-bold'>
              {t('project.toolbar.audioFormatsMustBe')}
            </div>
          </div>
          <div className='w-[428px] px-6 py-1.5 bg-[#F5F5F5] rounded-full inline-flex items-center'>
            <Input
              ref={inputRef}
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              placeholder={t('project.toolbar.pleaseInputUrl')}
              maxLength={128}
              className='flex w-full h-[24px] bg-[#F5F5F5] text-[#0C0C0D] !border-0 !outline-0'
            />
          </div>
        </div>
      </Modal>
    </>
  );
};

export default memo(AudioNode);
