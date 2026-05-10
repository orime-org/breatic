/**
 * Audio node toolbar — Launch Editor | Record Audio | Info.
 *
 * The Upload button was removed in F5 because uploads now flow
 * through `LeftFloatingMenu` only. The Record Audio path stays
 * (it's a node-local capture flow, not file ingest) — recordings
 * land via `useUploadFiles.uploadOne` per record-end so the URL
 * written to Yjs is permanent S3/OSS, not a blob URL.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';

export interface AudioNodeToolbarProps {
  nodeId: string;
  showRecordView: boolean;
  onRecordToggle: () => void;
  onPausePlayer?: () => void;
  onInfoClick?: () => void;
}

const AudioNodeToolbar: React.FC<AudioNodeToolbarProps> = ({
  nodeId,
  showRecordView,
  onRecordToggle,
  onPausePlayer,
  onInfoClick,
}) => {
  const { t } = useTranslation();
  const { openRightPanel } = useProjectLayout();

  const handleEditorClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openRightPanel('editor', nodeId);
  };
  const handleRecordToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPausePlayer?.();
    onRecordToggle();
  };

  const roundedClass = 'rounded-[8px]';
  const toolbarAreaClass = 'h-[40px] min-h-[40px] p-[6px] rounded-[8px] flex items-center flex-shrink-0';
  const btnHoverClass = 'hover:bg-background-default-base-hover rounded-[4px]';
  const areaClass = 'bg-background-default-base shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]';
  const iconColor = 'var(--color-icon-base)';

  return (
    <div
      className='flex items-center gap-3 h-[40px] rounded-[8px] pointer-events-auto'
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Left: Launch Editor (opens ResizableLeftPanel) */}
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={0}
          className={`cursor-pointer h-7 px-3 flex items-center gap-2 ${btnHoverClass}`}
          onClick={handleEditorClick}
        >
          <Icon name='project-launch-editor-icon' width={20} height={20} color={iconColor} />
          <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>
            Lanch Editor
          </span>
        </div>
      </div>

      {/* Middle: Record Audio */}
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={0}
          className={`cursor-pointer h-7 px-2 flex items-center gap-1.5 ${btnHoverClass}`}
          onClick={handleRecordToggle}
        >
          <Icon
            name='project-microphone-icon'
            width={14}
            height={14}
            color={showRecordView ? 'var(--color-text-status-error)' : iconColor}
          />
          <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>
            {showRecordView ? t('project.toolbar.exitRecording') : 'Record Audio'}
          </span>
        </div>
      </div>

      {/* Right: standalone info icon */}
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={0}
          className={`cursor-pointer h-7 w-7 flex items-center justify-center ${btnHoverClass}`}
          onClick={(e) => { e.stopPropagation(); onInfoClick?.(); }}
        >
          <Icon name='project-image-info-icon' width={20} height={19} color={iconColor} />
        </div>
      </div>
    </div>
  );
};

export default AudioNodeToolbar;
