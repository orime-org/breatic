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
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import nodeIconMap from '@/pages/project/constants/nodeIconMap';

/** Selectable node types (aligned with DataNodeHandle). */
const agentNodes = [
  { type: '1001', labelKey: 'canvas.handle.nodeText' },
  { type: '1002', labelKey: 'canvas.handle.nodeImage' },
  { type: '1003', labelKey: 'canvas.handle.nodeVideo' },
  { type: '1004', labelKey: 'canvas.handle.nodeAudio' },
] as const;

const getNodeSubtitle = (templateType: string, t: (key: string) => string): string => {
  switch (templateType) {
    case '1001':
      return t('canvas.handle.subtitleText');
    case '1002':
      return t('canvas.handle.subtitleImage');
    case '1003':
      return t('canvas.handle.subtitleVideo');
    case '1004':
      return t('canvas.handle.subtitleAudio');
    default:
      return '';
  }
};

export interface ConnectEndCommandMenuProps {
  open: boolean;
  /** Anchor screen position: output aligns panel top-left; input aligns panel top-right. */
  left: number;
  top: number;
  /** output: dragged from source handle (anchor on left). input: dragged from target handle (anchor on right). */
  anchorSide?: 'output' | 'input';
  onSelect: (nodeType: string) => void;
  onClose: () => void;
  /** Callback after panel position resolves: output -> (left, anchorY), input -> (right, anchorY). */
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
  const { t } = useTranslation();
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
    middleware: [
      offset(0),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  const dismiss = useDismiss(context, { outsidePress: true });
  const { getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    virtualRef.current.getBoundingClientRect = () => new DOMRect(left, top, 0, 0);
    refs.setReference(virtualRef.current);
  }, [open, left, top, refs]);

  // Notify parent after panel positioning: output uses rect.left, input uses rect.right.
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
      ref={(el) => { refs.setFloating(el); floatingRef.current = el; }}
      style={floatingStyles}
      className='z-[1000] min-w-[220px] rounded-[8px] bg-[var(--color-background-default-base)] p-2 shadow-lg'
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid='connect-end-command-menu'
      {...getFloatingProps()}
    >
      <div className='text-xs font-medium text-text-default-base mb-2 px-2'>{t('canvas.handle.agentNodes')}</div>
      <div className='flex flex-col gap-0.5'>
        {agentNodes.map((asset) => {
          const iconName = nodeIconMap[asset.type];
          return (
            <div
              key={asset.type}
              role='button'
              className='flex w-full min-h-9 items-center gap-3 rounded-[4px] px-2 py-1.5 text-left cursor-pointer hover:bg-background-default-secondary transition-colors'
              onClick={() => onSelect(asset.type)}
            >
              {iconName && (
                <Icon
                  name={iconName}
                  width={20}
                  height={20}
                  color='var(--color-icon-base)'
                />
              )}
              <div className='flex flex-col justify-center min-w-0 flex-1'>
                <span className='text-xs font-medium leading-4 text-text-default-base truncate'>
                  {t(asset.labelKey)}
                </span>
                <span className='text-[10px] leading-3 text-text-default-tertiary truncate'>
                  {getNodeSubtitle(asset.type, t)}
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
