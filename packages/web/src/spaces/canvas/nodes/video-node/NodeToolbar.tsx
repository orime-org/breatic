/**
 * Video node toolbar — Launch Editor | Info.
 *
 * The Upload button was removed in F5 because uploads now flow
 * through `LeftFloatingMenu` only (single canonical entry point).
 */
import React from 'react';
import { Icon } from '@/ui/icon';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';

export interface VideoNodeToolbarProps {
  nodeId: string;
  onShootVideoClick?: () => void;
}

const VideoNodeToolbar: React.FC<VideoNodeToolbarProps> = ({
  nodeId,
  onShootVideoClick,
}) => {
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

      {/* Right: standalone info icon */}
      <div className={`${areaClass} ${roundedClass} ${toolbarAreaClass} gap-0`}>
        <div
          role='button'
          tabIndex={0}
          className={`cursor-pointer h-7 w-7 flex items-center justify-center ${btnHoverClass}`}
          onClick={(e) => { e.stopPropagation(); onShootVideoClick?.(); }}
        >
          <Icon name='project-image-info-icon' width={20} height={19} color={iconColor} />
        </div>
      </div>
    </div>
  );
};

export default VideoNodeToolbar;
