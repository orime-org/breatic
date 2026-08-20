// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 轨道和 `@` 弹层对同一行给出同一个答案（#1952 的任务目标）。
 *
 * 这两个入口调的是同一个 `insertRefusal`，所以它们**结构上**不会分歧 —— 但在
 * 这个文件之前，没有任何测试真的同时驱动过它们。`reference-usability.test.ts`
 * 里那个叫「the rail and the @ picker give the same answer」的 describe，自己
 * 在注释里写着「This block is that pinned table, **not a check that the two
 * call sites still share it**」：它只调那个纯函数，既不渲染轨道也不驱动弹层。
 *
 * 所以这里两边都真的跑一遍，逐行比对。哪天有人给其中一个入口加了自己的判据，
 * 这条会红。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';

import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import { ReferenceMention } from '@web/spaces/canvas/generate/reference-mention';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string): string => key,
}));

/** 连接规则允许连到视频节点的四类行，外加一条聚焦裁剪行。 */
const ROWS: ReferenceRailItem[] = [
  { refId: 'r-text', sourceNodeId: 't', sourceNodeType: 'text', sourceNodeName: 'Script' },
  { refId: 'r-image', sourceNodeId: 'i', sourceNodeType: 'image', sourceNodeName: 'Pic' },
  { refId: 'r-audio', sourceNodeId: 'a', sourceNodeType: 'audio', sourceNodeName: 'Voice' },
  { refId: 'r-video', sourceNodeId: 'v', sourceNodeType: 'video', sourceNodeName: 'Clip' },
  {
    refId: 'focus:c1',
    sourceNodeId: 'focus:c1',
    sourceNodeType: 'image',
    sourceNodeName: 'Crop',
    focus: true,
  },
];

/**
 * 弹层在这一档下会提供哪几行。
 * @param takesReferences - 这一档吃不吃参考素材。
 * @param takesPrompt - 这个模型吃不吃提示词。
 * @returns 弹层交给列表的那些行的 refId。
 */
function pickerOffers(takesReferences: boolean, takesPrompt: boolean): string[] {
  const suggestion = makeReferenceSuggestion({
    getPool: () => ROWS,
    emptyLabel: 'empty',
    noMatchLabel: 'no-match',
    getUsabilityContext: () => ({ takesReferences, takesPrompt }),
  });
  const items = suggestion.items;
  if (!items) throw new Error('items resolver missing');
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, ReferenceMention],
  });
  try {
    const offered = items({
      query: '',
      editor,
      directive: undefined,
    } as unknown as Parameters<typeof items>[0]) as ReferenceRailItem[];
    return offered.map((r) => r.refId);
  } finally {
    editor.destroy();
  }
}

/**
 * 轨道在这一档下哪几行的内容是活的（插入按钮不被拒）。
 * @param takesReferences - 这一档吃不吃参考素材。
 * @param takesPrompt - 这个模型吃不吃提示词。
 * @returns 插入按钮没有被拒的那些行的 refId。
 */
function railOffers(takesReferences: boolean, takesPrompt: boolean): string[] {
  const { unmount } = render(
    <ReferenceRail
      references={ROWS}
      onInsert={vi.fn()}
      onRemove={vi.fn()}
      modeTakesReferences={takesReferences}
      modelTakesPrompt={takesPrompt}
    />,
  );
  try {
    return ROWS.filter(
      (r) =>
        screen
          .getByTestId(`generate-ref-insert-${r.refId}`)
          .getAttribute('aria-disabled') !== 'true',
    ).map((r) => r.refId);
  } finally {
    unmount();
  }
}

const MODES = [
  { name: '吃参考的档', takesReferences: true, takesPrompt: true },
  { name: '不吃参考的档', takesReferences: false, takesPrompt: true },
  { name: '模型不发提示词的档', takesReferences: true, takesPrompt: false },
  { name: '两条都不成立的档', takesReferences: false, takesPrompt: false },
] as const;

describe('轨道和 @ 弹层对同一行给出同一个答案', () => {
  for (const mode of MODES) {
    it(`${mode.name}：两边提供的是同一批行`, () => {
      const picker = pickerOffers(mode.takesReferences, mode.takesPrompt);
      const rail = railOffers(mode.takesReferences, mode.takesPrompt);
      expect(picker.slice().sort()).toEqual(rail.slice().sort());
    });
  }
});
