import React, { memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { message } from '@/components/base/message';
import Slider from '@/components/base/slider';
import Tooltip from '@/components/base/tooltip';
import { useTranslation } from 'react-i18next';
import type { TimelineClip } from '../../types';
import { Icon } from '@/components/base/icon';

interface PlaybackControlsProps {
  nodeId?: string;
  currentTime: number;
  isPlaying: boolean;
  scale: number;
  onTimeChange: (time: number) => void;
  onPlayPause: () => void;
  onScaleChange: (scale: number) => void;
  onFullscreen: () => void;
  onReset: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const sliderClass = 'nodrag nopan !w-full';

/**
 * PlaybackControls 组件 - 播放控制栏
 *
 */
const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  nodeId,
  currentTime,
  isPlaying,
  scale,
  onTimeChange,
  onPlayPause,
  onScaleChange,
  onFullscreen,
  onReset,
  undo,
  redo,
  canUndo,
  canRedo,
}) => {
  const { t } = useTranslation();

  // 使用 useVideoEditorStore hook
  const {
    clips,
    mediaItems,
    selectedClipId,
    setClips,
    batchUpdateClips,
    setSelectedClipId,
  } = useVideoEditorStore(nodeId);

  // 计算实际时长
  const actualDuration = clips.length === 0 ? 0 : Math.max(...clips.map((c: TimelineClip) => c.end));

  // 组件内部的方法
  const handleTimeChange = (time: number) => {
    onTimeChange(time);
  };

  const handlePlayPause = () => {
    const playheadWidthTime = 2 / (scale * 50);
    const maxPlayheadTime = actualDuration - playheadWidthTime;

    // 如果播放已结束或到达末尾，从头开始播放
    if ((currentTime >= maxPlayheadTime - 0.1 || currentTime >= actualDuration - 0.1) && !isPlaying) {
      onTimeChange(0);
    }
    onPlayPause();
  };

  const handleScaleChange = (newScale: number) => {
    onScaleChange(newScale);
  };

  const handleFullscreen = () => {
    onFullscreen();
  };

  // 组件内部的片段操作方法
  const handleClipSplit = () => {
    if (selectedClipId.length === 0) return;

    const clipToSplit = clips.find((c: TimelineClip) => c.id === selectedClipId[0]);
    if (!clipToSplit) return;

    if (currentTime <= clipToSplit.start || currentTime >= clipToSplit.end) {
      message.warning('请将播放头移动到片段内部以进行分割');
      return;
    }

    const media = mediaItems.find((m: { id: string; duration?: number }) => m.id === clipToSplit.mediaId);
    const mediaDuration = media?.duration || 0;

    const oldTrimStart = clipToSplit.trimStart || 0;
    const oldTrimEnd = clipToSplit.trimEnd || mediaDuration;

    const timelineOffset = currentTime - clipToSplit.start;
    const splitVideoTime = oldTrimStart + timelineOffset;

    const clip1: TimelineClip = {
      ...clipToSplit,
      id: `clip-${Date.now()}-${Math.random()}-1`,
      end: currentTime,
      trimStart: oldTrimStart,
      trimEnd: splitVideoTime,
    };

    const clip2: TimelineClip = {
      ...clipToSplit,
      id: `clip-${Date.now()}-${Math.random()}-2`,
      start: currentTime,
      trimStart: splitVideoTime,
      trimEnd: oldTrimEnd,
    };

    const newClips = clips.filter((c: TimelineClip) => c.id !== selectedClipId[0]).concat([clip1, clip2]);
    setClips(newClips);
    setSelectedClipId([clip2.id]);
    message.success('片段已分割');
  };

  const handleCopyClip = () => {
    if (selectedClipId.length === 0) return;

    // 获取所有要复制的 clips
    const clipsToCopy = selectedClipId
      .map((id) => clips.find((c: TimelineClip) => c.id === id))
      .filter(Boolean) as TimelineClip[];

    if (clipsToCopy.length === 0) return;

    // 复制片段的数量
    const copyCount = clipsToCopy.length;

    // 找到要复制的 clips 中的最小 trackIndex（用于计算轨道偏移）
    const minSourceTrackIndex = clipsToCopy.length > 0
      ? Math.min(...clipsToCopy.map((c: TimelineClip) => c.trackIndex))
      : 0;

    // 计算复制片段的最小开始时间（用于保持相对位置）
    const minStartTime = Math.min(...clipsToCopy.map((clip) => clip.start));
    // 计算时间偏移量：将片段移动到播放头位置
    const timeOffset = currentTime - minStartTime;

    // 创建副本，改变 id、trackIndex 和时间位置（定位到播放头位置）
    const timestamp = Date.now();
    const newClips: TimelineClip[] = clipsToCopy.map((clip, index) => ({
      ...clip,
      id: `clip-${timestamp}-${index}-${Math.random().toString(36).substr(2, 9)}`,
      start: clip.start + timeOffset,
      end: clip.end + timeOffset,
      // 放到轨道0开头，保持相对轨道关系（复制N个片段，放到轨道0到N-1）
      trackIndex: clip.trackIndex - minSourceTrackIndex,
    }));

    // 将新片段添加到轨道0-N，其他所有现有片段轨道索引都增加复制片段的数量，避免重合
    const updatedClips = [
      ...newClips,
      ...clips.map((c: TimelineClip) => ({
        ...c,
        trackIndex: c.trackIndex + copyCount,
      })),
    ];

    setClips(updatedClips);
    setSelectedClipId(newClips.map((c) => c.id));
    message.success(`已复制 ${newClips.length} 个片段`);
  };

  // 向左分割：删除左侧部分，保留右侧
  const handleSplitLeft = () => {
    if (selectedClipId.length === 0) return;

    // 获取所有要分割的 clips
    const clipsToSplit = selectedClipId
      .map((id) => clips.find((c: TimelineClip) => c.id === id))
      .filter(Boolean) as TimelineClip[];

    if (clipsToSplit.length === 0) return;

    // 检查播放头是否在所有选中的 clips 内部
    const validClips = clipsToSplit.filter(
      (clip) => currentTime > clip.start && currentTime < clip.end
    );

    if (validClips.length === 0) {
      message.warning('请将播放头移动到片段内部以进行分割');
      return;
    }

    // 批量更新所有有效的 clips
    const updatedClips = clips.map((clip) => {
      if (validClips.some((c) => c.id === clip.id)) {
        const oldTrimStart = clip.trimStart || 0;
        const timelineOffset = currentTime - clip.start;
        const splitVideoTime = oldTrimStart + timelineOffset;
        return {
          ...clip,
          start: currentTime,
          trimStart: splitVideoTime,
        };
      }
      return clip;
    });

    batchUpdateClips(updatedClips);
    if (validClips.length < clipsToSplit.length) {
      message.warning(`已分割 ${validClips.length} 个片段，${clipsToSplit.length - validClips.length} 个片段不在播放头位置`);
    }
  };

  // 向右分割：删除右侧部分，保留左侧
  const handleSplitRight = () => {
    if (selectedClipId.length === 0) return;

    // 获取所有要分割的 clips
    const clipsToSplit = selectedClipId
      .map((id) => clips.find((c: TimelineClip) => c.id === id))
      .filter(Boolean) as TimelineClip[];

    if (clipsToSplit.length === 0) return;

    // 检查播放头是否在所有选中的 clips 内部
    const validClips = clipsToSplit.filter(
      (clip) => currentTime > clip.start && currentTime < clip.end
    );

    if (validClips.length === 0) {
      message.warning('请将播放头移动到片段内部以进行分割');
      return;
    }

    // 批量更新所有有效的 clips
    const updatedClips = clips.map((clip) => {
      if (validClips.some((c) => c.id === clip.id)) {
        const oldTrimStart = clip.trimStart || 0;
        const timelineOffset = currentTime - clip.start;
        const splitVideoTime = oldTrimStart + timelineOffset;
        return {
          ...clip,
          end: currentTime,
          trimEnd: splitVideoTime,
        };
      }
      return clip;
    });

    batchUpdateClips(updatedClips);
    if (validClips.length === clipsToSplit.length) {
      message.success(`已删除 ${validClips.length} 个片段的右侧部分`);
    } else {
      message.warning(`已删除 ${validClips.length} 个片段的右侧部分，${clipsToSplit.length - validClips.length} 个片段不在播放头位置`);
    }
  };

  const handleDeleteClip = () => {
    if (selectedClipId.length === 0) return;

    // 批量删除：直接过滤掉所有要删除的 clips
    const remainingClips = clips.filter((c: TimelineClip) => !selectedClipId.includes(c.id));

    // 使用 setClips 批量更新，而不是循环调用 removeClip
    setClips(remainingClips);

    // 计算剩余素材的最大结束时间
    const maxEndTime = remainingClips.length > 0
      ? Math.max(...remainingClips.map((c: TimelineClip) => c.end))
      : 0;

    // 只有删除后播放头超出了最大结束时间，才重置到最长的素材结尾
    if (currentTime > maxEndTime) {
      if (remainingClips.length > 0) {
        // 重置到最长的素材结尾（最大结束时间）
        onTimeChange(maxEndTime);
      } else {
        // 如果没有剩余素材，重置到 0
        onTimeChange(0);
      }
    }

    // 从选中列表中移除已删除的 clips，清空选中状态
    setSelectedClipId([]);
  };

  const handleUndo = () => {
    if (!canUndo) return;
    undo();
  };

  const handleRedo = () => {
    if (!canRedo) return;
    redo();
  };

  const formatTime = (seconds: number) => {
    const totalFrames = Math.floor(seconds * 30);
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const frames = totalFrames % 30;

    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
  };

  return (
    <div
      className='p-3 bg-background-default-base border-t border-b border-border-default-base inline-flex justify-between items-center nowheel nodrag nopan'
      data-nowheel='true'
      data-nodrag='true'
      data-nopan='true'
    >
      {/* 左侧：编辑工具 */}
      <div className='flex items-center gap-6'>
        <Tooltip title={t('playbackControls.reset') || 'Reset'} placement='top-end'>
          <div className='cursor-pointer' onClick={onReset}>
            <Icon
              name='videoEditor-reset-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
        <div className='w-px h-4 bg-border-default-base shrink-0 self-center' aria-hidden />
        <Tooltip title={t('playbackControls.undo') || 'Undo'} placement='top'>
          <div
            className={`${canUndo ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={canUndo ? handleUndo : undefined}
          >
            <Icon
              name='videoEditor-undo-icon'
              width={14}
              height={14}
              color={canUndo ? 'var(--color-icon-secondary)' : 'var(--color-icon-secondary)'}
            />
          </div>
        </Tooltip>
        <Tooltip title={t('playbackControls.redo') || 'Redo'} placement='top'>
          <div
            className={`${canRedo ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={canRedo ? handleRedo : undefined}
          >
            <Icon
              name='videoEditor-redo-icon'
              width={14}
              height={14}
              color={canRedo ? 'var(--color-icon-secondary)' : 'var(--color-icon-secondary)'}
            />
          </div>
        </Tooltip>
        <div className='w-px h-4 bg-border-default-base shrink-0 self-center' aria-hidden />
        <Tooltip title={t('playbackControls.splitLeft') || 'Split Left'} placement='top'>
          <div
            className={`${selectedClipId.length > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={selectedClipId.length > 0 ? handleSplitLeft : undefined}
          >
            <Icon
              name='videoEditor-split-left-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
        <Tooltip title={t('playbackControls.splitRight') || 'Split Right'} placement='top'>
          <div
            className={`${selectedClipId.length > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={selectedClipId.length > 0 ? handleSplitRight : undefined}
          >
            <Icon
              name='videoEditor-split-right-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
        <Tooltip title={t('playbackControls.split') || 'Split'} placement='top'>
          <div
            className={`${selectedClipId.length > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={selectedClipId.length > 0 ? handleClipSplit : undefined}
          >
            <Icon
              name='videoEditor-split-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
        <Tooltip title={t('playbackControls.copy') || 'Copy'} placement='top'>
          <div
            className={`${selectedClipId.length > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={selectedClipId.length > 0 ? handleCopyClip : undefined}
          >
            <Icon
              name='videoEditor-copy-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
        <div className='w-px h-4 bg-border-default-base shrink-0 self-center' aria-hidden />
        <Tooltip title={t('playbackControls.delete') || 'Delete'} placement='top'>
          <div
            className={`${selectedClipId.length > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={selectedClipId.length > 0 ? handleDeleteClip : undefined}
          >
            <Icon
              name='videoEditor-delete-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
      </div>

      {/* 中间：播放控制和时间显示 */}
      <div className='flex items-center justify-center gap-4 flex-1'>
        <div className='flex items-center gap-3'>
          <Tooltip title={t('playbackControls.stepBackward') || 'Step Backward'} placement='top'>
            <div
              className={`flex items-center justify-center ${actualDuration > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
              onClick={actualDuration > 0 ? () => handleTimeChange(Math.max(0, currentTime - 1)) : undefined}
            >
              <Icon
                name='videoEditor-step-backward-icon'
                width={14}
                height={14}
                color='var(--color-icon-secondary)'
              />
            </div>
          </Tooltip>
          <Tooltip title={isPlaying ? t('playbackControls.pause') || 'Pause' : t('playbackControls.play') || 'Play'} placement='top'>
            <div
              className={`flex items-center justify-center rounded-full w-8 h-8 ${actualDuration > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
              onClick={actualDuration > 0 ? handlePlayPause : undefined}
            >
              {isPlaying ? (
                <Icon
                  name='videoEditor-pause-icon'
                  width={20}
                  height={20}
                  color='var(--color-icon-secondary)'
                />
              ) : (
                <Icon
                  name='videoEditor-play-icon'
                  width={20}
                  height={20}
                  color='var(--color-icon-secondary)'
                />
              )}
            </div>
          </Tooltip>
          <Tooltip title={t('playbackControls.stepForward') || 'Step Forward'} placement='top'>
            <div
              className={`flex items-center justify-center ${actualDuration > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
              onClick={
                actualDuration > 0
                  ? () => handleTimeChange(Math.min(actualDuration, currentTime + 1))
                  : undefined
              }
            >
              <Icon
                name='videoEditor-step-forward-icon'
                width={14}
                height={14}
                color='var(--color-icon-secondary)'
              />
            </div>
          </Tooltip>
        </div>

        {/* 时间显示 */}
        <div className='flex items-center gap-2 font-mono text-sm text-gray-600'>
          <span className='text-[#71717a]'>{formatTime(currentTime)}</span>
          <span>/</span>
          <span className='text-[#e4e4e7]'>{formatTime(actualDuration)}</span>
        </div>

        {/* 全屏按钮 */}
        <Tooltip title={t('playbackControls.fullscreen') || 'Fullscreen'} placement='top'>
          <div
            className={`flex items-center justify-center ml-4 ${actualDuration > 0 ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
            onClick={actualDuration > 0 ? handleFullscreen : undefined}
          >
            <Icon
              name='videoEditor-fullscreen-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
      </div>

      {/* 右侧：缩放控制 */}
      <div className='flex items-center gap-2'>
        <div className='w-px h-4 bg-border-default-base shrink-0 self-center' aria-hidden />
        <Tooltip title={t('playbackControls.zoomOut') || 'Zoom Out'} placement='top'>
          <div
            className='cursor-pointer flex items-center justify-center'
            onClick={() => handleScaleChange(Math.max(1, scale - 1))}
          >
            <Icon
              name='videoEditor-zoom-out-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
        <Slider
          min={1}
          max={10}
          step={1}
          value={scale}
          onChange={handleScaleChange}
          className={`${sliderClass} mx-2 w-32 m-0 flex-shrink-0`}
          activeColor='#5A5A5A'
          inactiveColor='#E3E3E3'
          trackHeight={6}
          thumbWidth={20}
          thumbHeight={16}
          thumbColor='#B3B3B3'
        />
        <Tooltip title={t('playbackControls.zoomIn') || 'Zoom In'} placement='top'>
          <div
            className='cursor-pointer flex items-center justify-center'
            onClick={() => handleScaleChange(Math.min(10, scale + 1))}
          >
            <Icon
              name='videoEditor-zoom-in-icon'
              width={14}
              height={14}
              color='var(--color-icon-secondary)'
            />
          </div>
        </Tooltip>
      </div>
    </div>
  );
};

export default memo(PlaybackControls);
