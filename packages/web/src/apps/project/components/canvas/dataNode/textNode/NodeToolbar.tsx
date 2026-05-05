/** Text node top toolbar — single bar, icon + label (aligned with `new/.../imageNode/Toolbar`). */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Divider from '@/components/base/divider';
import { useCanvasUI } from '@/hooks/useCanvasUI';

export interface TextNodeToolbarProps {
  nodeId: string;
  /** Disable Upload while uploading. */
  isUploading?: boolean;
  onUploadClick?: () => void;
  onInfoClick?: () => void;
}

const TextNodeToolbar: React.FC<TextNodeToolbarProps> = ({
  nodeId,
  isUploading = false,
  onUploadClick,
  onInfoClick,
}) => {
  const { t } = useTranslation();
  const { openRightPanel } = useCanvasUI();

  const handleEditorClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openRightPanel('editor', nodeId, undefined, true);
  };

  const shellClass =
    'pointer-events-auto flex items-center gap-0 rounded-[8px] border border-border-default-base bg-background-default-base px-[6px] py-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]';
  const actionBtnClass =
    'flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover';

  return (
    <div className={shellClass} onMouseDown={(e) => e.stopPropagation()}>
      <Tooltip title={t('project.toolbar.openEditor', 'Open editor')} placement='top' offset={4}>
        <button type='button' className={actionBtnClass} onClick={handleEditorClick}>
          <Icon name='project-launch-editor-icon' width={20} height={20} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
            {t('project.toolbar.openEditor', 'Open editor')}
          </span>
        </button>
      </Tooltip>
      <Divider type='vertical' className='mx-[2px] h-[18px]' />
      <Tooltip title={t('project.toolbar.upload', 'Upload')} placement='top' offset={4}>
        <button
          type='button'
          tabIndex={isUploading ? -1 : 0}
          className={`${actionBtnClass} ${isUploading ? 'cursor-not-allowed opacity-50' : ''}`}
          disabled={isUploading}
          onClick={(e) => {
            e.stopPropagation();
            if (!isUploading) onUploadClick?.();
          }}
        >
          <Icon name='project-upload-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
            {t('project.toolbar.upload', 'Upload')}
          </span>
        </button>
      </Tooltip>
      <Divider type='vertical' className='mx-[2px] h-[18px]' />
      <Tooltip title={t('project.toolbar.nodeInfo', 'Details')} placement='top' offset={4}>
        <button
          type='button'
          className={actionBtnClass}
          onClick={(e) => {
            e.stopPropagation();
            onInfoClick?.();
          }}
        >
          <Icon name='project-image-info-icon' width={20} height={19} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
            {t('project.toolbar.nodeInfo', 'Details')}
          </span>
        </button>
      </Tooltip>
    </div>
  );
};

export default TextNodeToolbar;
