/**
 * Bottom toolbar for local canvas image nodes (parity with mixed-editor image flow `BottomToolbar.tsx`).
 */
import { memo, type FC, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import { message } from '@/components/base/message';

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
  imageSrc?: string;
  onCreateNewNodeClick?: (e: MouseEvent) => void;
}

const BottomToolbar: FC<BottomToolbarProps> = ({ imageSrc, onCreateNewNodeClick }) => {
  const { t } = useTranslation();
  const roundedClass = 'rounded-[4px]';
  const toolbarAreaClass = 'h-[22px] min-h-[22px] p-[2px] flex items-center flex-shrink-0';
  const btnHoverClass = 'hover:bg-background-default-base-hover rounded-[4px]';
  const areaClass = 'border border-[#DBDBDB] bg-background-default-base shadow-[0_1px_3px_rgba(0,0,0,0.08)]';
  const iconColor = 'var(--color-icon-base)';
  const disableAddToNode = true;
  const disableCreateNewNode = !onCreateNewNodeClick;
  const disableDownload = !imageSrc;

  return (
    <div
      className='pointer-events-auto flex flex-wrap items-center justify-center gap-1'
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={disableAddToNode ? -1 : 0}
          className={`flex h-[18px] items-center gap-1.5 rounded-[4px] px-2 ${
            disableAddToNode ? 'cursor-not-allowed opacity-50' : `cursor-pointer ${btnHoverClass}`
          }`}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <Icon name='project-chat-generated-add-to-input-icon' width={14} height={12} color={iconColor} />
          <span className='whitespace-nowrap text-[11px] font-medium leading-none text-text-default-base'>
            {t('project.toolbar.addToNode', 'Apply to Node')}
          </span>
        </div>
      </div>

      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={disableCreateNewNode ? -1 : 0}
          className={`flex h-[18px] items-center gap-1.5 rounded-[4px] px-2 ${
            disableCreateNewNode ? 'cursor-not-allowed opacity-50' : `cursor-pointer ${btnHoverClass}`
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (!disableCreateNewNode) onCreateNewNodeClick?.(e);
          }}
        >
          <Icon name='project-document-icon' width={14} height={14} color={iconColor} />
          <span className='whitespace-nowrap text-[11px] font-medium leading-none text-text-default-base'>
            {t('project.toolbar.createNewNode', 'Create New Node')}
          </span>
        </div>
      </div>

      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={disableDownload ? -1 : 0}
          className={`flex h-[18px] w-[18px] items-center justify-center rounded-[4px] ${
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
