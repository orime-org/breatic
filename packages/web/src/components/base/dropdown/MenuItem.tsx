import type { FC, ReactNode } from 'react';
import { useCallback } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useHover,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { Icon } from '@/components/base/icon';
import { cn } from '@/utils/classnames';

export type MenuItemType = {
  key: string;
  label: ReactNode;
  disabled?: boolean;
  children?: MenuItemType[];
  type?: 'divider';
  /** Hover/click behavior; default true */
  interactive?: boolean;
};

export type MenuItemProps = {
  item: MenuItemType;
  selectedKeys?: string[];
  onClick?: (key: string, item: MenuItemType) => void;
  expandIcon?: ReactNode;
  itemClassName?: string;
  onSubMenuOpenChange?: (key: string, open: boolean) => void;
  activeSubMenuKey?: string | null;
};

/** One menu row; optional nested submenu. */
const MenuItem: FC<MenuItemProps> = ({
  item,
  selectedKeys = [],
  onClick,
  expandIcon,
  itemClassName,
  onSubMenuOpenChange,
  activeSubMenuKey,
}) => {
  const hasChildren = item.children && item.children.length > 0;
  const isSelected = selectedKeys.includes(item.key);
  const isInteractive = item.interactive !== false;
  const isSubMenuOpen = activeSubMenuKey === item.key;

  const { refs, floatingStyles, context } = useFloating({
    open: isSubMenuOpen,
    onOpenChange: (open) => onSubMenuOpenChange?.(item.key, open),
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(25),
      flip({
        padding: 5,
      }),
      shift({ padding: 5 }),
    ],
  });

  const hover = useHover(context, {
    enabled: hasChildren && !item.disabled,
    move: true,
    delay: {
      open: 0,
      close: 100,
    },
  });

  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, dismiss]);

  const handleClick = useCallback(() => {
    if (!isInteractive || item.disabled) return;
    if (!hasChildren && onClick) {
      onClick(item.key, item);
    }
  }, [isInteractive, item, hasChildren, onClick]);

  const handleMouseEnter = useCallback(() => {
    if (hasChildren && !item.disabled) {
      onSubMenuOpenChange?.(item.key, true);
    }
  }, [hasChildren, item.disabled, item.key, onSubMenuOpenChange]);

  if (item.type === 'divider') {
    return (
      <div className='h-px bg-[var(--color-border-default-base)] my-1' role='separator' />
    );
  }

  return (
    <div className='relative'>
      <div
        ref={refs.setReference}
        {...getReferenceProps({
          onMouseEnter: handleMouseEnter,
          onClick: handleClick,
        })}
      >
        <div
          className={cn(
            'flex w-full h-auto min-h-8 items-center rounded-[4px] p-[4px] text-xs text-text-default-base',
            isInteractive ? 'cursor-pointer hover:bg-background-default-secondary' : 'cursor-default',
            item.disabled && 'opacity-50 cursor-not-allowed',
            isSelected && 'bg-background-default-secondary',
            itemClassName
          )}
        >
          <div className={cn('flex-1 flex w-full items-center justify-start', itemClassName?.includes('justify-center') && 'justify-center')}>
            {item.label}
          </div>
          {hasChildren && (
            <div className='ml-2 flex-shrink-0'>
              {expandIcon || (
                <Icon
                  name='base-chevron-right-icon'
                  width={5}
                  height={9}
                  color='var(--color-text-default-base)'
                />
              )}
            </div>
          )}
        </div>
      </div>
      {hasChildren && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{
              ...floatingStyles,
              visibility: isSubMenuOpen ? 'visible' : 'hidden',
              pointerEvents: isSubMenuOpen ? 'auto' : 'none',
            }}
            className='z-[1000]'
            {...getFloatingProps()}
          >
            <div
              className={cn(
                'rounded-[8px] border border-[var(--color-border-default-base)] bg-[var(--color-background-default-base)] p-2 min-w-[120px]',
                'shadow-[0px_0px_1px_1px_rgba(12,12,13,0.20)] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05)]',
                'focus:outline-none focus-visible:outline-none',
                'flex flex-col gap-1',
                isSubMenuOpen
                  ? 'opacity-100 translate-y-0'
                  : 'opacity-0 -translate-y-2'
              )}
              onMouseEnter={() => {
                onSubMenuOpenChange?.(item.key, true);
              }}
              onMouseLeave={() => {
                onSubMenuOpenChange?.(item.key, false);
              }}
            >
              {item.children!.map((child) => (
                <div
                  key={child.key}
                  onClick={() => {
                    if (!child.disabled && onClick) {
                      onClick(child.key, child);
                      onSubMenuOpenChange?.(item.key, false);
                    }
                  }}
                  className={cn(
                    'flex w-full h-auto min-h-8 cursor-pointer items-center rounded-[4px] px-2 text-sm text-text-default-base',
                    'hover:bg-background-default-secondary',
                    child.disabled && 'opacity-50 cursor-not-allowed',
                    selectedKeys.includes(child.key) && 'bg-background-default-secondary'
                  )}
                >
                  {child.label}
                </div>
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};

export default MenuItem;
