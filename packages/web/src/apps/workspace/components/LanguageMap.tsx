import React, { memo, useState, useEffect } from 'react';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import i18n from '@/i18n';
import { Icon } from '@/components/base/icon';

/**
 * Language Selector Component
 * @description Select language with dropdown menu
 */
const LanguageMap: React.FC = () => {
  const { language, setLanguage } = useUserCenterStore();
  const [open, setOpen] = useState(false);

  // Load language from localStorage on mount.
  useEffect(() => {
    const stored = localStorage.getItem('language');
    if (stored && ['en', 'zh-CN', 'zh-TW', 'ja'].includes(stored)) {
      setLanguage(stored);
      i18n.changeLanguage(stored);
    } else {
      // Default to en when missing.
      setLanguage('en');
      i18n.changeLanguage('en');
    }
  }, [setLanguage]);

  // Language name mapping
  const languageMap: Record<string, string> = {
    en: 'English',
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    ja: 'Japanese',
  };

  // Menu items
  const menuItems: MenuItemType[] = [
    {
      key: 'en',
      label: 'English',
    },
    {
      key: 'zh-CN',
      label: 'Simplified Chinese',
    },
    {
      key: 'zh-TW',
      label: 'Traditional Chinese',
    },
    {
      key: 'ja',
      label: 'Japanese',
    },
  ];

  // Handle menu click
  const handleMenuClick = (key: string) => {
    if (key === 'en' || key === 'zh-CN' || key === 'zh-TW' || key === 'ja') {
      setLanguage(key);
      i18n.changeLanguage(key);
    }
    setOpen(false);
  };

  // Handle open change for hover trigger
  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
  };

  return (
    <div className='relative z-30 flex items-center'>
      <Dropdown
        items={menuItems}
        onClick={handleMenuClick}
        selectedKeys={[language]}
        trigger='hover'
        placement='bottom-end'
        open={open}
        onOpenChange={handleOpenChange}
        popupClassName='min-w-[106px]'
        popupRender={(menu) => <div>{menu}</div>}
      >
        <div className='cursor-pointer flex items-center gap-1 h-[32px]'>
          <Icon name='project-language-icon' width={20} height={20} color='var(--color-icon-base)' />
          <span className='w-[60px] text-center text-xs font-bold text-text-default-base leading-4'>
            {languageMap[language] || 'English'}
          </span>
          <div
            className={`w-5 h-5 flex items-center justify-center transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          >
            <Icon name='workspace-arrow-drop-down' width={20} height={20} color='var(--color-icon-secondary-hover)' />
          </div>
        </div>
      </Dropdown>
    </div>
  );
};

export default memo(LanguageMap);
