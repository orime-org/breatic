import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import aspectRatioIconMap from '@/apps/project/constants/aspectRatioIconMap';

interface RatioMenuProps {
  onRatioChange: (ratio: string) => void;
  selectedRatio: string;
}

/* * * RatioMenu component - canvasratio */
const RatioMenu: React.FC<RatioMenuProps> = ({ onRatioChange, selectedRatio }) => {
  const { t } = useTranslation();

  const handleRatioClick = (ratio: string) => {
    onRatioChange(ratio);
  };

  // canvasratio
  const menuItems = [
    {
      key: '16:9',
      label: (
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <div className='flex items-center justify-center bg-[#e5e7eb] rounded p-1'>
              <Icon
                name={aspectRatioIconMap['16:9']}
                width={20}
                height={20}
              />
            </div>
            <span className='text-text-default-tertiary'>{t('canvas.ratio169')}</span>
          </div>
          <span className='text-xs text-text-default-tertiary'>{t('canvas.youtube')}</span>
        </div>
      ),
      ratio: '16:9' as const,
    },
    {
      key: '9:16',
      label: (
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <div className='flex items-center justify-center bg-[#e5e7eb] rounded p-1'>
              <Icon
                name={aspectRatioIconMap['9:16']}
                width={20}
                height={20}
              />
            </div>
            <span className='text-text-default-tertiary'>{t('canvas.ratio916')}</span>
          </div>
          <span className='text-xs text-text-default-tertiary'>{t('canvas.tiktok')}</span>
        </div>
      ),
      ratio: '9:16' as const,
    },
    {
      key: '1:1',
      label: (
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <div className='flex items-center justify-center bg-[#e5e7eb] rounded p-1'>
              <Icon
                name={aspectRatioIconMap['1:1']}
                width={20}
                height={20}
              />
            </div>
            <span className='text-text-default-tertiary'>{t('canvas.ratio11')}</span>
          </div>
          <span className='text-xs text-text-default-tertiary'>{t('canvas.instagram')}</span>
        </div>
      ),
      ratio: '1:1' as const,
    },
  ];

  return (
    <div className='mt-2 flex flex-col gap-2.5'>
      {menuItems.map((item) => (
        <div
          key={item.key}
          className={`flex items-center text-xs cursor-pointer rounded px-1.5 py-1 ${
            selectedRatio === item.ratio ? 'bg-background-default-secondary' : 'hover:bg-background-default-secondary'
          }`}
          onClick={() => handleRatioClick(item.ratio)}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
};

export default memo(RatioMenu);

