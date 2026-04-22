/**
 * Image flow node bottom toolbar: Apply to Node (main canvas) | Create New Node (on main canvas) | Download
 * Style consistent with dataNode's NodeToolbar, positioned below the node by FlowNodeToolbar
 */
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import { message } from '@/components/base/message';

/** Trigger browser download from a data URL or http(s) address */
const downloadImageFromSrc = async (src: string): Promise<void> => {
  if (!src) {
    message.warning('No image to download');
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
    const ext = src.split('?')[0].match(/\.(jpe?g|png|webp|gif|tiff?)$/i)?.[1] || 'png';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `image-${Date.now()}.${ext}`;
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
  /** Replaces content of selected main-canvas image node(s) with this node's image (not agent input). */
  onAddToNodeClick?: (e: React.MouseEvent) => void;
  /** Adds a new main-canvas image node with the same image as this editor node. */
  onCreateNewNodeClick?: (e: React.MouseEvent) => void;
  /** Current node image URL; if set, download is handled inside this component */
  imageSrc?: string;
  disableAddToNode?: boolean;
  disableCreateNewNode?: boolean;
  disableDownload?: boolean;
}

const BottomToolbar: React.FC<BottomToolbarProps> = ({
  onAddToNodeClick,
  onCreateNewNodeClick,
  imageSrc,
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
          <Icon name='project-document-icon' width={14} height={14} color={iconColor} />
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
            if (disableDownload || !imageSrc) return;
            void downloadImageFromSrc(imageSrc);
          }}
        >
          <Icon name='project-chat-download-icon' width={14} height={14} color={iconColor} />
        </div>
      </div>
    </div>
  );
};

export default memo(BottomToolbar);
