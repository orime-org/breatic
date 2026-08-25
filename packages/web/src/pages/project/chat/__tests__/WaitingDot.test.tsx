// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What says the answer is still coming, for as long as it is.
 *
 * One dot, breathing. Settled 2026-08-12 over two busier proposals, confirmed
 * again on 2026-08-19, and widened on 2026-08-20 to run for the whole turn
 * rather than only until the first word. The shape comes from the demo page
 * that settled it, whose `.pulse` rule is the ground truth for every figure
 * asserted here.
 *
 * The blinking bar that used to take over once there was text is gone, and
 * with it the only other mark this bubble ever carried.
 *
 * jsdom applies no stylesheet, so the figures are read from the stylesheet
 * itself rather than from a computed style. That keeps the numbers the demo
 * fixed under a test; whether they add up to the right thing on screen is
 * measured on a real browser.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WaitingDot } from '@web/pages/project/chat/WaitingDot';

/**
 * The application stylesheet.
 * @returns Its whole text.
 */
function stylesheet(): string {
  return readFileSync(resolve(import.meta.dirname, '../../../../index.css'), 'utf8');
}

/**
 * The body of one CSS rule or at-rule.
 * @param selector - What opens the block, verbatim.
 * @returns Everything between the braces that follow it.
 */
function ruleBody(selector: string): string {
  const css = stylesheet();
  const start = css.indexOf(selector);
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

describe('the dot that waits', () => {
  it('is a dot, not a character borrowed from the font', () => {
    render(<WaitingDot />);
    const dot = screen.getByTestId('chat-waiting-dot');
    // The block character it replaces sits on the text baseline and inherits
    // the prose colour, which is why a reply that has not started looks like
    // a reply that has.
    expect(dot.textContent).toBe('');
    expect(dot.className).toContain('chat-waiting-dot');
  });

  it('keeps a name for a reader who cannot see it', () => {
    render(<WaitingDot />);
    expect(screen.getByTestId('chat-waiting-dot')).toHaveAttribute('aria-label');
  });
});

describe('the figures the demo fixed', () => {
  it('breathes on the demo cycle and easing', () => {
    const rule = ruleBody('.chat-waiting-dot');
    expect(rule).toContain('1.2s');
    expect(rule).toContain('ease-in-out');
    expect(rule).toContain('infinite');
  });

  it('is eight pixels across and round', () => {
    const rule = ruleBody('.chat-waiting-dot');
    expect(rule).toContain('width: 8px');
    expect(rule).toContain('height: 8px');
    expect(rule).toContain('border-radius: 50%');
  });

  it('不自己定行高，气泡的高度由气泡自己说了算', () => {
    // 这里原本写着 `line-height: 20px`,名字叫「撑住二十像素的行,文字落下来
    // 时气泡才不会变高」。两件事都不成立:这个点是个空的 inline-block,没有
    // 自己的文字就没有行框可撑。在跑着的应用里、在真的气泡里量(13px 字、
    // 18px 行),加不加那条声明,点和一行文字都是 18px —— 不变高是气泡自己
    // 的行高定的,跟这里无关。
    //
    // 而那条测试之所以能一直绿,是因为它查的是样式表里有没有「20px」这四个
    // 字符,不是屏幕上有没有发生什么。
    expect(ruleBody('.chat-waiting-dot')).not.toContain('line-height');
  });

  it('takes its colour from a token the rest of the sheet also uses', () => {
    // 只查「写了 var(...)」查不出任何东西:一个拼错的 token 名照样是一句
    // 合法的 `var()`,浏览器把它算成透明 —— 屏幕上什么都没有,而这条测试
    // 照绿。这正是发生过的事(2026-08-20 真机量出来的:`--color-muted-fg`
    // 全仓只有这一处,那个点是透明的)。
    //
    // 判据不是「它在这个文件里被定义过」——语义 token 由 Tailwind 从
    // `@theme` 生成,文本里根本没有它的定义行。判据是「别处也在用它」:
    // 一个活着的 token 名到处都是,一个拼错的只会出现一次。
    const used = /background:\s*var\((--[a-z0-9-]+)\)/.exec(ruleBody('.chat-waiting-dot'));
    expect(used).not.toBeNull();
    const token = used![1]!;
    const elsewhere = stylesheet().split(`var(${token})`).length - 1;
    expect(elsewhere).toBeGreaterThan(1);
  });

  it('travels between the two states the demo set', () => {
    const frames = ruleBody('@keyframes chat-waiting-dot');
    expect(frames).toContain('opacity: 0.25');
    expect(frames).toContain('scale(0.85)');
    expect(frames).toContain('opacity: 1');
    expect(frames).toContain('scale(1)');
  });

  it('does not fall back to nothing on a machine asking for less motion', () => {
    // Ratified 2026-07-03 and written into the skeleton rule right above
    // this one: an earlier reduce override blanked that animation outright
    // and left the loading state unreadable. This dot carries the same
    // meaning -- an answer is coming -- and disappears the same way.
    const css = stylesheet();
    const at = css.indexOf('.chat-waiting-dot');
    // Without this the assertion below passes on a stylesheet that has no
    // such rule at all: indexOf returns -1, slice reads from the end, and
    // one trailing character contains no media query.
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, at + 900)).not.toContain('@media (prefers-reduced-motion');
  });
});
