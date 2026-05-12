import React, { memo, useState } from 'react';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import user_png from '@/assets/images/userCenter/user.png';
import type { UserInfoType } from '@/app/store/userCenterStore';
import { Icon } from '@/ui/icon';
import { useTranslation } from 'react-i18next';

interface InfoBadgeProps {
  userInfo?: UserInfoType;
  onAccountClick?: () => void;
  onLogoutClick?: () => void;
  onUpgradeClick?: () => void;
  onClick?: () => void;
}

const InfoBadge: React.FC<InfoBadgeProps> = ({
  userInfo,
  onAccountClick,
  onLogoutClick,
  onUpgradeClick: _onUpgradeClick,
  onClick
}) => {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();

  const items: MenuItemType[] = [
    {
      key: 'user-info',
      label: (
        <div className='w-full flex flex-col rounded-[8px] bg-background-default-secondary gap-3 p-[12px] mb-[4px]' onClick={(e) => e.stopPropagation()}>
          <div className='flex items-center justify-center'>
            <div className='w-[48px] h-[48px] rounded-full overflow-hidden'>
              <img className='w-full h-full object-cover' alt='User Avatar' src={userInfo?.avatar || user_png} />
            </div>
          </div>
          <div className='flex flex-col items-center'>
            <span className='text-sm font-bold text-text-default-base leading-5'>{userInfo?.name || ''}</span>
            <span className='text-xs font-light text-text-default-base leading-4'>{userInfo?.email || ''}</span>
          </div>
        </div>
      ),
      interactive: false,
    },
    {
      key: 'account',
      label: (
        <div className='w-full h-[32px] flex items-center gap-1 p-1 rounded-[4px] text-xs font-bold leading-4 text-text-default-base hover:bg-background-default-secondary text-icon-Default-Default'>
          <Icon name='userCenter-manage-accounts' height={24} width={24} color='currentColor' />
          {t('userCenter.modal.userDropdown.account')}
        </div>
      ),
    },
    {
      key: 'dividing-line-0',
      type: 'divider',
      label: null,
    },
    {
      key: 'terms-of-use',
      label: (
        <div className='w-full h-[32px] flex items-center gap-1 p-1 rounded-[4px] text-xs font-bold leading-4 text-text-default-base hover:bg-background-default-secondary text-icon-Default-Default'>
          <Icon name='userCenter-policy' height={24} width={24} color='currentColor' />
          {t('userCenter.modal.userDropdown.termsOfUse')}
        </div>
      ),
    },
    {
      key: 'privacy-policy',
      label: (
        <div className='w-full h-[32px] flex items-center gap-1 p-1 rounded-[4px] text-xs font-bold leading-4 text-text-default-base hover:bg-background-default-secondary text-icon-Default-Default'>
          <Icon name='userCenter-privacy-tip' height={24} width={24} color='currentColor' />
          {t('userCenter.modal.userDropdown.privacyPolicy')}
        </div>
      ),
    },
    {
      key: 'dividing-line-1',
      type: 'divider',
      label: null,
    },
    {
      key: 'log-out',
      label: (
        <div className='w-full h-[32px] flex items-center gap-1 p-1 rounded-[4px] text-xs font-bold leading-4 text-text-default-base hover:bg-background-default-secondary text-icon-Default-Default'>
          <Icon name='userCenter-logout' height={24} width={24} color='currentColor' />
          {t('userCenter.modal.userDropdown.logout')}
        </div>
      ),
    },
  ];

  const handleMenuClick = (key: string) => {
    setVisible(false);
    switch (key) {
      case 'account':
        onAccountClick?.();
        break;
      case 'terms-of-use':
        window.open('/terms', '_blank');
        break;
      case 'privacy-policy':
        window.open('/privacy', '_blank');
        break;
      case 'log-out':
        onLogoutClick?.();
        break;
    }
  };

  return (
    <Dropdown
      items={items}
      onClick={handleMenuClick}
      trigger='click'
      placement='bottom-end'
      open={visible}
      onOpenChange={setVisible}
      popupClassName='p-[16px] min-w-[280px]'
      itemClassName='p-0 bg-transparent'
      popupRender={(menu) => <div>{menu}</div>}
    >
      <div
        className='cursor-pointer'
        onClick={onClick}
      >
        <img
          className='w-7 h-7 rounded-full'
          alt={userInfo?.name || 'Info badge'}
          src={userInfo?.avatar || user_png}
          loading='lazy'
          decoding='async'
          style={{
            opacity: visible ? 0.9 : 1,
          }}
          onError={(e) => {
            const target = e.currentTarget as HTMLImageElement;
            target.onerror = null;
            target.src = user_png;
          }}
        />
      </div>
    </Dropdown>
  );
};

export default memo(InfoBadge);