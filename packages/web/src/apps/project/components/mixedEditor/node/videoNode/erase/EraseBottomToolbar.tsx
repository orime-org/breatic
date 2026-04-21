import React, { memo, useCallback, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import Tooltip from '@/components/base/tooltip';
import { useMixedEditorStore } from '@/hooks/useMixedEditorStore';
import type { ImageEditorPickState, ImageFlowNodeData } from '../../../types';
import PlaybackPanel from '../playback/PlaybackPanel';
import EraseTrackingPanel, { type EraseTrackingPhase, type EraseTrackingSegment } from './EraseTrackingPanel';

export type VideoEraseMaskTool = 'selection' | 'rectangle' | 'circle';

export type EraseBottomToolbarProps = {
  /** Mixed-editor video node id — used to enter canvas pick mode (Selection tool). */
  nodeId: string;
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  /** When omitted, panel uses `idle` (default hint). Pass `tracking` while a track job runs. */
  trackingPhase?: EraseTrackingPhase;
  trackingSegments?: EraseTrackingSegment[];
  /** Active erase tool, controlled by parent. */
  maskTool: VideoEraseMaskTool;
  onMaskToolChange: (tool: VideoEraseMaskTool) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onClose: () => void;
  onSend?: (payload: { maskTool: VideoEraseMaskTool }) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const eraseLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';
const iconBtnDisabledClass = 'cursor-not-allowed text-icon-disabled hover:bg-transparent opacity-50';
const getHistoryBtnClass = (enabled: boolean) => `${iconBtnClass} ${enabled ? '' : iconBtnDisabledClass}`;

const ERASE_CREDIT = 120;

const EraseBottomToolbar: React.FC<EraseBottomToolbarProps> = ({
  nodeId,
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  trackingPhase = 'idle',
  trackingSegments = [],
  maskTool,
  onMaskToolChange,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onClose,
  onSend,
}) => {
  const { updateNode, onNodesChange, nodes } = useMixedEditorStore();
  const [timelineZoom, setTimelineZoom] = useState(50);

  /** Enter video erase pick mode (selection/circle/rectangle all share the same pick context). */
  const enterVideoErasePickMode = useCallback((tool: VideoEraseMaskTool) => {
    for (const n of nodes) {
      const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
      if (ps?.fromCanvas && n.id !== nodeId) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
    onNodesChange(
      nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === nodeId })),
      { history: 'skip' },
    );
    updateNode(
      nodeId,
      {
        selected: true,
        data: {
          pickState: {
            fromCanvas: true,
            composerFocused: true,
            pendingList: null,
            consumeFrom: 'videoErase',
            eraseMaskTool: tool,
          } satisfies ImageEditorPickState,
        },
      },
      { history: 'skip' },
    );
  }, [nodeId, nodes, onNodesChange, updateNode]);

  const handleSend = useCallback(() => {
    onSend?.({ maskTool });
  }, [maskTool, onSend]);

  const handleMaskToolSelect = useCallback((tool: VideoEraseMaskTool) => {
    videoRef.current?.pause();
    onMaskToolChange(tool);
    enterVideoErasePickMode(tool);
  }, [enterVideoErasePickMode, onMaskToolChange, videoRef]);

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div className='flex flex-col items-center gap-1'>
        <PlaybackPanel
          videoRef={videoRef}
          mediaSrc={mediaSrc}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          volume={volume}
          fullscreenTargetRef={fullscreenTargetRef}
          timelineZoom={timelineZoom}
          onTimelineZoomChange={setTimelineZoom}
        />
        <EraseTrackingPanel
          phase={trackingPhase}
          mediaSrc={mediaSrc}
          currentTimeSec={currentTime}
          durationSec={duration}
          segments={trackingSegments}
          timelineZoom={timelineZoom}
        />
        <div
          className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className={eraseLabelClass}>
            <Icon name='videoNode-erase' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Erase</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Tooltip title='Selection' placement='top' offset={4}>
            <button
              type='button'
              className={iconBtnClass}
              aria-label='Selection tool'
              onClick={() => handleMaskToolSelect('selection')}
            >
              <Icon name='videoNode-erase-selection' width={20} height={20} color='var(--color-icon-base)' />
            </button>
          </Tooltip>
          <Tooltip title='Circle' placement='top' offset={4}>
            <button
              type='button'
              className={iconBtnClass}
              aria-label='Circle mask'
              onClick={() => handleMaskToolSelect('circle')}
            >
              <Icon name='imageEditor-flow-inpaint-circle-icon' width={20} height={20} />
            </button>
          </Tooltip>
          <Tooltip title='Rectangle' placement='top' offset={4}>
            <button
              type='button'
              className={iconBtnClass}
              aria-label='Rectangle mask'
              onClick={() => handleMaskToolSelect('rectangle')}
            >
              <Icon name='imageEditor-flow-inpaint-rectangle-icon' width={20} height={20} />
            </button>
          </Tooltip>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Tooltip title='Undo' placement='top' offset={4}>
            <button
              type='button'
              className={getHistoryBtnClass(canUndo)}
              aria-label='Undo erase'
              disabled={!canUndo}
              onClick={onUndo}
            >
              <Icon name='imageEditor-flow-inpaint-undo-icon' width={20} height={20} />
            </button>
          </Tooltip>
          <Tooltip title='Redo' placement='top' offset={4}>
            <button
              type='button'
              className={getHistoryBtnClass(canRedo)}
              aria-label='Redo erase'
              disabled={!canRedo}
              onClick={onRedo}
            >
              <Icon name='imageEditor-flow-inpaint-redo-icon' width={20} height={20} />
            </button>
          </Tooltip>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{ERASE_CREDIT}</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            aria-label='Send erase'
            onClick={handleSend}
          />
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button type='button' className={iconBtnClass} aria-label='Close erase mode' onClick={onClose}>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(EraseBottomToolbar);
export type { EraseTrackingPhase } from './EraseTrackingPanel';
