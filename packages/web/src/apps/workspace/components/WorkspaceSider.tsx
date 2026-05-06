import React, { memo } from 'react';
import Tooltip from '@/ui/tooltip';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';

interface SocialLink {
  url: string;
  iconName: string;
}

const socialLinks: SocialLink[] = [
  { url: 'https://discord.gg/Yeu6A4aejN', iconName: 'workspace-slider-discord' },
  { url: 'https://x.com/breatic_ai', iconName: 'workspace-slider-x' },
  { url: 'https://www.youtube.com/@breatic_ai', iconName: 'workspace-slider-youtube' },
  { url: 'https://www.instagram.com/breatic_ai/', iconName: 'workspace-slider-ins' },
];

const WorkspaceSider: React.FC = () => {
  const { t } = useTranslation();

  const handleLinkClick = (url: string) => {
    window.open(url, '_blank');
  };

  return (
    <div
      className='w-[56px] h-full bg-background-default-secondary shadow-[0px_0px_1px_1px_rgba(255,255,255,0.20)] shadow-[0px_1px_4px_0px_rgba(255,255,255,0.05)]'
    >
      <div className='flex flex-col h-full items-center justify-between px-4 py-4'>
        <Tooltip title={t('workspace.home_tooltip')} placement='right'>
          <div
            onClick={() => handleLinkClick('/')}
            className='flex items-center justify-center w-6 h-6 cursor-pointer text-[#35C838] hover:text-[#6DEF70]'
          >
            <Icon name='workspace-logo' width={24} height={24} color='var(--bg-brand-base)' />
          </div>
        </Tooltip>

        <div className='space-y-6 mt-4 flex flex-col items-center'>
          <div className='flex gap-5 flex-col'>
            {socialLinks.map((link) => (
              <div
                key={link.url}
                onClick={() => handleLinkClick(link.url)}
                className='flex items-center justify-center w-[18px] h-[18px] cursor-pointer hover:text-[#35C838]'
              >
                <Icon name={link.iconName} width={18} height={18} color='var(--bg-icon-base)' />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(WorkspaceSider);
