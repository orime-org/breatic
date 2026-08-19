// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 轨道的两部分解耦之后各自的状态（#1952）。
 *
 * user 2026-08-19 拍定，supersede 掉 #1945 的两条规则：一行分成内容和 ✕ 两部分，
 * **✕ 在任何状态下恒可操作**，内容能用就亮、不能用就暗。他自己给出了旧规则的成因
 * ——「✕ 跟着内容走」这个约束逼出了「要么全亮要么全暗」，因为按行分亮暗会让用不了
 * 的那行连删都删不掉。解耦之后那条约束不存在了。
 *
 * 这个文件只钉解耦之后的新契约；`ReferenceRail-states.test.tsx` 钉的是 #1945 的
 * 旧规则，本片按 §4.6 逐条处置。
 *
 * `useTranslation` 照 states 那个文件的做法回显 key，断言认的是消息本身而不是它的
 * 英文措辞。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation:
    () =>
      (key: string, vars?: Record<string, unknown>): string =>
        vars ? `${key}(${JSON.stringify(vars)})` : key,
}));

/** 四类行 + 一条聚焦裁剪行 —— 后者是独立副本，没有边可以重连。 */
const ROWS: ReferenceRailItem[] = [
  {
    refId: 'e-text',
    sourceNodeId: 'n-text',
    sourceNodeType: 'text',
    sourceNodeName: 'Script',
    textContent: 'a wide shot',
  },
  {
    refId: 'e-image',
    sourceNodeId: 'n-image',
    sourceNodeType: 'image',
    sourceNodeName: 'Character',
    thumbnail: 'https://cdn/char.png',
  },
  {
    refId: 'e-audio',
    sourceNodeId: 'n-audio',
    sourceNodeType: 'audio',
    sourceNodeName: 'Voice',
    mediaUrl: 'https://cdn/voice.m4a',
  },
  {
    refId: 'e-video',
    sourceNodeId: 'n-video',
    sourceNodeType: 'video',
    sourceNodeName: 'Clip',
    thumbnail: 'https://cdn/clip.jpg',
    mediaUrl: 'https://cdn/clip.mp4',
  },
  {
    refId: 'focus:c1',
    sourceNodeId: 'focus:c1',
    sourceNodeType: 'image',
    sourceNodeName: 'Crop',
    thumbnail: 'https://cdn/crop.png',
    focus: true,
  },
];

const ALL_IDS = ['e-text', 'e-image', 'e-audio', 'e-video', 'focus:c1'];

/**
 * 渲染轨道。
 * @param opts - 这一档吃不吃参考、这个模型吃不吃提示词。
 * @returns 两个回调的 spy。
 */
function renderRail(opts: {
  takesReferences: boolean;
  takesPrompt?: boolean;
}): { onInsert: ReturnType<typeof vi.fn>; onRemove: ReturnType<typeof vi.fn> } {
  const onInsert = vi.fn();
  const onRemove = vi.fn();
  render(
    <ReferenceRail
      references={ROWS}
      onInsert={onInsert}
      onRemove={onRemove}
      modeTakesReferences={opts.takesReferences}
      modelTakesPrompt={opts.takesPrompt ?? true}
    />,
  );
  return { onInsert, onRemove };
}

const insertBtn = (id: string): HTMLElement =>
  screen.getByTestId(`generate-ref-insert-${id}`);
const removeBtn = (id: string): HTMLElement =>
  screen.getByTestId(`generate-ref-remove-${id}`);
const row = (id: string): HTMLElement => screen.getByTestId(`generate-ref-${id}`);

/**
 * 这个元素自己是不是变暗的。
 *
 * 判精确的 class token，不用子串：`Button` 基类带着 `disabled:opacity-50`
 * （`components/ui/button.tsx`），子串匹配对每个 `Button` 都恒真，那样的断言
 * 红绿跟真实行为无关。
 * @param el - 要判的元素。
 * @returns 它自己挂了 `opacity-50` 就是 true。
 */
const dimmed = (el: HTMLElement): boolean => el.classList.contains('opacity-50');

beforeEach(() => {
  vi.clearAllMocks();
});

// 判据读两个布尔量，所以有四种输入组合，四格全列。第四格不是补齐用的：
// 口播档（`video-mode-options.ts` 的 talking_head）`takesReferences: false`，
// 而它正是唯一一个模型不发提示词的档，两条约束同时成立的就是它。「✕ 在任何
// 状态下可点」这条承诺，在真实产品里最需要它成立的那一格此前没有测试钉着。
const MODES = [
  { name: '吃参考的档', takesReferences: true, takesPrompt: true },
  { name: '不吃参考的档', takesReferences: false, takesPrompt: true },
  { name: '模型不发提示词的档', takesReferences: true, takesPrompt: false },
  { name: '口播档：两条都不成立', takesReferences: false, takesPrompt: false },
] as const;

describe('✕ 跟内容解耦：任何状态下都能删', () => {
  for (const mode of MODES) {
    it(`${mode.name}：每一行的 ✕ 都不是 aria-disabled`, () => {
      renderRail(mode);
      for (const id of ALL_IDS) {
        expect(removeBtn(id).getAttribute('aria-disabled')).not.toBe('true');
      }
    });

    it(`${mode.name}：点每一行的 ✕ 都真的删掉它，不弹拒绝`, () => {
      const { onRemove } = renderRail(mode);
      for (const id of ALL_IDS) {
        onRemove.mockClear();
        fireEvent.click(removeBtn(id));
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(onRemove.mock.calls[0]?.[0]?.refId).toBe(id);
      }
    });

    it(`${mode.name}：✕ 自己永远不变暗`, () => {
      renderRail(mode);
      for (const id of ALL_IDS) {
        expect(dimmed(removeBtn(id))).toBe(false);
      }
    });
  }
});

describe('内容的亮暗 = 这一行现在能不能用', () => {
  it('吃参考的档：图片和裁剪行亮，音频和视频行暗（它们插不进去）', () => {
    renderRail({ takesReferences: true });
    for (const id of ['e-text', 'e-image', 'focus:c1']) {
      expect(dimmed(insertBtn(id))).toBe(false);
    }
    for (const id of ['e-audio', 'e-video']) {
      expect(dimmed(insertBtn(id))).toBe(true);
    }
  });

  it('不吃参考的档：参考素材行全暗，文本行仍亮', () => {
    renderRail({ takesReferences: false });
    expect(dimmed(insertBtn('e-text'))).toBe(false);
    for (const id of ['e-image', 'e-audio', 'e-video', 'focus:c1']) {
      expect(dimmed(insertBtn(id))).toBe(true);
    }
  });

  it('模型不发提示词的档：每一行都暗，文本行也是（#1966）', () => {
    renderRail({ takesReferences: true, takesPrompt: false });
    for (const id of ALL_IDS) {
      expect(dimmed(insertBtn(id))).toBe(true);
    }
  });

  it('口播档：两条都不成立时每一行都暗，而 ✕ 全部照旧可点', () => {
    renderRail({ takesReferences: false, takesPrompt: false });
    for (const id of ALL_IDS) {
      expect(dimmed(insertBtn(id))).toBe(true);
      expect(removeBtn(id).getAttribute('aria-disabled')).not.toBe('true');
    }
  });
});

describe('一行上只有一层 opacity —— 换了位置，不变量还在', () => {
  // 0.5 × 0.5 = 0.25 会让暗行的控件读起来像坏了而不是不可用。#1945 把这一层放在
  // 行上、并禁止按钮再加一层；本片把它挪进内容按钮，所以禁止的对象换成了行的外层
  // 和 ✕。层数仍然只有一层。
  for (const mode of MODES) {
    it(`${mode.name}：行的外层没有 opacity`, () => {
      renderRail(mode);
      for (const id of ALL_IDS) {
        expect(dimmed(row(id))).toBe(false);
      }
    });
  }
});
