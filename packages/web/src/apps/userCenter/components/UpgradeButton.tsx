import React, { memo, useState } from 'react';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { Icon } from '@/components/base/icon';
import { UserInfoType } from '@/store/modules/userCenter';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/base/button';

interface UpgradeButtonProps {
  userInfo?: UserInfoType;
  onPurchaseClick?: () => void;
  hideTitleText?: boolean;
}

const UpgradeButton: React.FC<UpgradeButtonProps> = ({
  userInfo,
  onPurchaseClick,
  hideTitleText = false,
}) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  const handlePurchaseClick = () => {
    onPurchaseClick?.();
    setVisible(false);
  };

  const dropdownContent = (
    <div className='w-full bg-background-default-base rounded-lg flex flex-col gap-5'>
      {/* Credits Info */}
      <div className='flex flex-col justify-between items-center gap-[8px]'>
        <div className='flex justify-between items-center w-full'>
          <span className='text-[14px] font-bold text-[#0D0D0D]'>{t('userCenter.modal.credits.credits')}</span>
          <span className='text-[14px] font-bold text-[#0D0D0D]'>{userInfo?.total_credits}</span>
        </div>

        <div className='flex justify-between items-center w-full text-xs font-bold text-[#B2B2B2]'>
          <div className='flex items-center gap-2'>
            <div className='w-1 h-1 rounded-full bg-[#B2B2B2]'></div>
            {t('userCenter.modal.credits.freeCredits')}
          </div>
          <span>{userInfo?.free_credits ?? 0}</span>
        </div>
        <div className='flex justify-between items-center w-full text-xs font-bold text-[#B2B2B2]'>
          <div className='flex items-center gap-2'>
            <div className='w-1 h-1 rounded-full bg-[#B2B2B2]'></div>
            {t('userCenter.modal.credits.purchaseCredits')}
          </div>
          <span>{userInfo?.purchase_credits ?? 0}</span>
        </div>
      </div>
      {/* Purchase Button */}
      <Button
        type='dark'
        shape='round'
        bordered={false}
        block
        className='h-[36px]'
        onClick={handlePurchaseClick}
      >
        {t('userCenter.modal.credits.buyBtn')}
      </Button>
    </div>
  );

  const items: MenuItemType[] = [
    {
      key: 'upgrade-info',
      label: dropdownContent,
    },
  ];

  const credits = userInfo?.total_credits ?? 0;

  return (
    <Dropdown
      items={items}
      trigger='click'
      placement='bottom-end'
      open={visible}
      onOpenChange={setVisible}
      popupClassName='p-[16px] w-[280px]'
      itemClassName='p-0 hover:bg-transparent cursor-default'
      popupRender={(menu) => <div>{menu}</div>}
    >
      <Button
        type='dark'
        shape='round'
        bordered={false}
      >
        <div className='flex justify-center items-center gap-2'>
          {!hideTitleText && (
            <div className='text-center justify-start text-solid text-xs font-bold leading-4'>
              {t('userCenter.modal.credits.title')}
            </div>
          )}
          {!hideTitleText && <div className='w-[1px] h-5 bg-border-default-base'></div>}
          <div className='w-5 h-5 relative overflow-hidden'>
            <Icon name='userCenter-coin-money-credit' height={20} width={20} />
          </div>
          <div className='text-center justify-start text-solid text-xs font-bold leading-4'>{credits.toLocaleString()}</div>
        </div>
      </Button>
    </Dropdown>
  );
};

export default memo(UpgradeButton);