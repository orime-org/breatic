// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 块类型那一格装什么，以及当前选区算哪一种。
 *
 * 九项出自 demo（`2026-08-21-editor-command-surface.html:560-588`）。这一格的
 * 图标跟着当前块变、不出文字、不走 i18n（user 2026-08-26 拍定，理由是它跟右边
 * 的 B、I、U 是同一排字母形态的图标，翻译反而让条的宽度随语言变）。
 *
 * 业界五家里四家在这一格显示当前块类型的名字，做了 i18n 的三家全部本地化
 * （Notion 的 `Text` · Google Docs 的 `Normal text` · BlockNote 的 24 个语言
 * 包）。这次不跟那一条，理由如上。
 */

import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  ListTodo,
  type LucideIcon,
} from 'lucide-react';
import type { Editor } from '@tiptap/core';

/** 块类型那一格认得的九种块。 */
export type BlockTypeId =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'ordered-list'
  | 'quote'
  | 'code-block'
  | 'task-list';

/** 菜单里的一项。 */
export interface BlockTypeItem {
  id: BlockTypeId;
  labelKey: string;
  Icon: LucideIcon;
  /** demo 画在右侧的快捷键，没有就不出这一列。 */
  shortcut?: string;
  /**
   * 这一项背后的命令。
   *
   * 今天只有三项接得上（无序列表 · 有序列表 · 引用），其余按「还没开放」画
   * （user 2026-08-23 的规则，user 2026-08-26 确认沿用）。
   */
  run?: (editor: Editor) => void;
}

/** 九项，顺序照 demo。 */
export const BLOCK_TYPE_ITEMS: BlockTypeItem[] = [
  {
    id: 'paragraph',
    labelKey: 'spaces.document.commands.paragraph',
    Icon: Type,
  },
  {
    id: 'heading-1',
    labelKey: 'spaces.document.commands.heading1',
    Icon: Heading1,
    shortcut: '⌘⌥1',
  },
  {
    id: 'heading-2',
    labelKey: 'spaces.document.commands.heading2',
    Icon: Heading2,
    shortcut: '⌘⌥2',
  },
  {
    id: 'heading-3',
    labelKey: 'spaces.document.commands.heading3',
    Icon: Heading3,
    shortcut: '⌘⌥3',
  },
  {
    id: 'bullet-list',
    labelKey: 'spaces.document.commands.bulletList',
    Icon: List,
    shortcut: '⌘⇧8',
    run: (e) => {
      e.chain().focus().toggleBulletList().run();
    },
  },
  {
    id: 'ordered-list',
    labelKey: 'spaces.document.commands.orderedList',
    Icon: ListOrdered,
    shortcut: '⌘⇧7',
    run: (e) => {
      e.chain().focus().toggleOrderedList().run();
    },
  },
  {
    id: 'quote',
    labelKey: 'spaces.document.commands.quote',
    Icon: Quote,
    shortcut: '⌘⇧B',
    run: (e) => {
      e.chain().focus().toggleBlockquote().run();
    },
  },
  {
    id: 'code-block',
    labelKey: 'spaces.document.commands.codeBlock',
    Icon: SquareCode,
    shortcut: '⌘⌥C',
  },
  {
    id: 'task-list',
    labelKey: 'spaces.document.commands.taskList',
    Icon: ListTodo,
  },
];

/** 从 id 找那一项，找不到时给回段落那一项。 */
const BY_ID = new Map(BLOCK_TYPE_ITEMS.map((item) => [item.id, item]));

/**
 * 一个 ProseMirror 节点算哪一种块。
 * @param typeName - 节点的 schema 名字。
 * @param attrs - 节点属性，标题靠它区分级别。
 * @returns 块类型，认不出时为 null。
 */
function blockTypeOf(
  typeName: string,
  attrs: Record<string, unknown>,
): BlockTypeId | null {
  if (typeName === 'paragraph') return 'paragraph';
  if (typeName === 'codeBlock') return 'code-block';
  if (typeName === 'heading') {
    const level = attrs.level;
    if (level === 1) return 'heading-1';
    if (level === 2) return 'heading-2';
    if (level === 3) return 'heading-3';
  }
  return null;
}

/**
 * 当前选区算哪一种块。
 *
 * 遍历选区罩住的每一个块，收集它们的类型。**只有全都是同一种时才报那一种**，
 * 跨了两种（选中一个标题和它下面一段正文，这是常态）报 `paragraph` —— 它是
 * 这一格的中性态，跟菜单里哪一项都不高亮是一致的。
 *
 * 不走 `editor.isActive()`：它回答的是「这一种在选区里出现过吗」，跨块选区
 * 里两种都能答 true，分不出「整段是标题」和「选区碰到了标题」。
 * @param editor - 编辑器。
 * @returns 当前块类型。
 */
export function currentBlockType(editor: Editor): BlockTypeId {
  const { from, to } = editor.state.selection;
  const seen = new Set<BlockTypeId | null>();
  // 列表和引用包着别的块，所以先看有没有它们罩着整个选区 —— 罩着就是它们，
  // 里面那些段落只是它们的内容。
  if (editor.isActive('bulletList')) return 'bullet-list';
  if (editor.isActive('orderedList')) return 'ordered-list';
  if (editor.isActive('blockquote')) return 'quote';
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isTextblock) return true;
    seen.add(blockTypeOf(node.type.name, node.attrs));
    return false;
  });
  if (seen.size !== 1) return 'paragraph';
  const [only] = [...seen];
  return only ?? 'paragraph';
}

/**
 * 当前块类型对应的那一项，用来给格子挑图标。
 * @param editor - 编辑器。
 * @returns 那一项。
 */
export function currentBlockTypeItem(editor: Editor): BlockTypeItem {
  return BY_ID.get(currentBlockType(editor)) ?? BLOCK_TYPE_ITEMS[0];
}
