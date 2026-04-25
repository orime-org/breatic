import type { OffsetOptions, Placement } from '@floating-ui/react';
import {
  FloatingPortal,
  useFloating,
  useInteractions,
  useHover,
  useClick,
  useDismiss,
  offset,
  autoUpdate,
  flip,
  shift,
  arrow,
} from '@floating-ui/react';
import type { FC, ReactNode } from 'react';
import { useBoolean } from 'ahooks';
import * as React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/utils/classnames';
import { tooltipManager } from './TooltipManager';

const getArrowStyle = (placement: Placement, arrowData: { x?: number; y?: number } | null) => {
  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    width: '8px',
    height: '8px',
  };

  if (!arrowData) {
    return baseStyle;
  }

  if (placement.startsWith('top')) {
    return {
      ...baseStyle,
      bottom: '-4px',
      left: arrowData.x != null ? `${arrowData.x}px` : '50%',
      transform: 'translateX(-50%) rotate(45deg)',
      backgroundColor: 'var(--color-background-neutral-base)',
    };
  }
  if (placement.startsWith('bottom')) {
    return {
      ...baseStyle,
      top: '-4px',
      left: arrowData.x != null ? `${arrowData.x}px` : '50%',
      transform: 'translateX(-50%) rotate(45deg)',
      backgroundColor: 'var(--color-background-neutral-base)',
    };
  }
  if (placement.startsWith('left')) {
    return {
      ...baseStyle,
      right: '-4px',
      top: arrowData.y != null ? `${arrowData.y}px` : '50%',
      transform: 'translateY(-50%) rotate(45deg)',
      backgroundColor: 'var(--color-background-neutral-base)',
    };
  }
  if (placement.startsWith('right')) {
    return {
      ...baseStyle,
      left: '-4px',
      top: arrowData.y != null ? `${arrowData.y}px` : '50%',
      transform: 'translateY(-50%) rotate(45deg)',
      backgroundColor: 'var(--color-background-neutral-base)',
    };
  }

  return baseStyle;
};

export type TooltipProps = {
  title?: ReactNode;
  placement?: Placement;
  trigger?: 'hover' | 'click';
  disabled?: boolean;
  triggerClassName?: string;
  popupClassName?: string;
  offset?: OffsetOptions;
  /** Hover: delay before close when pointer leaves */
  needsDelay?: boolean;
  /** Inline-block wrapper when true */
  asChild?: boolean;
  children: ReactNode;
};

const Tooltip: FC<TooltipProps> = ({
  placement = 'top',
  trigger = 'hover',
  disabled = false,
  title,
  children,
  triggerClassName,
  popupClassName,
  offset: offsetValue = 8,
  asChild = true,
  needsDelay = true,
}) => {
  const [open, setOpen] = React.useState(false);

  const [isHoverPopup, { setTrue: setHoverPopup, setFalse: setNotHoverPopup }] = useBoolean(false);
  const isHoverPopupRef = useRef(isHoverPopup);
  useEffect(() => {
    isHoverPopupRef.current = isHoverPopup;
  }, [isHoverPopup]);

  const [isHoverTrigger, { setTrue: setHoverTrigger, setFalse: setNotHoverTrigger }] = useBoolean(false);
  const isHoverTriggerRef = useRef(isHoverTrigger);
  useEffect(() => {
    isHoverTriggerRef.current = isHoverTrigger;
  }, [isHoverTrigger]);

  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearCloseTimeout();
    };
  }, [clearCloseTimeout]);

  const close = useCallback(() => setOpen(false), []);

  const handleLeave = useCallback(
    (isTrigger: boolean) => {
      if (isTrigger) setNotHoverTrigger();
      else setNotHoverPopup();

      // give time to move to the popup
      if (needsDelay) {
        clearCloseTimeout();
        closeTimeoutRef.current = setTimeout(() => {
          closeTimeoutRef.current = null;
          if (!isHoverPopupRef.current && !isHoverTriggerRef.current) {
            setOpen(false);
            tooltipManager.clear(close);
          }
        }, 300);
      } else {
        clearCloseTimeout();
        setOpen(false);
        tooltipManager.clear(close);
      }
    },
    [needsDelay, clearCloseTimeout, close, setNotHoverTrigger, setNotHoverPopup]
  );

  const arrowRef = useRef<HTMLDivElement | null>(null);

  let computedOffset: OffsetOptions;
  if (typeof offsetValue === 'number') {
    computedOffset = offsetValue + 4;
  } else if (typeof offsetValue === 'object' && offsetValue !== null) {
    computedOffset = {
      mainAxis: ((offsetValue as { mainAxis?: number }).mainAxis ?? 8) + 4,
      crossAxis: (offsetValue as { crossAxis?: number }).crossAxis,
    };
  } else {
    computedOffset = 12;
  }

  const { refs, floatingStyles, context, middlewareData } = useFloating({
    open: disabled ? false : open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(computedOffset),
      flip(),
      shift({ padding: 8 }),
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    enabled: trigger === 'hover' && !disabled,
  });

  const click = useClick(context, {
    enabled: trigger === 'click' && !disabled,
  });

  const dismiss = useDismiss(context);

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, click, dismiss]);

  const handleMouseEnter = useCallback(() => {
    if (trigger === 'hover' && !disabled) {
      clearCloseTimeout();
      setHoverTrigger();
      tooltipManager.register(close);
      setOpen(true);
    }
  }, [trigger, disabled, clearCloseTimeout, setHoverTrigger, close]);

  const handleMouseLeave = useCallback(() => {
    if (trigger === 'hover') {
      handleLeave(true);
    }
  }, [trigger, handleLeave]);

  const handleClick = useCallback(() => {
    if (trigger === 'click' && !disabled) {
      setOpen((v) => !v);
    }
  }, [trigger, disabled]);

  const handlePopupMouseEnter = useCallback(() => {
    if (trigger === 'hover') {
      clearCloseTimeout();
      setHoverPopup();
    }
  }, [trigger, clearCloseTimeout, setHoverPopup]);

  const handlePopupMouseLeave = useCallback(() => {
    if (trigger === 'hover') {
      handleLeave(false);
    }
  }, [trigger, handleLeave]);

  if (!title) {
    return <>{children}</>;
  }

  const triggerElement = (
    <div
      {...getReferenceProps()}
      ref={refs.setReference}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={triggerClassName}
      style={asChild ? { display: 'inline-block' } : undefined}
    >
      {children}
    </div>
  );

  return (
    <>
      {triggerElement}
      {!disabled && open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className={cn('z-[1000]', popupClassName)}
            onMouseEnter={handlePopupMouseEnter}
            onMouseLeave={handlePopupMouseLeave}
          >
            <div
              className={cn(
                'relative w-auto break-words rounded-lg bg-[var(--color-background-neutral-base)] px-3 py-2 text-left text-sm text-[var(--color-text-disabled-secondary)] shadow-lg',
                popupClassName
              )}
            >
              {title}
              {middlewareData.arrow && (
                <div
                  ref={arrowRef}
                  style={getArrowStyle(context.placement, middlewareData.arrow)}
                />
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export default React.memo(Tooltip);
