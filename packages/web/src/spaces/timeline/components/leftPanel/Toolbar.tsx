import React, { memo } from 'react';
import Tooltip from '@/ui/tooltip';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import { RiFolder3Line } from 'react-icons/ri';

interface ToolbarProps {
  activePanel: string | null;
  onPanelChange: (panelId: string) => void;
}

/* * * Toolbar component - left */
const Toolbar: React.FC<ToolbarProps> = ({ activePanel, onPanelChange }) => {
  const { t } = useTranslation();

  const tools = [
    { id: 'folder', iconName: 'videoEditor-folder-icon', label: t('toolbar.media') || 'Media' },
    { id: 'text', iconName: 'videoEditor-text-icon', label: t('toolbar.text') || 'Text' },
    { id: 'images', iconName: 'videoEditor-image-icon', label: t('toolbar.image') || 'Image' },
    { id: 'audio', iconName: 'videoEditor-audio-icon', label: t('toolbar.audio') || 'Audio' },
    { id: 'videos', iconName: 'videoEditor-video-icon', label: t('toolbar.video') || 'Video' },
  ];

  return (
    <div className='flex flex-col items-center gap-2 py-2 w-[45px] bg-background-default-secondary'>
      {tools.map((tool) => {
        const isActive = activePanel === tool.id;
        return (
          <Tooltip key={tool.id} title={tool.label} placement='right'>
            <button
              onClick={() => {
                if (!isActive) {
                  onPanelChange(tool.id);
                }
              }}
              className={`flex items-center justify-center w-8 h-8 rounded hover:bg-background-default-base ${
                isActive ? 'bg-background-default-base text-[#1F2125]' : 'text-[#71717a]'
              }`}
            >
              {tool.id === 'folder' ? (
                <RiFolder3Line
                  size={14}
                  color={isActive ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
                />
              ) : (
                <Icon
                  name={tool.iconName}
                  width={14}
                  height={14}
                  color={isActive ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
                />
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
};

export default memo(Toolbar);
