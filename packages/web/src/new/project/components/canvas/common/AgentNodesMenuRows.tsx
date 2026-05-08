import React from 'react';
import { Icon } from '@/components/base/icon';
import nodeIconMap from '@/new/project/constants/nodeIconMap';
import { getLocalFlowNodeSubtitle, localFlowAgentNodes } from './localFlowNodeSpawn';
import { useAgentNodesKeyboardShortcuts } from './useAgentNodesKeyboardShortcuts';

export interface AgentNodesMenuRowsProps {
  onSelectType: (nodeType: string) => void;
  /** When true, Q/W/E/R keys invoke {@link onSelectType} without clicking. */
  keyboardActive: boolean;
}

/**
 * Shared “Agent Nodes” menu rows: icon, labels, and right-aligned shortcut hints (Q/W/E/R).
 */
const AgentNodesMenuRows: React.FC<AgentNodesMenuRowsProps> = ({ onSelectType, keyboardActive }) => {
  useAgentNodesKeyboardShortcuts(keyboardActive, onSelectType);

  return (
    <div className='flex flex-col gap-0.5'>
      {localFlowAgentNodes.map((asset) => {
        const iconName = nodeIconMap[asset.type];
        return (
          <div
            key={asset.type}
            role='button'
            className='flex min-h-9 w-full cursor-pointer items-center gap-3 rounded-[4px] px-2 py-1.5 text-left transition-colors hover:bg-background-default-secondary'
            onClick={() => onSelectType(asset.type)}
          >
            {iconName ? <Icon name={iconName} width={20} height={20} color='var(--color-icon-base)' /> : null}
            <div className='flex min-w-0 flex-1 flex-col justify-center'>
              <span className='truncate text-xs font-medium leading-4 text-text-default-base'>{asset.label}</span>
              <span className='truncate text-[10px] leading-3 text-text-default-tertiary'>
                {getLocalFlowNodeSubtitle(asset.type)}
              </span>
            </div>
            <span className='shrink-0 tabular-nums text-[10px] font-medium text-content-tertiary'>{asset.shortcut}</span>
          </div>
        );
      })}
    </div>
  );
};

export default AgentNodesMenuRows;
