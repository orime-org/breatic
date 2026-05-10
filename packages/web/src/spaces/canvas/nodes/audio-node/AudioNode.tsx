/**
 * Audio input node (AudioNode)
 *
 * Asset content lands in `data.content` via either:
 *   - Left menu upload (F5 — `useUploadFiles` → permanent S3/OSS URL)
 *   - In-node Record Audio (F5 — wavesurfer captured blob → uploadOne
 *     → permanent URL written via setNodeContent)
 *   - Mini-tool sibling / generative downstream (Worker writes)
 *
 * Per-node `customRequest` upload + Upload component + hidden file
 * input were removed in F5.
 */
import React, { useState, useEffect, memo, useRef } from 'react';
import { type NodeProps, Position, NodeToolbar as FlowNodeToolbar, useStore } from '@xyflow/react';
import { message } from '@/ui/message';
import { useTranslation } from 'react-i18next';
import NodeHeader from '../../common/NodeHeader';
import { Icon } from '@/ui/icon';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/contexts/CanvasUIContext';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import { uploadOne } from '@/features/upload';
import { Modal } from '@/app/shell/modals/Modal';
import { Input } from '@/ui/input';
import WaveSurfer from 'wavesurfer.js';
import RecordPlugin from 'wavesurfer.js/dist/plugins/record.esm.js';
import AudioNodeToolbar from './NodeToolbar';
import DataNodeHandle from '../../common/DataNodeHandle';
import NodeSkeleton, { zoomLevelShowContentSelector } from '../../common/NodeSkeleton';
import AudioNodePlayer from './AudioNodePlayer';

/** Edge handle IDs aligned with canvas conventions. */
const targetHandleId = 'Audio_0_0';
const sourceHandleId = 'Audio_0_0';

type AudioNodeData = { name?: string; content?: string; duration?: number; state?: string; errorMessage?: string };

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
  const { setNodeContent, onNodesChange } = useCanvasActions();
  const { openRightPanel } = useProjectLayout();
  const { openCanvasOverlayPanel, closeCanvasOverlayPanel, canvasOverlayPanel } = useCanvasUI();
  const activeMgr = useActiveCanvasSpace();
  const showContent = useStore(zoomLevelShowContentSelector);
  const [nodeHovered, setNodeHovered] = useState(false);
  /** True while the in-node recording is being uploaded to permanent storage. */
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

  /** Auto-focus URL input after modal opens (wait for transition mount). */
  useEffect(() => {
    if (!modalVisible) return;
    const timerId = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
    return () => window.clearTimeout(timerId);
  }, [modalVisible]);

  // ---------- Derived from node data: current audio URL from data.content (canvas-native schema) ----------
  const currentNode = nodes.find((n: { id: string }) => n.id === id);
  const nodeData = currentNode?.data as AudioNodeData | undefined;
  /** Direct read of data.content — no history indirection in canvas-native schema. */
  const audioUrlFromData = nodeData?.content ?? '';
  const isHandling = nodeData?.state === 'handling';
  const errorMessage = nodeData?.errorMessage;
  const [audioUrl, setAudioUrl] = useState(audioUrlFromData);

  /** Sync local audio URL when data.content changes. */
  useEffect(() => {
    if (audioUrlFromData !== audioUrl) {
      setAudioUrl(audioUrlFromData);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrlFromData]);

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
      waveColor: 'var(--color-text-disabled-base)',
      progressColor: '#262626',
      cursorColor: 'var(--color-text-status-error)',
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
      // Record-time waveform appearance is inherited from the
      // WaveSurfer instance above (waveColor / barWidth / progressColor
      // / …). Wavesurfer v7's RecordPlugin no longer has its own
      // waveform renderer — the v6-era `lineWidth` and
      // `realtimeWaveColor` options were removed from
      // `RecordPluginOptions` and are silently dropped at runtime.
      audioBitsPerSecond: 128000,
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
          if (!activeMgr) {
            throw new Error('canvas space not ready');
          }
          // Wrap as a File so `uploadOne` can extract a filename for
          // the server's content-disposition + key derivation. The
          // mimeType matches what RecordPlugin's MediaRecorder uses.
          const filename = `recording-${Date.now()}.webm`;
          const file = new File([blob], filename, {
            type: blob.type || 'audio/webm',
          });
          const result = await uploadOne(file, { projectId: activeMgr.projectId });
          setNodeContent(id, {
            content: result.fileUrl,
            ...(result.duration !== undefined ? { duration: result.duration } : {}),
          });
          setShowRecordView(false);
        } catch (error) {
          console.error('Recording upload failed:', error);
          message.warning(t('canvas.node.audio.recordingUploadFailed', 'Recording upload failed'));
        } finally {
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
      setNodeContent(id, { content: trimmedUrl });
      setIsLoading(false);
    } catch (error) {
      console.error('Failed to set URL:', error);
      message.warning(t('canvas.node.audio.uploadFailed', 'Audio upload failed'));
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

  const handleToolbarInfoClick = () => {
    const isCurrentNodePanelOpen = canvasOverlayPanel.open && canvasOverlayPanel.nodeId === id;
    if (isCurrentNodePanelOpen) {
      closeCanvasOverlayPanel();
      return;
    }
    openCanvasOverlayPanel(id);
  };

  /** Placeholder click: stop propagation and select current node. */
  const handlePlaceholderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNodesChange(nodes.map((n: { id: string }) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
  };

  return (
    <>
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showToolbar}>
        <div className='rounded-[8px] pointer-events-auto' onMouseDown={(e) => e.stopPropagation()}>
          <AudioNodeToolbar
            nodeId={id}
            showRecordView={showRecordView}
            onRecordToggle={() => setShowRecordView(!showRecordView)}
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
                          <Icon name='project-microphone-icon' width={56} height={56} color='var(--color-text-disabled-base)' />
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
                  <div className='relative w-full h-full'>
                    {/* Handling overlay */}
                    {isHandling && (
                      <div className='absolute inset-0 z-[10] flex flex-col items-center justify-center rounded-[8px] bg-black/40 pointer-events-none'>
                        <Icon name='base-loading-spinner' width={28} height={28} className='animate-spin text-white' />
                        <div className='text-[12px] text-white font-normal mt-2'>{t('canvas.node.processing', 'Processing...')}</div>
                      </div>
                    )}
                    {errorMessage && !isHandling && (
                      <div className='absolute top-1 right-1 z-[10] max-w-[80%] rounded px-1.5 py-0.5 text-[10px] font-medium text-white bg-red-500 leading-tight truncate' title={errorMessage}>
                        {errorMessage}
                      </div>
                    )}
                    <AudioNodePlayer
                      src={audioUrl}
                      selected={selected}
                      onMentionClick={(e) => {
                        e.stopPropagation();
                        openRightPanel('editor', id);
                      }}
                    />
                  </div>
                ) : isHandling ? (
                  <div className='w-full h-full flex flex-col items-center justify-center text-center'>
                    <Icon name='base-loading-spinner' width={32} height={32} className='animate-spin' />
                    <div className='text-[12px] text-text-default-tertiary font-normal mt-2'>{t('canvas.node.processing', 'Processing...')}</div>
                  </div>
                ) : (
                  <div
                    className='w-full h-full flex flex-col items-center justify-center cursor-default gap-2'
                    onClick={handlePlaceholderClick}
                  >
                    <Icon
                      name='project-audio-node-placeholder'
                      width={32}
                      height={42}
                      className='text-text-default-tertiary'
                    />
                    <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                      {t('canvas.node.audio.emptyHint', '点左侧菜单"上传"或工具栏"录音"')}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
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
