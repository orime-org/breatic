import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';

export interface EmptyChatRecordStateProps {
  userName?: string;
  onExploreMoreClick?: () => void;
}

const SuggestionChip: React.FC<{ label: string }> = ({ label }) => (
  <button
    type='button'
    className='h-[28px] px-[12px] py-[2px] rounded-full border border-border-default-base text-[13px] text-text-default-secondary bg-background-default-base hover:bg-background-default-base-hover whitespace-nowrap'
  >
    {label}
  </button>
);

const EmptyChatRecordState: React.FC<EmptyChatRecordStateProps> = ({
  userName = 'user_133424',
  onExploreMoreClick,
}) => {
  const { t } = useTranslation();

  return (
    <div className='flex-1 flex items-center justify-center py-10'>
      <div className='w-full max-w-[560px] px-6 flex flex-col items-center text-center'>
        <div className='text-xl text-text-default-base'>
          {t('project.chatRecord.hiUser', `Hi, ${userName}`)}
        </div>
        <div className='text-xl text-text-default-base'>
          {t('project.chatRecord.helpQuestion', 'what can I help you today?')}
        </div>

        <div className='mt-6 flex flex-col gap-2'>
          <div className='flex items-center justify-center gap-[10px]'>
            <SuggestionChip label='Seeking inspiration' />
            <SuggestionChip label='Text-to-Image' />
          </div>
          <div className='flex items-center justify-center gap-[10px]'>
            <SuggestionChip label='Image Editing' />
            <SuggestionChip label='Creating a film storyboard' />
          </div>
          <div className='flex items-center justify-center gap-[10px]'>
            <SuggestionChip label='Creating Character Portraits' />
            <SuggestionChip label='Image Fusion' />
          </div>
        </div>

        <button
          type='button'
          onClick={onExploreMoreClick}
          className='mt-5 text-[13px] text-background-success-secondary underline underline-offset-2 hover:opacity-90 whitespace-nowrap inline-block'
        >
          {t('project.chatRecord.exploreMore', 'Click here to explore more possibilities')}
        </button>
      </div>
    </div>
  );
};

export default memo(EmptyChatRecordState);

