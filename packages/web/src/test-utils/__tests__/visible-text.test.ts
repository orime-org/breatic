// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 这个 helper 存在的理由是「说清楚允许出现什么，就没有地方能藏」。
 *
 * 它守的是 A6「顶栏不显示会话数量」：与其挨个禁掉计数可能的写法，不如说清这块
 * 区域只准显示哪些字符串，多出来的一律报出来。所以它的判据强度就是那条验收项
 * 的强度 —— 判据漏掉一种写法，那种写法就能把计数加回顶栏而没有任何东西会响。
 */
import { describe, it, expect } from 'vitest';
import { textIn, unexpectedTextIn } from '@web/test-utils/visible-text';

/**
 * 拿一段 HTML 当区域。
 * @param html - 区域里的内容。
 * @returns 装着它的元素。
 */
function region(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('what a region is showing', () => {
  it('collects text that has an element of its own', () => {
    expect(textIn(region('<span>one</span><span>two</span>'))).toEqual(['one', 'two']);
  });

  it('collects text written straight into a container, next to its elements', () => {
    // JSX 里最顺手的加法就是这个形状：`<div><TitleEditable/>{` (${n})`}</div>`。
    // 按叶子元素收会整段看不见它 —— 那正是把计数加回顶栏最自然的写法。
    expect(textIn(region('<div><span>one</span> (7)</div>'))).toEqual(['one', '(7)']);
  });

  it('collects text sitting directly in the region', () => {
    expect(textIn(region('3<button><span>one</span></button>'))).toEqual(['3', 'one']);
  });

  it('says nothing about whitespace between elements', () => {
    expect(textIn(region('<span>one</span>\n  <span>two</span>'))).toEqual(['one', 'two']);
  });

  it('reports a count added next to an allowed string', () => {
    expect(unexpectedTextIn(region('<div><span>one</span> (7)</div>'), ['one'])).toEqual(['(7)']);
  });

  it('reports nothing when the region shows only what it may', () => {
    expect(unexpectedTextIn(region('<div><span>one</span></div>'), ['one'])).toEqual([]);
  });
});
