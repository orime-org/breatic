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
import AgentNodesMenuRows from '@/new/project/components/canvas/common/AgentNodesMenuRows';

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
      className='z-[1000] min-w-[260px] rounded-[8px] bg-[var(--color-background-default-base)] p-2 shadow-lg'
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid='connect-end-command-menu'
      {...getFloatingProps()}
    >
      <div className='text-xs font-medium text-text-default-base mb-2 px-2'>Agent Nodes</div>
      <AgentNodesMenuRows keyboardActive={open} onSelectType={onSelect} />
    </div>
  );

  return <FloatingPortal>{menu}</FloatingPortal>;
};

export default ConnectEndCommandMenu;
