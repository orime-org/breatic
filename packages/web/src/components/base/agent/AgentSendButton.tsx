import React from 'react';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import AgentModelSelect from './AgentModelSelect';
import { Agent } from './Agent';

type AgentSendButtonProps = {
  /** When true, only the rightmost send button is disabled; Agent and model controls stay usable. */
  disabled?: boolean;
  onClick?: () => void;
  modelValue?: string;
  qualityValue?: string;
  aspectValue?: string;
  onModelChange?: (id: string, label: string) => void;
  onQualityChange?: (value: string) => void;
  onAspectChange?: (value: string) => void;
};

const AgentSendButton: React.FC<AgentSendButtonProps> = ({
  disabled = false,
  onClick,
  modelValue,
  qualityValue,
  aspectValue,
  onModelChange,
  onQualityChange,
  onAspectChange,
}) => (
  <div className='flex w-full items-center gap-2 justify-between'>
    <div className='flex-none'>
      <Agent />
    </div>
    <div className='flex-none flex items-center gap-2 justify-end'>
      <AgentModelSelect
        value={modelValue}
        qualityValue={qualityValue}
        aspectValue={aspectValue}
        onChange={onModelChange}
        onQualityChange={onQualityChange}
        onAspectChange={onAspectChange}
      />
      <div className='flex h-[28px] items-center gap-1 text-text-disabled-base text-xs font-bold'>
        <Icon name='imageEditor-nano-banana-credit-icon' width={18} height={18} />
        <span>120</span>
      </div>
      <Button
        type='primary'
        size='medium'
        shape='round'
        disabled={disabled}
        icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
        onClick={onClick}
        className='!h-[28px] w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
      />
    </div>
  </div>
);

export default AgentSendButton;
