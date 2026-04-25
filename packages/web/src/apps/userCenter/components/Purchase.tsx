import React, { memo, useState } from 'react';
import { message } from '@/components/base/message';
import { Button } from '@/components/base/button';
import { useTranslation } from 'react-i18next';
import { CreditsItemType } from '../types';

/** Static bundles (replaces `/api/plan/credit/list`). */
const DEMO_CREDITS: CreditsItemType[] = [
  {
    id: 1,
    name: 'Starter credits',
    code: 'demo-starter',
    icon: null,
    price: 9.99,
    addonType: 'one_time',
    isFirstRecharge: false,
    addonValue: 1000,
    description: 'Demo pack',
  },
  {
    id: 2,
    name: 'Pro credits',
    code: 'demo-pro',
    icon: null,
    price: 49,
    addonType: 'one_time',
    isFirstRecharge: false,
    addonValue: 6000,
    description: 'Demo pack',
  },
];

const Purchase: React.FC = () => {
  const { t } = useTranslation();
  const [creditsItemList] = useState<CreditsItemType[]>(DEMO_CREDITS);
  const [loading] = useState(false);

  const handlePurchaseCredits = (itemId: number, amount: number) => {
    message.info(t('userCenter.modal.purchase.description'));
    void itemId;
    void amount;
  };

  return (
    <div className='flex flex-col select-none'>
      <div className='flex flex-col items-center w-full px-[6px] py-[24px] gap-3 overflow-y-auto'>
        {/* Purchase credits title and reminder */}
        <div className='flex flex-col items-center w-full gap-[6px]'>
          <div className='text-3xl font-medium leading-9 text-text-default-base'>{t('userCenter.modal.purchase.title')}</div>
          <div className='text-[10px] font-bold leading-3 text-text-default-secondary'>
            {t('userCenter.modal.purchase.description')}
          </div>
        </div>
        {/* Credits items grid */}
        <div className='grid grid-cols-3 gap-3'>
          {Array.isArray(creditsItemList) &&
            creditsItemList.length > 0 &&
            creditsItemList.map((item: CreditsItemType, index: number) => (
              <div
                key={`${item.code}-${item.id}-${index}`}
                className='flex flex-col items-center justify-center rounded-[8px] p-6 gap-3 bg-background-default-secondary cursor-pointer hover:bg-[#E6E6E6] h-[144px]'
              >
                <div className='flex flex-col items-center justify-center w-[150px]'>
                  <div className='text-4xl font-bold text-text-default-base leading-10'>
                    ${item.price}
                  </div>
                  <div className='text-sm font-medium text-text-default-base leading-5'>{item.name}</div>
                </div>
                <div className='flex w-full items-center justify-center'>
                  <Button
                    type='dark'
                    shape='round'
                    bordered={false}
                    onClick={() => handlePurchaseCredits(item.id, Number(item.price))}
                  >
                    {t('userCenter.modal.purchase.buy')}
                  </Button>
                </div>
              </div>
            ))}
          {loading && (
            <>
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={`skeleton-${index}`}
                  className='flex flex-col items-center justify-center rounded-[8px] p-6 gap-3 bg-background-default-secondary relative overflow-hidden h-[144px]'
                >
                  <div className='flex flex-col items-center justify-center w-[150px] gap-2'>
                    <div className='w-24 h-10 bg-background-neutral-secondary rounded relative overflow-hidden'>
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer'></div>
                    </div>
                    <div className='w-20 h-5 bg-background-neutral-secondary rounded relative overflow-hidden'>
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer' style={{ animationDelay: '0.1s' }}></div>
                    </div>
                  </div>
                  <div className='flex w-full items-center justify-center'>
                    <div className='w-[80px] h-[24px] rounded-full bg-background-neutral-secondary relative overflow-hidden'>
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer' style={{ animationDelay: '0.2s' }}></div>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Free credits info */}
      <div className='w-full flex justify-center text-[10px] font-bold text-text-default-secondary text-left leading-3'>
        {t('userCenter.modal.purchase.info')}
      </div>
    </div>
  );
};

export default memo(Purchase);
