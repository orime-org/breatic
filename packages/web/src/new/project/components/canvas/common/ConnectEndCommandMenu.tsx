import React, { useEffect, useRef } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { Icon } from '@/components/base/icon';
import nodeIconMap from '@/new/project/constants/nodeIconMap';

const agentNodes = [
  { type: '1001', label: 'Text' },
  { type: '1002', label: 'Image' },
  { type: '1003', label: 'Video' },
  { type: '1004', label: 'Audio' },
] as const;

const getNodeSubtitle = (templateType: string): string => {
  switch (templateType) {
    case '1001':
      return 'Loads/Creates text content';
    case '1002':
      return 'Loads/Generates images';
    case '1003':
      return 'Loads/Generates video clips';
    case '1004':
      return 'Loads/Creates audio content';
    default:
      return '';
  }
};

export interface ConnectEndCommandMenuProps {
  open: boolean;
  left: number;
  top: number;
  anchorSide?: 'output' | 'input';
  onSelect: (nodeType: string) => void;
  onClose: () => void;
  onPanelPositionChange?: (x: number, y: number, isFromInput: boolean) => void;
}

const ConnectEndCommandMenu: React.FC<ConnectEndCommandMenuProps> = ({
  open,
  left,
  top,
  anchorSide = 'output',
  onSelect,
  onClose,
  onPanelPositionChange,
}) => {
  const floatingRef = useRef<HTMLDivElement>(null);
  const virtualRef = useRef({
    getBoundingClientRect: (): DOMRect => new DOMRect(left, top, 0, 0),
  });

  const isFromInput = anchorSide === 'input';

  const { refs, floatingStyles, context, placement } = useFloating({
    open,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) onClose();
    },
    placement: isFromInput ? 'bottom-end' : 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(0), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const dismiss = useDismiss(context, { outsidePress: true });
  const { getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    virtualRef.current.getBoundingClientRect = () => new DOMRect(left, top, 0, 0);
    refs.setReference(virtualRef.current);
  }, [open, left, top, refs]);

  useEffect(() => {
    if (!open || !onPanelPositionChange) return;
    const raf = requestAnimationFrame(() => {
      const el = floatingRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const isTop = placement.startsWith('top');
        const anchorY = isTop ? rect.bottom : rect.top;
        const x = isFromInput ? rect.right : rect.left;
        onPanelPositionChange(x, anchorY, isFromInput);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, placement, onPanelPositionChange, isFromInput]);

  if (!open) return null;

  const menu = (
    <div
      ref={(el) => {
        refs.setFloating(el);
        floatingRef.current = el;
      }}
      style={floatingStyles}
      className='z-[1000] min-w-[220px] rounded-[8px] bg-[var(--color-background-default-base)] p-2 shadow-lg'
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid='connect-end-command-menu'
      {...getFloatingProps()}
    >
      <div className='mb-2 px-2 text-xs font-medium text-text-default-base'>Agent Nodes</div>
      <div className='flex flex-col gap-0.5'>
        {agentNodes.map((asset) => {
          const iconName = nodeIconMap[asset.type];
          return (
            <div
              key={asset.type}
              role='button'
              className='flex min-h-9 w-full cursor-pointer items-center gap-3 rounded-[4px] px-2 py-1.5 text-left transition-colors hover:bg-background-default-secondary'
              onClick={() => onSelect(asset.type)}
            >
              {iconName ? (
                <Icon name={iconName} width={20} height={20} color='var(--color-icon-base)' />
              ) : null}
              <div className='flex min-w-0 flex-1 flex-col justify-center'>
                <span className='truncate text-xs font-medium leading-4 text-text-default-base'>{asset.label}</span>
                <span className='truncate text-[10px] leading-3 text-text-default-tertiary'>
                  {getNodeSubtitle(asset.type)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return <FloatingPortal>{menu}</FloatingPortal>;
};

export default ConnectEndCommandMenu;
