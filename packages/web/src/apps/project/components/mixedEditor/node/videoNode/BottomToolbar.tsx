/**
 * Video flow node bottom toolbar: Apply to Node (main canvas) | Create New Node (on main canvas) | Download
 * Visual style matches `imageNode/BottomToolbar`; sits below `playback/PlaybackPanel` in FlowNodeToolbar.
 */
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import { message } from '@/components/base/message';

/** Trigger browser download from a video URL or data URL */
const downloadVideoFromSrc = async (src: string): Promise<void> => {
  if (!src) {
    message.warning('No video to download');
    return;
  }
  try {
    let blob: Blob;
    if (src.startsWith('data:')) {
      const res = await fetch(src);
      blob = await res.blob();
    } else {
      const res = await fetch(src, { mode: 'cors' });
      if (!res.ok) throw new Error(res.statusText);
      blob = await res.blob();
    }
    const clean = src.split('?')[0].split('#')[0];
    const ext =
      clean.match(/\.(mp4|webm|mov|m4v|mkv|ogv)$/i)?.[1]?.toLowerCase() ||
      (blob.type.includes('webm') ? 'webm' : blob.type.includes('quicktime') ? 'mov' : 'mp4');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `video-${Date.now()}.${ext}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    message.warning('Download failed');
  }
};

export interface BottomToolbarProps {
  onAddToNodeClick?: (e: React.MouseEvent) => void;
  onCreateNewNodeClick?: (e: React.MouseEvent) => void;
  videoSrc?: string;
  disableAddToNode?: boolean;
  disableCreateNewNode?: boolean;
  disableDownload?: boolean;
}

const BottomToolbar: React.FC<BottomToolbarProps> = ({
  onAddToNodeClick,
  onCreateNewNodeClick,
  videoSrc,
  disableAddToNode = false,
  disableCreateNewNode = false,
  disableDownload = false,
}) => {
  const { t } = useTranslation();

  const roundedClass = 'rounded-[4px]';
  const toolbarAreaClass = 'h-[22px] min-h-[22px] p-[2px] flex items-center flex-shrink-0';
  const btnHoverClass = 'hover:bg-background-default-base-hover rounded-[4px]';
  const areaClass = 'border border-[#DBDBDB] bg-background-default-base shadow-[0_1px_3px_rgba(0,0,0,0.08)]';
  const iconColor = 'var(--color-icon-base)';

  return (
    <div
      className='pointer-events-auto flex flex-wrap items-center justify-center gap-1'
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={disableAddToNode ? -1 : 0}
          className={`h-[18px] px-2 flex items-center gap-1.5 rounded-[4px] ${
            disableAddToNode ? 'cursor-not-allowed opacity-50' : `cursor-pointer ${btnHoverClass}`
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (!disableAddToNode) onAddToNodeClick?.(e);
          }}
        >
          <Icon name='project-chat-generated-add-to-input-icon' width={14} height={12} color={iconColor} />
          <span className='text-[11px] font-medium leading-none text-text-default-base whitespace-nowrap'>
            {t('project.toolbar.addToNode', 'Apply to Node')}
          </span>
        </div>
      </div>

      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={disableCreateNewNode ? -1 : 0}
          className={`h-[18px] px-2 flex items-center gap-1.5 rounded-[4px] ${
            disableCreateNewNode ? 'cursor-not-allowed opacity-50' : `cursor-pointer ${btnHoverClass}`
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (!disableCreateNewNode) onCreateNewNodeClick?.(e);
          }}
        >
          <Icon name='project-document-create-new-icon' width={14} height={14} color={iconColor} />
          <span className='text-[11px] font-medium leading-none text-text-default-base whitespace-nowrap'>
            {t('project.toolbar.createNewNode', 'Create New Node')}
          </span>
        </div>
      </div>

      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={disableDownload ? -1 : 0}
          className={`h-[18px] w-[18px] flex items-center justify-center rounded-[4px] ${
            disableDownload ? 'cursor-not-allowed opacity-50' : `cursor-pointer ${btnHoverClass}`
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (disableDownload || !videoSrc) return;
            void downloadVideoFromSrc(videoSrc);
          }}
        >
          <Icon name='project-chat-download-icon' width={14} height={14} color={iconColor} />
        </div>
      </div>
    </div>
  );
};

export default memo(BottomToolbar);
