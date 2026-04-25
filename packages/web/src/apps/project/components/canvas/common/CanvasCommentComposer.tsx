import React, { memo, useCallback, useState } from 'react';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';

interface CanvasCommentComposerProps {
  x: number;
  y: number;
  onCancel: () => void;
  onSend: (text: string) => void;
}

const CanvasCommentComposer: React.FC<CanvasCommentComposerProps> = ({ x, y, onCancel, onSend }) => {
  const maxChars = 200;
  const [value, setValue] = useState('');
  const charCount = value.length;
  const canSend = value.trim().length > 0;

  const handleSend = useCallback(() => {
    const next = value.trim();
    if (!next) return;
    onSend(next);
    setValue('');
    onCancel();
  }, [onCancel, onSend, value]);

  const handleTextareaKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend, onCancel],
  );

  return (
    <div
      className='fixed z-[60] w-[430px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
      style={{ left: x, top: y }}
    >
      <div className='relative rounded-[8px] border-none bg-background-default-secondary px-2 py-1.5'>
        <textarea
          autoFocus
          rows={2}
          value={value}
          maxLength={maxChars}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          placeholder='输入你的评论...'
          className='h-[96px] w-full resize-none border-none bg-transparent px-0 pt-0 text-[13px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
        />
        <div className='pointer-events-auto absolute bottom-[6px] right-[2px] flex items-center gap-2 pr-2'>
          <span className='text-[12px] font-semibold text-text-default-tertiary'>
            {charCount}/{maxChars}
          </span>
          <Button
            type='primary'
            size='medium'
            shape='round'
            disabled={!canSend}
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={handleSend}
            className='!h-[28px] w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
            aria-label='Send comment'
          />
        </div>
      </div>
    </div>
  );
};

export default memo(CanvasCommentComposer);
