import React, { memo } from 'react';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';
import user_png from '@/assets/images/userCenter/user.png';
import { useTranslation } from 'react-i18next';
import { UserInfoType } from '@/store/modules/userCenter';

interface AccountTabProps {
  userInfo?: UserInfoType;
  onLogout?: () => void;
}

const AccountTab: React.FC<AccountTabProps> = ({ userInfo, onLogout }) => {
  const { t } = useTranslation();

  return (
    <div className='flex flex-col gap-3 w-full'>
      {/* User Info Card */}
      <div className='flex items-center justify-between bg-background-default-secondary rounded-[8px] px-24 p-4'>
        <div className='flex items-center gap-[10px]'>
          <div className='w-10 h-10 rounded-full overflow-hidden'>
            <img className='w-full h-full object-cover' src={userInfo?.avatar || user_png} alt='Avatar' />
          </div>
          <div className='flex flex-col gap-[2px]'>
            <span className='text-sm font-bold text-text-default-base leading-5'>{userInfo?.name || ''}</span>
            <span className='text-xs font-bold text-text-default-base leading-4'>{userInfo?.email || ''}</span>
          </div>
        </div>
        <Button
          type='default'
          size='medium'
          shape='round'
          bordered
          onClick={onLogout}
          icon={<Icon name='userCenter-logout' width={18} height={18} />}
        >
          {t('userCenter.modal.account.tabs.account.logout')}
        </Button>
      </div>

      {/* Account Information Card */}
      <div className='flex flex-col bg-background-default-secondary rounded-[8px] px-24 p-4 gap-3'>
        <span className='text-xl font-medium text-text-default-base leading-7'>
          {t('userCenter.modal.account.tabs.account.accountInformation')}
        </span>

        <div className='space-y-2'>
          <div className='flex justify-between'>
            <span className='text-sm font-bold text-text-default-base leading-5'>
              {t('userCenter.modal.account.tabs.account.credits')}
            </span>
            <div className='text-sm font-bold text-text-default-base leading-5'>
              {userInfo?.total_credits ?? 0}
            </div>
          </div>

          <div className='flex justify-between'>
            <span className='text-xs font-bold text-text-default-secondary leading-4'>
              {t('userCenter.modal.account.tabs.account.freeCredits')}
            </span>
            <div className='text-xs font-bold text-text-default-base leading-4'>
              {userInfo?.free_credits ?? 0}
            </div>
          </div>

          <div className='flex justify-between'>
            <span className='text-xs font-bold text-text-default-secondary leading-4'>
              {t('userCenter.modal.account.tabs.account.purchaseCredits')}
            </span>
            <div className='text-xs font-bold text-text-default-base leading-4'>
              {userInfo?.purchase_credits ?? 0}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(AccountTab);
