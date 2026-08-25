// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `@` 弹层没得提供时说的那两句话（#1952）。
 *
 * 三条拍板叠在一起决定了这里的行为：弹层一律出现、零匹配也出现（I3 作废，
 * user 2026-08-18）；空的成因不分（没连线 / 没内容 / 模式不支持共用一句）；
 * 但「有货只是你打的字筛掉了」是另一件事，说第二句（user 2026-08-19）。
 *
 * 判据只能在这一层做：`ReferenceMentionList` 收到的是已经过滤完的 items，
 * 分辨不出这些行是被模式滤光的还是被名字滤光的。
 */

import { describe, it, expect, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { ReactRenderer } from '@tiptap/react';

import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import { ReferenceMention } from '@web/spaces/canvas/generate/reference-mention';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

const EMPTY = 'EMPTY-LABEL';
const NO_MATCH = 'NO-MATCH-LABEL';

const imageRow: ReferenceRailItem = {
  refId: 'i->me',
  sourceNodeId: 'i',
  sourceNodeType: 'image',
  sourceNodeName: 'Pic',
  thumbnail: 'i.png',
};

/**
 * 一个装了 `@` 建议插件的裸编辑器。
 * @returns 编辑器。
 */
function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({
          getPool: () => [],
          emptyLabel: EMPTY,
          noMatchLabel: NO_MATCH,
        }),
      }),
    ],
  });
}

type Handlers = ReturnType<
  NonNullable<ReturnType<typeof makeReferenceSuggestion>['render']>
>;
type StartProps = Parameters<NonNullable<Handlers['onStart']>>[0];

/**
 * 驱动 render() 回调用的最小 props。
 * @param editor - 宿主编辑器。
 * @param query - `@` 后面打的字。
 * @returns 一个转成建议 props 形状的对象。
 */
function props(editor: Editor, query = ''): StartProps {
  return {
    editor,
    items: [],
    command: vi.fn(),
    clientRect: () => new DOMRect(0, 0, 10, 10),
    query,
    text: `@${query}`,
    range: { from: 0, to: 0 },
    decorationNode: null,
  } as unknown as StartProps;
}

/**
 * 打开一次弹层，交出它的外层元素和推给列表的 props。
 * @param opts - 池子、模式上下文、打的字。
 * @returns 外层元素、列表收到的最后一份 props、以及收尾函数。
 */
function openPopup(opts: {
  pool: ReferenceRailItem[];
  takesReferences?: boolean;
  query?: string;
}): {
  el: HTMLElement;
  lastProps: () => Record<string, unknown> | undefined;
  close: () => void;
} {
  const seen: Record<string, unknown>[] = [];
  const spy = vi
    .spyOn(ReactRenderer.prototype, 'updateProps')
    .mockImplementation(function (this: unknown, p?: Record<string, unknown>) {
      if (p) seen.push(p);
    });
  const suggestion = makeReferenceSuggestion({
    getPool: () => opts.pool,
    emptyLabel: EMPTY,
    noMatchLabel: NO_MATCH,
    getUsabilityContext: () => ({
      takesReferences: opts.takesReferences ?? true,
      takesPrompt: true,
    }),
    isLocalUserInput: () => true,
  });
  const render = suggestion.render;
  if (!render) throw new Error('render missing');
  const handlers = render();
  const editor = makeEditor();
  const before = new Set(Array.from(document.body.children));
  handlers.onStart?.(props(editor, opts.query ?? ''));
  const el = Array.from(document.body.children).find(
    (c) => !before.has(c),
  ) as HTMLElement;
  // onStart 的播种走构造函数，updateProps 看不见它；再驱动一次 onUpdate 让
  // 选好的那句话经 updateProps 交出来。
  handlers.onUpdate?.(props(editor, opts.query ?? ''));
  return {
    el,
    lastProps: () => seen.at(-1),
    close: () => {
      spy.mockRestore();
      handlers.onExit?.(props(editor));
      editor.destroy();
    },
  };
}

describe('弹层一律出现，零匹配也出现', () => {
  it('池子空时打 `@`，弹层不藏起来', () => {
    const p = openPopup({ pool: [] });
    try {
      expect(p.el.style.display).not.toBe('none');
    } finally {
      p.close();
    }
  });

  it('池子非空但被模式滤光时，弹层也不藏起来', () => {
    const p = openPopup({ pool: [imageRow], takesReferences: false });
    try {
      expect(p.el.style.display).not.toBe('none');
    } finally {
      p.close();
    }
  });
});

describe('两句话：没得提供，还是你打的字筛掉了', () => {
  it('模式过滤后一项不剩 —— 说「没有可引用的内容」', () => {
    const p = openPopup({ pool: [], query: '' });
    try {
      expect(p.lastProps()?.emptyLabel).toBe(EMPTY);
    } finally {
      p.close();
    }
  });

  it('池子非空、被模式滤光 —— 同一句，因为确实一项都用不了', () => {
    const p = openPopup({ pool: [imageRow], takesReferences: false });
    try {
      expect(p.lastProps()?.emptyLabel).toBe(EMPTY);
    } finally {
      p.close();
    }
  });

  it('模式过滤后有货、名字没匹配上 —— 说「没有匹配的内容」', () => {
    const p = openPopup({ pool: [imageRow], query: 'zzz' });
    try {
      expect(p.lastProps()?.items).toEqual([]);
      expect(p.lastProps()?.emptyLabel).toBe(NO_MATCH);
    } finally {
      p.close();
    }
  });

  it('有匹配时列表照常给行，那两句都不出场', () => {
    const p = openPopup({ pool: [imageRow], query: 'pi' });
    try {
      expect((p.lastProps()?.items as ReferenceRailItem[]).length).toBe(1);
    } finally {
      p.close();
    }
  });
});
