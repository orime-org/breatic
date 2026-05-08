/** Image node toolbar: Launch Editor | Upload | Info. */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';

export interface ImageNodeToolbarProps {
  nodeId: string;
  /** Disable Upload while uploading. */
  isUploading?: boolean;
  onUploadClick?: () => void;
  onTakePhotoClick?: () => void;
}

const ImageNodeToolbar: React.FC<ImageNodeToolbarProps> = ({
  nodeId,
  isUploading = false,
  onUploadClick,
  onTakePhotoClick,
}) => {
  const { t } = useTranslation();
  const { openRightPanel } = useProjectLayout();

  const handleEditorClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openRightPanel('editor', nodeId);
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

      {/* Middle: Upload */}
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={isUploading ? -1 : 0}
          className={`h-7 px-2 flex items-center gap-1.5 rounded-[4px] ${isUploading ? 'cursor-not-allowed opacity-50' : `cursor-pointer ${btnHoverClass}`}`}
          onClick={(e) => { e.stopPropagation(); if (!isUploading) onUploadClick?.(); }}
        >
          <Icon name='project-upload-icon' width={16} height={16} color={iconColor} />
          <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>
            {t('project.toolbar.upload', 'Upload')}
          </span>
        </div>
      </div>

      {/* Right: standalone info icon */}
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={0}
          className={`cursor-pointer h-7 w-7 flex items-center justify-center ${btnHoverClass}`}
          onClick={(e) => { e.stopPropagation(); onTakePhotoClick?.(); }}
        >
          <Icon name='project-image-info-icon' width={20} height={19} color={iconColor} />
        </div>
      </div>
    </div>
  );
};

export default ImageNodeToolbar;
