// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { FAILURE_LINES } from '@breatic/shared';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

// 工具调用失败时卡片上那一行。这一族键有个共同点：**代码里没有一处把它们
// 写成字面量** —— 卡片渲染的是 `t(toolCall.failureKey ?? …)`，键本身来自
// `FAILURE_LINES` 这张表。所以 `i18n-no-missing-keys` 扫不到它们（那条守卫
// 只认「字面量本身就是 t() 的整个参数」），而且它也只读 en.json 一份。
//
// 缺英文那份 → 用户屏幕上直接读到 `chat.tool.failure.upstream` 这串裸 key；
// 缺另外四份之一 → 那个语种的界面里冒出一句英文。两样都没有任何东西会报。
//
// 键从表里取，不在这儿抄一份：抄一份就会跟表漂开，而漂开的那天正是有人往
// 表里加了一条却没加翻译的那天。
const LINE_KEYS = Object.values(FAILURE_LINES);

describe('工具失败的那一行，五个语种都有', () => {
  it('这张表本身不是空的', () => {
    // 上面那句「键从表里取」有个前提：表里真的有东西。表空了的话下面每一条
    // 都会因为没有用例而全绿。
    expect(LINE_KEYS.length).toBeGreaterThanOrEqual(5);
  });

  describe.each(LINE_KEYS)('%s', (key) => {
    it.each(LOCALE_CATALOGS)('%s 有这句话且不是空的', (_tag, catalog) => {
      const message = readPath(catalog, key);
      expect(typeof message).toBe('string');
      expect((message as string).trim()).not.toBe('');
    });

    it('四个非英文语种都真的翻过，不是把英文抄过去', () => {
      const english = readPath(LOCALE_CATALOGS[0][1], key);
      for (const [tag, catalog] of LOCALE_CATALOGS.slice(1)) {
        expect(readPath(catalog, key), tag).not.toBe(english);
      }
    });
  });
});

describe('每种语言里，失败那几条都是同一句', () => {
  // 卡片只回答「这一步成了没有」。为什么没成是模型在正文里说的事，那里能
  // 指名是哪个地址、什么状态。这几个键留着是为了将来真要分粒度时不用改结
  // 构，今天它们说同一句话。
  const failureLines = Object.values(FAILURE_LINES).filter(
    (line) => line !== FAILURE_LINES.stopped,
  );

  it.each(LOCALE_CATALOGS)('%s 四条失败文案一致，且跟停止那条分得开', (_tag, catalog) => {
    const shown = failureLines.map((key) => readPath(catalog, key));

    expect(shown.length).toBeGreaterThanOrEqual(4);
    expect(new Set(shown).size).toBe(1);
    expect(shown[0]).not.toBe(readPath(catalog, FAILURE_LINES.stopped));
  });
});

