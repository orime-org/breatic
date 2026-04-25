import React, { memo } from 'react';
import { Icon } from '@/components/base/icon';
import userPng from '@/assets/images/userCenter/user.png';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';

const defaultBgValue = 'var(--color-background-default-secondary)';

const backgroundColors = [
  { value: defaultBgValue, border: true },
  { value: '#ffffff', border: true },
  { value: '#e0e0e0' },
  { value: '#bdbdbd' },
  { value: '#9e9e9e' },
  { value: '#616161' },
];

export interface CanvasBlankRightPanelProps {
  /** Notifies parent to collapse the right panel when the collapse button is clicked */
  onRequestCollapse?: () => void;
  /** Current ReactFlow canvas background color (synced with Background component bgColor) */
  backgroundColor?: string;
  /** Callback when background color is selected, used to update ReactFlow Background */
  onBackgroundChange?: (color: string) => void;
}

const CanvasBlankRightPanel: React.FC<CanvasBlankRightPanelProps> = ({
  onRequestCollapse,
  backgroundColor = defaultBgValue,
  onBackgroundChange,
}) => {
  const selectedBgIndex = Math.max(
    0,
    backgroundColors.findIndex((c) => c.value === backgroundColor),
  );
  const { userInfo } = useUserCenterStore();
  const displayUserInfo = userInfo && Object.keys(userInfo).length > 0 ? userInfo : undefined;

  return (
    <div className='flex h-full w-full flex-col bg-[var(--color-background-default-base)] overflow-hidden'>
      {/* Top: collapse button on its own row; second row has collaborator avatars + share on the right */}
      <div className='flex shrink-0 flex-col gap-2 border-b border-[var(--color-border-default-base)] px-4 py-4'>
        <div className='flex justify-end'>
          <button
            type='button'
            onClick={onRequestCollapse}
            className='flex h-8 w-8 items-center justify-center rounded hover:bg-[var(--color-background-default-secondary)] transition-colors'
            aria-label='Collapse panel'
          >
            <Icon name='project-collapse-panel-icon' width={20} height={16} color='var(--color-icon-base)' />
          </button>
        </div>
        <div className='flex items-center justify-between'>
          <div className='flex -space-x-2'>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className='relative h-[32px] w-[32px] shrink-0 overflow-hidden rounded-full border-2 border-[var(--color-background-default-base)] bg-[var(--color-border-default-base)]'
                style={{ zIndex: i }}
                aria-hidden
              >
                <img src={userPng} alt='' className='h-full w-full object-cover' />
              </div>
            ))}
            <div
              className='relative h-[32px] w-[32px] shrink-0 overflow-hidden rounded-full border-2 border-[var(--color-background-default-base)]'
              style={{ zIndex: 4 }}
              aria-hidden
            >
              <img
                src={displayUserInfo?.avatar || userPng}
                alt={displayUserInfo?.name || ''}
                className='h-full w-full object-cover'
              />
            </div>
          </div>
          <button
            type='button'
            className='flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded hover:bg-[var(--color-background-default-secondary)] transition-colors'
            aria-label='Share'
          >
            <Icon name='project-share-icon' width={18} height={20} color='var(--color-icon-secondary)' />
          </button>
        </div>
      </div>

      {/* Background color selection */}
      <div className='shrink-0 border-b border-[var(--color-border-default-base)] px-4 py-4'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-[14px] font-medium text-[var(--color-text-default-base)] shrink-0'>Background</span>
          <div className='flex items-center gap-1'>
            {backgroundColors.map((item, index) => (
              <button
                key={index}
                type='button'
                onClick={() => onBackgroundChange?.(item.value)}
                className='h-6 w-6 shrink-0 rounded-full border-2 transition-transform hover:scale-110'
                style={{
                  backgroundColor: item.value,
                  borderColor: item.border ? 'var(--color-border-default-base)' : 'transparent',
                }}
                aria-label={`Background color ${index + 1}`}
                aria-pressed={selectedBgIndex === index}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Page Summary */}
      <div className='flex flex-1 min-h-0 flex-col'>
        <div className='shrink-0 border-b border-[var(--color-border-default-base)] px-4 pt-4 pb-2'>
          <div className='text-[14px] font-medium text-[var(--color-text-default-base)]'>Page Summary</div>
        </div>
        <div className='flex-1 min-h-[120px] px-4 py-4 bg-[var(--color-background-default-base)]' />
      </div>
    </div>
  );
};

export default memo(CanvasBlankRightPanel);
