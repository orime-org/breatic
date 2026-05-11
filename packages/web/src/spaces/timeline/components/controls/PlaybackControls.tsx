import React, { memo } from 'react';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import { message } from '@/ui/message';
import Slider from '@/ui/slider';
import Tooltip from '@/ui/tooltip';
import { useTranslation } from 'react-i18next';
import type { TimelineClip } from '@/spaces/timeline/types';
import { Icon } from '@/ui/icon';

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

/* * * PlaybackControls component - playbackcontrol * */
const PlaybackControls: React.FC<PlaybackControlsProps> = ({
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

  // use useVideoEditorStore hook
  const {
    clips,
    mediaItems,
    selectedClipId,
    setClips,
    batchUpdateClips,
    setSelectedClipId,
  } = useVideoEditorStore();

  // calculateactual
  const actualDuration = clips.length === 0 ? 0 : Math.max(...clips.map((c: TimelineClip) => c.end));

  // componentinside
  const handleTimeChange = (time: number) => {
    onTimeChange(time);
  };

  const handlePlayPause = () => {
    const playheadWidthTime = 2 / (scale * 50);
    const maxPlayheadTime = actualDuration - playheadWidthTime;

    // ifplayback end ， startplayback
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

  // componentinside clip
  const handleClipSplit = () => {
    if (selectedClipId.length === 0) return;

    const clipsToSplit = selectedClipId
      .map((id) => clips.find((c: TimelineClip) => c.id === id))
      .filter(Boolean) as TimelineClip[];
    if (clipsToSplit.length === 0) return;

    const validClips = clipsToSplit.filter(
      (clip) => currentTime > clip.start && currentTime < clip.end
    );

    if (validClips.length === 0) {
      message.warning(t('message.movePlayheadToSplit'));
      return;
    }

    const validClipIds = new Set(validClips.map((clip) => clip.id));
    const newSelectedRightClipIds: string[] = [];
    const newClips = clips.flatMap((clip: TimelineClip) => {
      if (!validClipIds.has(clip.id)) {
        return [clip];
      }

      const media = mediaItems.find((m: { id: string; duration?: number }) => m.id === clip.mediaId);
      const mediaDuration = media?.duration || 0;
      const oldTrimStart = clip.trimStart || 0;
      const oldTrimEnd = clip.trimEnd || mediaDuration;
      const timelineOffset = currentTime - clip.start;
      const splitVideoTime = oldTrimStart + timelineOffset;
      const clipBaseId = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const leftClip: TimelineClip = {
        ...clip,
        id: `${clipBaseId}-l`,
        end: currentTime,
        trimStart: oldTrimStart,
        trimEnd: splitVideoTime,
      };

      const rightClip: TimelineClip = {
        ...clip,
        id: `${clipBaseId}-r`,
        start: currentTime,
        trimStart: splitVideoTime,
        trimEnd: oldTrimEnd,
      };
      newSelectedRightClipIds.push(rightClip.id);
      return [leftClip, rightClip];
    });

    setClips(newClips);
    setSelectedClipId(newSelectedRightClipIds);
    if (validClips.length === clipsToSplit.length) {
      message.success(`已分割 ${validClips.length} 个片段`);
    } else {
      message.warning(`已分割 ${validClips.length} 个片段，${clipsToSplit.length - validClips.length} 个片段不在播放头位置`);
    }
  };

  const handleCopyClip = () => {
    if (selectedClipId.length === 0) return;

    // getall duplicate clips
    const clipsToCopy = selectedClipId
      .map((id) => clips.find((c: TimelineClip) => c.id === id))
      .filter(Boolean) as TimelineClip[];

    if (clipsToCopy.length === 0) return;

    // duplicateclip
    const copyCount = clipsToCopy.length;

    // duplicate clips trackIndex（used forcalculatetrackoffset）
    const minSourceTrackIndex = clipsToCopy.length > 0
      ? Math.min(...clipsToCopy.map((c: TimelineClip) => c.trackIndex))
      : 0;

    // calculateduplicateclip starttime（used forkeep ）
    const minStartTime = Math.min(...clipsToCopy.map((clip) => clip.start));
    // calculatetimeoffset ： clip playback
    const timeOffset = currentTime - minStartTime;

    // createcopy， id、trackIndex time （ playback ）
    const timestamp = Date.now();
    const newClips: TimelineClip[] = clipsToCopy.map((clip, index) => ({
      ...clip,
      id: `clip-${timestamp}-${index}-${Math.random().toString(36).substr(2, 9)}`,
      start: clip.start + timeOffset,
      end: clip.end + timeOffset,
      // track0 ，keep trackrelation（duplicateN clip， track0 N-1）
      trackIndex: clip.trackIndex - minSourceTrackIndex,
    }));

    // clip track0-N，otherall cliptrack duplicateclip ，avoidoverlap
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

  // split leftsplit：deleteleft ，keepright
  const handleSplitLeft = () => {
    if (selectedClipId.length === 0) return;

    // getall split clips
    const clipsToSplit = selectedClipId
      .map((id) => clips.find((c: TimelineClip) => c.id === id))
      .filter(Boolean) as TimelineClip[];

    if (clipsToSplit.length === 0) return;

    // checkplayback allselected clips inside
    const validClips = clipsToSplit.filter(
      (clip) => currentTime > clip.start && currentTime < clip.end
    );

    if (validClips.length === 0) {
      message.warning(t('message.movePlayheadToSplit'));
      return;
    }

    // batchupdateallvalid clips
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

  // split rightsplit：deleteright ，keepleft
  const handleSplitRight = () => {
    if (selectedClipId.length === 0) return;

    // getall split clips
    const clipsToSplit = selectedClipId
      .map((id) => clips.find((c: TimelineClip) => c.id === id))
      .filter(Boolean) as TimelineClip[];

    if (clipsToSplit.length === 0) return;

    // checkplayback allselected clips inside
    const validClips = clipsToSplit.filter(
      (clip) => currentTime > clip.start && currentTime < clip.end
    );

    if (validClips.length === 0) {
      message.warning(t('message.movePlayheadToSplit'));
      return;
    }

    // batchupdateallvalid clips
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

    const deletedClips = clips.filter((c: TimelineClip) => selectedClipId.includes(c.id));
    // batchdelete： all delete clips
    const remainingClips = clips.filter((c: TimelineClip) => !selectedClipId.includes(c.id));

    // use setClips batchupdate， removeClip
    setClips(remainingClips);

    // calculateremainingasset endtime
    const maxEndTime = remainingClips.length > 0
      ? Math.max(...remainingClips.map((c: TimelineClip) => c.end))
      : 0;

    // delete playback exceed endtime， reset longest assetend
    if (currentTime > maxEndTime) {
      if (remainingClips.length > 0) {
        // reset longest assetend（ endtime）
        onTimeChange(maxEndTime);
      } else {
        // ifnoremainingasset，reset 0
        onTimeChange(0);
      }
    }

    // delete automaticallyselected remainingclip，keep
    if (remainingClips.length === 0) {
      setSelectedClipId([]);
    } else {
      const anchorTime =
        deletedClips.length > 0
          ? Math.min(...deletedClips.map((c) => c.start))
          : currentTime;
      const nextClip = [...remainingClips]
        .sort((a, b) => {
          const distA = Math.abs(a.start - anchorTime);
          const distB = Math.abs(b.start - anchorTime);
          if (distA !== distB) return distA - distB;
          if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
          return a.start - b.start;
        })[0];
      setSelectedClipId(nextClip ? [nextClip.id] : []);
    }
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
      {/* left： */}
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

      {/* middle：playbackcontrol timedisplay */}
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

        {/* timedisplay */}
        <div className='flex items-center gap-2 font-mono text-sm text-gray-600'>
          <span className='text-[#71717a]'>{formatTime(currentTime)}</span>
          <span>/</span>
          <span className='text-[#e4e4e7]'>{formatTime(actualDuration)}</span>
        </div>

        {/* fullscreenbutton */}
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

      {/* right：scalecontrol */}
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
          inactiveColor='var(--color-background-neutral-tertiary)'
          trackHeight={6}
          thumbWidth={20}
          thumbHeight={16}
          thumbColor='var(--color-text-disabled-base)'
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
