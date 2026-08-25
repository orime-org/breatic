// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 「滚到底就再要一页」这件事的两种看法，以及它们之间的切换。
 *
 * 平时看的是「末尾进没进视野」，失败之后看的是「读者有没有再滚一下」。这个
 * 切换是有代价才换的：末尾在视野里是一个状态，而失败不会让它离开视野，所以
 * 换回去的那一刻就会立刻再问一次，问出来的是失败自己造成的循环。
 */

import * as React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useScrolledToEnd } from '@web/lib/use-scrolled-to-end';

/** 这一轮建出来的每个 IntersectionObserver，测试拿它手动触发相交。 */
const observers: {
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
}[] = [];

class FakeIntersectionObserver {
  private readonly entry: (typeof observers)[number];

  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, observed: [], disconnected: false };
    observers.push(this.entry);
  }

  observe(node: Element): void {
    this.entry.observed.push(node);
  }

  disconnect(): void {
    this.entry.disconnected = true;
  }

  unobserve(): void {}
}

interface HarnessProps {
  enabled: boolean;
  failed: boolean;
  onReachEnd: () => void;
}

/**
 * 把 hook 挂在一个带 Radix viewport 标记的结构上，跟真实用法一样。
 * @param props - 传给 hook 的三个参数。
 * @param props.enabled - 还有没有下一页。
 * @param props.failed - 上一次有没有失败。
 * @param props.onReachEnd - 到底之后调什么。
 * @returns 挂好 ref 的结构。
 */
function Harness({
  enabled,
  failed,
  onReachEnd,
}: HarnessProps): React.JSX.Element {
  const { scrollerRef, sentinelRef } = useScrolledToEnd({
    enabled,
    onReachEnd,
    failed,
  });
  return (
    <div ref={scrollerRef}>
      <div data-radix-scroll-area-viewport='' data-testid='viewport'>
        <div ref={sentinelRef} data-testid='sentinel' />
      </div>
    </div>
  );
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useScrolledToEnd', () => {
  it('平时看末尾进没进视野', () => {
    const onReachEnd = vi.fn();
    render(<Harness enabled failed={false} onReachEnd={onReachEnd} />);

    expect(observers).toHaveLength(1);
    act(() => {
      observers[0]!.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it('没有下一页时什么都不看', () => {
    const onReachEnd = vi.fn();
    const { getByTestId } = render(
      <Harness enabled={false} failed={false} onReachEnd={onReachEnd} />,
    );

    expect(observers).toHaveLength(0);
    getByTestId('viewport').dispatchEvent(new Event('scroll'));
    expect(onReachEnd).not.toHaveBeenCalled();
  });

  it('失败之后改看滚动，不再看末尾', () => {
    // 末尾还在视野里，而失败没让它动过。继续看末尾就会立刻再问一次，问的
    // 人是失败自己。
    const onReachEnd = vi.fn();
    const { getByTestId } = render(
      <Harness enabled failed onReachEnd={onReachEnd} />,
    );

    expect(observers).toHaveLength(0);
    expect(onReachEnd).not.toHaveBeenCalled();

    getByTestId('viewport').dispatchEvent(new Event('scroll'));
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it('失败之后一次滚动只再要一次', () => {
    const onReachEnd = vi.fn();
    const { getByTestId } = render(
      <Harness enabled failed onReachEnd={onReachEnd} />,
    );

    const viewport = getByTestId('viewport');
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('scroll'));

    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it('从失败回到正常时，重新看末尾', () => {
    const onReachEnd = vi.fn();
    const { rerender, getByTestId } = render(
      <Harness enabled failed onReachEnd={onReachEnd} />,
    );
    expect(observers).toHaveLength(0);

    rerender(<Harness enabled failed={false} onReachEnd={onReachEnd} />);

    expect(observers).toHaveLength(1);
    // 滚动那条监听跟着上一次的清理一起撤掉了。
    getByTestId('viewport').dispatchEvent(new Event('scroll'));
    expect(onReachEnd).not.toHaveBeenCalled();
  });
});
