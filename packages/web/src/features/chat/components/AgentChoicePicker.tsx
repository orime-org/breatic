/**
 * AgentChoicePicker — render `ask_user_choice` tool calls (spec
 * §10.18.4 v13).
 *
 * One-shot selection: clicking a button promotes that option to
 * "selected" and disables the rest. The host owns the
 * `selectedId` state — typically per-message, persisted alongside
 * the assistant message so re-rendering the conversation shows
 * the user's prior choice frozen.
 *
 * Visual mockup: `2026-04-27-visual-language/05-canvas-native-tailwind.html`
 * line 1633.
 */
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/classnames';
import type {
  AgentChoiceOption,
  AgentToolArgsAskUserChoice,
} from './agent-tool-types';

interface AgentChoicePickerProps {
  args: AgentToolArgsAskUserChoice;
  /**
   * The id of the option that was already selected on this
   * message, if any. Locked once set — clicking again is a no-op
   * (the backend would reject re-selection too).
   */
  selectedId?: string;
  onSelect?: (option: AgentChoiceOption) => void;
}

const AgentChoicePicker: React.FC<AgentChoicePickerProps> = ({
  args,
  selectedId,
  onSelect,
}) => {
  const { t } = useTranslation();
  const isLocked = Boolean(selectedId);

  return (
    <div className='mt-2 rounded-md border border-border-default-secondary bg-background-default-secondary px-3 py-2.5'>
      <div className='mb-2 inline-flex items-center gap-1.5 text-[11px] font-mono text-text-default-tertiary'>
        <span className='rounded-sm bg-background-default-base px-1.5 py-px text-text-default-secondary'>
          ask_user_choice
        </span>
      </div>
      <div className='mb-2.5 text-[13px] font-medium text-text-default-primary'>
        {args.question}
      </div>
      <div className='space-y-1.5'>
        {args.choices.map((c) => {
          const isSelected = selectedId === c.id;
          const isDisabled = isLocked && !isSelected;
          return (
            <button
              key={c.id}
              type='button'
              aria-pressed={isSelected}
              disabled={isDisabled}
              onClick={() => !isLocked && onSelect?.(c)}
              className={cn(
                'w-full rounded border px-2.5 py-2 text-left transition-all',
                isSelected
                  ? 'border-status-selected bg-status-selected/10 text-status-selected'
                  : isDisabled
                    ? 'cursor-not-allowed border-border-default-secondary bg-background-default-base text-text-default-tertiary'
                    : 'border-border-default-secondary bg-background-default-base text-text-default-primary hover:border-status-selected hover:bg-status-selected/5',
              )}
            >
              <div className='text-[12px] font-medium'>{c.label}</div>
              {c.description && (
                <div className='mt-0.5 text-[10px] text-text-default-tertiary'>
                  {c.description}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {isLocked && (
        <div className='mt-2 text-[10px] font-mono text-text-default-tertiary'>
          {t('canvas.chat.choiceLocked', { defaultValue: '已选定,无法更改' })}
        </div>
      )}
    </div>
  );
};

export default memo(AgentChoicePicker);
