/**
 * AgentToolMessage — single dispatcher that switches on
 * `toolCall.name` and renders the right `AgentChoicePicker` /
 * `AgentSearchResultsGrid` / `AgentCanvasActionButton`.
 *
 * Why a dispatcher instead of letting the host switch: keeps the
 * "what tool calls do we render?" knowledge in one place. When a
 * fourth tool joins (B4 already permits the shape) only this file
 * needs a new branch + the host gets it for free.
 *
 * Unknown tool names render an inline neutral fallback rather than
 * crashing — protects the chat stream from agent-side schema drift.
 */
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import AgentChoicePicker from './AgentChoicePicker';
import AgentSearchResultsGrid from './AgentSearchResultsGrid';
import AgentCanvasActionButton from './AgentCanvasActionButton';
import type {
  AgentChoiceOption,
  AgentSearchHit,
  AgentToolCall,
} from './agent-tool-types';

interface AgentToolMessageProps {
  toolCall: AgentToolCall;
  /** State: which choice the user already picked, if any. Per-message. */
  selectedChoiceId?: string;
  /** State: whether the canvas-action proposal was already applied. Per-message. */
  applied?: boolean;
  /** Handlers — ignored when the tool name doesn't match the handler. */
  onSelectChoice?: (option: AgentChoiceOption) => void;
  onAddSearchHit?: (hit: AgentSearchHit) => void;
  onApplyCanvasAction?: () => void;
}

const AgentToolMessage: React.FC<AgentToolMessageProps> = ({
  toolCall,
  selectedChoiceId,
  applied,
  onSelectChoice,
  onAddSearchHit,
  onApplyCanvasAction,
}) => {
  const { t } = useTranslation();

  switch (toolCall.name) {
    case 'ask_user_choice':
      return (
        <AgentChoicePicker
          args={toolCall.args}
          selectedId={selectedChoiceId}
          onSelect={onSelectChoice}
        />
      );
    case 'show_search_results':
      return (
        <AgentSearchResultsGrid
          args={toolCall.args}
          onAddToSpace={onAddSearchHit}
        />
      );
    case 'propose_canvas_action':
      return (
        <AgentCanvasActionButton
          args={toolCall.args}
          applied={applied}
          onApply={onApplyCanvasAction}
        />
      );
    default: {
      // `never` exhaustiveness check — TypeScript will complain
      // when a new variant lands in `AgentToolCall` and isn't
      // mapped above.
      const _exhaustive: never = toolCall;
      void _exhaustive;
      return (
        <div className='mt-2 rounded-md border border-border-default-secondary bg-background-default-secondary px-3 py-2 text-[11px] font-mono text-text-default-tertiary'>
          {t('canvas.chat.unknownTool', {
            defaultValue: '未识别的 agent 工具调用',
          })}
        </div>
      );
    }
  }
};

export default memo(AgentToolMessage);
