// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 守卫的删除和弦表必须和内核键表一致（实现对抗第 2、3 轮）。
 *
 * 全文档删除确认守卫绑的和弦名是对 `@tiptap/core` Keymap 扩展键表的镜像。
 * 内核升级新增一条删除和弦、镜像没跟上，那条和弦就是一条重新打开的静默
 * 整篇清空路径，而没有任何运行时信号会报告它。所以这里读**装着的那份
 * dist 源码**，把三个键表块（base / pc / mac）里的键名抽出来跟守卫的导出
 * 常量比对（同款手法：`document-heading-levels` 从磁盘读 index.css）。
 *
 * 判据是**反着**写的，这是第 3 轮对抗改的：不去认「绑到 handleBackspace /
 * handleDelete 的键」，而是把每个块的键名全抽出来、减掉一张点名的非删除
 * 键表，剩下的就必须逐一等于我们的镜像。正着认只逮得住绑到这两个现有
 * 名字的新和弦——内核若把新和弦绑到一个新函数（handleKillLine 之类），
 * 正着认的集合不变、三条断言全绿，而那正是这道守卫要防的加法。反着写
 * 之后，任何新键都会落进「剩下的」里并当场变红：红了不代表出事，只代表
 * 需要人来判这个新键是不是删除。
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
 * 内核键表里点名不是删除的键。
 *
 * 每一项都读过它绑的命令：Enter 走 handleEnter（分块）、Mod-Enter 走
 * exitCode、Mod-a 走 selectAll、Ctrl-a / Ctrl-e 走
 * selectTextblockStart / End。新增的键不在这张表里，就会被下面的断言
 * 顶出来要求人来判定。
 */
const KNOWN_NON_DELETION = new Set([
  'Enter',
  'Mod-Enter',
  'Mod-a',
  'Ctrl-a',
  'Ctrl-e',
]);

/**
 * 抽出键表块里的全部键名。
 * @param block - `{ ... }` 键表源码片段。
 * @returns 键名集合。
 */
function allKeys(block: string): Set<string> {
  const keys = new Set<string>();
  for (const m of block.matchAll(/["']?([A-Za-z][\w-]*)["']?:\s*(?:\(|function|handle|this)/g)) {
    keys.add(m[1]);
  }
  return keys;
}

/**
 * 一个键表块里除已知非删除键之外的全部键。
 * @param block - 键表源码片段。
 * @returns 待判定为删除的键名集合。
 */
function unaccountedKeys(block: string): Set<string> {
  return new Set(
    [...allKeys(block)].filter((key) => !KNOWN_NON_DELETION.has(key)),
  );
}

describe('删除和弦表镜像内核键表', () => {
  const source = readFileSync(require.resolve('@tiptap/core'), 'utf8');
  const baseBlock = source.match(/const baseKeymap = \{[\s\S]*?\n {4}\};/)?.[0];
  const pcBlock = source.match(/const pcKeymap = \{[\s\S]*?\n {4}\};/)?.[0];
  const macBlock = source.match(/const macKeymap = \{[\s\S]*?\n {4}\};/)?.[0];

  it('三个键表定义都还找得到（正则失效要立刻变红，不能静默变空集）', () => {
    expect(baseBlock).toBeTruthy();
    expect(pcBlock).toBeTruthy();
    expect(macBlock).toBeTruthy();
    // 抽键也得真抽到——空集会让下面的比对无意义地通过。
    expect(allKeys(baseBlock as string).size).toBeGreaterThan(3);
  });

  it('baseKeymap 里除已知非删除键外的键，逐一等于全平台镜像', () => {
    expect([...unaccountedKeys(baseBlock as string)].sort()).toEqual(
      [...DELETE_CHORDS_BASE].sort(),
    );
  });

  it('pcKeymap 相对 baseKeymap 没有新增键（有就得人来判它是不是删除）', () => {
    const base = allKeys(baseBlock as string);
    const added = [...allKeys(pcBlock as string)].filter((k) => !base.has(k));
    expect(added).toEqual([]);
  });

  it('macKeymap 相对 baseKeymap 新增的、除已知非删除键外的键，逐一等于 mac 镜像', () => {
    const base = allKeys(baseBlock as string);
    const added = [...unaccountedKeys(macBlock as string)].filter(
      (k) => !base.has(k),
    );
    expect(added.sort()).toEqual([...DELETE_CHORDS_MAC].sort());
  });
});
