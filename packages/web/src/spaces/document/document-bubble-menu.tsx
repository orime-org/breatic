// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 浮出条上一个下拉的外壳：悬停展开，点击也能开。
 *
 * 条上四个格位（块类型 · 对齐 · 颜色 · AI）共用它，装什么由 children 决定。
 * 形态出自菜单体系定稿 §3.2.1（「形态照飞书：选中文字浮出一条，右侧那几个
 * 图标悬上去就在下方出一个下拉列表」），user 2026-08-26 把它铺到四格并定了
 * 五条规则：悬停打开 · 指针能从格子挪到菜单上去点 · 离开整片区域才关、格子
 * 还在 · 指针停在菜单上时正文滚不动 · 正文一旦真滚了菜单必须消失。
 *
 * 键盘不参与（user 2026-08-26）。焦点也不参与，见下。
 */

import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '@web/components/ui/dropdown-menu';

/**
 * 指针离开之后，菜单还留多久。
 *
 * WCAG 2.1 SC 1.4.13 的 Hoverable 要求指针从格子挪到菜单的途中菜单不能消失，
 * 而两者之间隔着 `sideOffset` 那道缝，穿过它的那一刻指针两边都不在。留一段
 * 时间让指针走完这段路，进了菜单就取消。Radix 自己的子菜单用同一个量级的
 * 数（`@radix-ui/react-menu` 的 `MenuSubTrigger` 里 100ms 开）。
 */
const CLOSE_GRACE_MS = 120;

interface DocumentBubbleMenuProps {
  /** 稳定 id，用来拼 test id。 */
  id: string;
  /** 格子本身长什么样。 */
  trigger: React.ReactNode;
  /** 菜单里装什么。 */
  children: React.ReactNode;
  /**
   * 菜单挂在哪个元素里。
   *
   * 传浮出条自己。菜单 portal 到 `body` 的话，条判断自己该不该留在屏幕上时
   * 会发现焦点跑到了别处，于是把自己收走、菜单跟着消失（定稿 §5.1 第二条）。
   */
  container: HTMLElement | null;
  /** 正文的滚动容器，用来在它真的滚动时关掉菜单。 */
  scroller: HTMLElement | null;
  /** 这一格现在开着吗。开合由条统一持有，一次只开一个。 */
  open: boolean;
  /** 要开或要关。 */
  onOpenChange: (open: boolean) => void;
}

/**
 * 一个悬停展开的下拉。
 * @param props - 见 {@link DocumentBubbleMenuProps}。
 * @param props.id - 稳定 id，用来拼 test id。
 * @param props.trigger - 格子本身长什么样。
 * @param props.children - 菜单里装什么。
 * @param props.container - 菜单挂在哪个元素里。
 * @param props.scroller - 正文的滚动容器。
 * @param props.open - 这一格现在开着吗。
 * @param props.onOpenChange - 要开或要关。
 * @returns 格子加它的菜单。
 */
export function DocumentBubbleMenu({
  id,
  trigger,
  children,
  container,
  scroller,
  open,
  onOpenChange,
}: DocumentBubbleMenuProps): React.JSX.Element {
  const closeTimer = React.useRef<number | null>(null);
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);

  /** 取消正在跑的关闭计时。 */
  const cancelClose = React.useCallback((): void => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  /** 指针进了格子或菜单：开着就留着，没开就开。 */
  const enter = React.useCallback((): void => {
    cancelClose();
    onOpenChange(true);
  }, [cancelClose, onOpenChange]);

  /** 指针离开：留一段时间给它走完格子和菜单之间那道缝。 */
  const leave = React.useCallback((): void => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onOpenChange(false);
    }, CLOSE_GRACE_MS);
  }, [cancelClose, onOpenChange]);

  React.useEffect(() => cancelClose, [cancelClose]);

  // 正文一旦真的滚动，菜单必须消失（user 2026-08-26 的第五条）。指针停在菜单
  // 上时滚轮被下面那个监听吃掉，正文不会滚，所以这两条不打架：它们作用在指针
  // 的不同位置上。
  React.useEffect(() => {
    if (!open || !scroller) return undefined;
    /** 正文滚了，收掉菜单。 */
    const close = (): void => {
      cancelClose();
      onOpenChange(false);
    };
    scroller.addEventListener('scroll', close);
    return () => {
      scroller.removeEventListener('scroll', close);
    };
  }, [open, scroller, cancelClose, onOpenChange]);

  // 指针停在菜单上时，滚轮不许滚正文。
  //
  // 走 ref 加原生监听、不走 React 的 `onWheel`：React 把 wheel 挂成 passive
  // 监听器，passive 监听器里 `preventDefault()` 是空操作（DOM 规范）。
  React.useEffect(() => {
    if (!content) return undefined;
    /**
     * 吃掉滚轮。
     * @param event - 滚轮事件。
     */
    const swallow = (event: WheelEvent): void => {
      event.preventDefault();
    };
    content.addEventListener('wheel', swallow, { passive: false });
    return () => {
      content.removeEventListener('wheel', swallow);
    };
  }, [content]);

  return (
    <div
      data-testid={`${id}-zone`}
      className='flex items-center'
      onPointerLeave={leave}
    >
      <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
        <DropdownMenuTrigger asChild onPointerEnter={enter}>
          {trigger}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={setContent}
          container={container}
          data-testid={`${id}-menu`}
          align='start'
          onPointerEnter={enter}
          // 关闭时焦点不还给 trigger。Radix 默认把它还回去
          // （`@radix-ui/react-dropdown-menu:114-115`），而 trigger 就在条
          // 上，条上的东西一律不取焦点（定稿 R4 / §5.2）。`composeEventHandlers`
          // 默认带 `checkForDefaultPrevented`，这里 `preventDefault` 之后
          // Radix 内部那次 `focus()` 就不跑。
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
