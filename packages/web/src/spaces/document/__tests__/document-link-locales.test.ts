// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 链接控件那六条界面文字，五份 locale 一条都不能缺。
 *
 * 缺一条的后果是那个位置渲染出 key 本身，而 key 是英文点号串，谁都看不懂；
 * 而少一份 locale 不会有任何东西变红，除非有人来数。
 *
 * 按钮名跟浮出条其余九个控件同处 `commands`，浮层内部的五条自成一节：前者
 * 回答「这个按钮叫什么」，后者是这个浮层自己的文字。
 */

import { describe, it, expect } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const KEYS = [
  'spaces.document.commands.link',
  'spaces.document.link.placeholder',
  'spaces.document.link.confirm',
  'spaces.document.link.edit',
  'spaces.document.link.remove',
  'spaces.document.link.invalid',
] as const;

describe('链接控件的界面文字', () => {
  LOCALE_CATALOGS.forEach(([tag, catalog]) => {
    KEYS.forEach((key) => {
      it(`${tag} 有 ${key}`, () => {
        const value = readPath(catalog, key);

        expect(typeof value).toBe('string');
        expect(value).not.toBe('');
      });
    });
  });

  it('五份 locale 里没有两份把同一条写成一样的字', () => {
    // 六条里五条是普通词，翻译撞车说明有一份是照抄别人的。日文和韩文跟中文
    // 之间没有这种共形，英文更不会。
    const perKey = KEYS.map((key) =>
      LOCALE_CATALOGS.map(([, catalog]) => readPath(catalog, key)),
    );

    perKey.forEach((values, index) => {
      expect(new Set(values).size, `${KEYS[index]} 有重复译文`).toBe(
        LOCALE_CATALOGS.length,
      );
    });
  });
});
