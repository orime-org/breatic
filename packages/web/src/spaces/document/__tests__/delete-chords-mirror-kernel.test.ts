// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 守卫的删除和弦表必须和内核键表一致（实现对抗第 2 轮 #7）。
 *
 * 全文档删除确认守卫绑的和弦名是对 `@tiptap/core` Keymap 扩展键表的镜像。
 * 内核升级新增一条删除和弦，镜像没跟上，那条和弦就是一条重新打开的静默
 * 整篇清空路径——而没有任何运行时信号会报告这件事。所以这里直接读**装着
 * 的那份 dist 源码**，把 `baseKeymap` / `macKeymap` 里映射到删除命令的键名
 * 抽出来，跟守卫导出的两张表比对（同款手法：`document-heading-levels`
 * 从磁盘读 index.css 核对级别规则）。
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import {
  DELETE_CHORDS_BASE,
  DELETE_CHORDS_MAC,
} from '@web/spaces/document/document-select-all';

const require = createRequire(import.meta.url);

/**
 * 从内核键表定义块里抽出映射到删除命令的键名。
 * @param block - `{ ... }` 键表源码片段。
 * @returns 删除和弦名集合。
 */
function deletionKeys(block: string): Set<string> {
  const keys = new Set<string>();
  for (const m of block.matchAll(/"?([A-Za-z][\w-]*)"?:\s*handle(Backspace|Delete)/g)) {
    keys.add(m[1]);
  }
  return keys;
}

describe('删除和弦表镜像内核键表', () => {
  const source = readFileSync(require.resolve('@tiptap/core'), 'utf8');
  const baseBlock = source.match(/const baseKeymap = \{[\s\S]*?\};/)?.[0];
  const macBlock = source.match(/const macKeymap = \{[\s\S]*?\};/)?.[0];

  it('内核的键表定义还找得到（正则失效要立刻知道，不能静默变空集）', () => {
    expect(baseBlock).toBeTruthy();
    expect(macBlock).toBeTruthy();
    expect(deletionKeys(baseBlock as string).size).toBeGreaterThan(0);
  });

  it('全平台档与内核 baseKeymap 的删除键逐一相等', () => {
    const kernel = deletionKeys(baseBlock as string);
    expect([...kernel].sort()).toEqual([...DELETE_CHORDS_BASE].sort());
  });

  it('mac 档与内核 macKeymap 新增的删除键逐一相等', () => {
    const base = deletionKeys(baseBlock as string);
    const macOnly = [...deletionKeys(macBlock as string)].filter(
      (k) => !base.has(k),
    );
    expect(macOnly.sort()).toEqual([...DELETE_CHORDS_MAC].sort());
  });
});
