// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reference rail's rendered state, mode by mode (#1945).
 *
 * `reference-usability.test.ts` pins the decision; this pins what the decision
 * looks like on screen — which control is dark, which one still answers, and
 * what it says when it refuses.
 *
 * `useTranslation` is stubbed to echo its key so the assertions name the
 * message rather than its English wording: three refusal reasons with one
 * message each, and comparing rendered prose would let two of them drift into
 * saying the same thing without a test noticing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';

vi.mock('@web/lib/toast', () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () =>
    // Echo the key, and append the ICU arguments when there are any, so a
    // message that varies by row modality can be told apart from one that does
    // not.
    (key: string, vars?: Record<string, unknown>): string =>
      vars ? `${key}(${JSON.stringify(vars)})` : key,
}));

import { toast } from '@web/lib/toast';

/** One row per modality the connection rules let reach a video node. */
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
    sourceNodeName: 'Narration',
  },
  {
    refId: 'e-video',
    sourceNodeId: 'n-video',
    sourceNodeType: 'video',
    sourceNodeName: 'Camera move',
    thumbnail: 'https://cdn/cover.png',
  },
];

/** All three refusal messages the rail can send — they all belong to insert (#1952). */
const KEY = {
  modeOff: 'canvas.generatePanel.refuseInsertModeOff',
  typeUnused: 'canvas.generatePanel.refuseInsertTypeUnused',
  insertNoPrompt: 'canvas.generatePanel.refuseInsertNoPrompt',
} as const;

/**
 * Renders the rail under one mode.
 * @param takesReferences - Whether the mode consumes the reference pool.
 * @returns The insert / remove spies.
 */
function renderRail(takesReferences: boolean): {
  onInsert: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
} {
  const onInsert = vi.fn();
  const onRemove = vi.fn();
  render(
    <ReferenceRail
      references={ROWS}
      onInsert={onInsert}
      onRemove={onRemove}
      modeTakesReferences={takesReferences}
    />,
  );
  return { onInsert, onRemove };
}

const insertBtn = (id: string): HTMLElement =>
  screen.getByTestId(`generate-ref-insert-${id}`);
const removeBtn = (id: string): HTMLElement =>
  screen.getByTestId(`generate-ref-remove-${id}`);
const row = (id: string): HTMLElement => screen.getByTestId(`generate-ref-${id}`);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReferenceRail — a mode that ignores references dims its reference material rows', () => {
  it('dims every REFERENCE MATERIAL row, not just the image ones (#1930)', () => {
    // #1952 moved the dim off the row and onto its CONTENT button: the ✕ lives
    // on the row too and it stays usable in every state now, so a dim there
    // would have taken the delete control with it.
    renderRail(false);
    for (const id of ['e-image', 'e-audio', 'e-video']) {
      expect(insertBtn(id), id).toHaveClass('opacity-50');
    }
  });

  it('leaves the TEXT row lit — the dim rule reads on reference material', () => {
    // User 2026-08-13: "整行统一变暗" is about the reference material; a text
    // row is prompt material and never dims. Painting it half-strength said it
    // was unusable while this very mode was consuming it.
    renderRail(false);
    expect(insertBtn('e-text')).not.toHaveClass('opacity-50');
  });

  it('does not stack the row dim with a second dim on the controls', () => {
    // 0.5 × 0.5 = 0.25 would make a dark row's controls read as broken rather
    // than inactive. Still one layer per row after #1952 — it just moved: the
    // CONTENT button owns it, so the row wrapper and the ✕ must carry none.
    renderRail(false);
    expect(row('e-image')).not.toHaveClass('opacity-50');
    expect(removeBtn('e-image')).not.toHaveClass('opacity-50');
  });

  it('keeps the TEXT row untouched — this mode is already using it', () => {
    // This block is about the TEXT EXEMPTION: a mode that ignores references
    // says nothing about a row that feeds the prompt. Since #1952 every ✕
    // removes regardless, and `ReferenceRail-decoupled.test.tsx` already pins
    // that for every mode and every row. What is only here is the last line:
    // removing a text row raises NO refusal toast.
    const { onRemove } = renderRail(false);
    expect(removeBtn('e-text')).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(removeBtn('e-text'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0]?.[0]?.refId).toBe('e-text');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('keeps the TEXT row insertable — it feeds the prompt, not the references', () => {
    const { onInsert } = renderRail(false);
    expect(insertBtn('e-text')).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(insertBtn('e-text'));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0]?.[0]?.refId).toBe('e-text');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('refuses the media rows with the mode reason, not the modality one', () => {
    const { onInsert } = renderRail(false);
    for (const id of ['e-image', 'e-audio', 'e-video']) {
      fireEvent.click(insertBtn(id));
    }
    expect(onInsert).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(toast.warning).mock.calls) {
      expect(call[0]).toBe(KEY.modeOff);
    }
  });
});

describe('ReferenceRail — a mode that uses references lights the rail up', () => {
  it('leaves no row dimmed and every ✕ live, audio and video included (#1934)', () => {
    const { onRemove } = renderRail(true);
    for (const id of ['e-text', 'e-image', 'e-audio', 'e-video']) {
      expect(row(id), id).not.toHaveClass('opacity-50');
      expect(removeBtn(id), id).not.toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(removeBtn(id));
    }
    expect(onRemove).toHaveBeenCalledTimes(4);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('inserts the types this run consumes and explains the ones it does not', () => {
    const { onInsert } = renderRail(true);
    fireEvent.click(insertBtn('e-text'));
    fireEvent.click(insertBtn('e-image'));
    expect(onInsert).toHaveBeenCalledTimes(2);

    fireEvent.click(insertBtn('e-audio'));
    fireEvent.click(insertBtn('e-video'));
    expect(onInsert).toHaveBeenCalledTimes(2);
    expect(toast.warning).toHaveBeenCalledTimes(2);
    // The message names the modality the user just clicked, so the sentence
    // reads about the row in front of them rather than about a category.
    expect(vi.mocked(toast.warning).mock.calls.map((c) => c[0])).toEqual([
      `${KEY.typeUnused}({"kind":"audio"})`,
      `${KEY.typeUnused}({"kind":"video"})`,
    ]);
  });
});

describe('ReferenceRail — an unusable control still answers', () => {
  it('never uses the HTML disabled attribute', () => {
    // A disabled element dispatches neither click nor pointerenter, so it can
    // neither explain itself nor show its hover preview — measured 2026-08-13,
    // and the reason both requirements rule it out.
    renderRail(false);
    for (const id of ['e-image', 'e-audio', 'e-video']) {
      expect(insertBtn(id), id).not.toBeDisabled();
      expect(removeBtn(id), id).not.toBeDisabled();
    }
  });

  it('sets no unconditional not-allowed cursor on an unusable control', () => {
    // `not-allowed` says "clicking achieves nothing", which is the opposite of
    // what happens (user 2026-08-13). The Button primitive's base carries
    // `disabled:cursor-not-allowed` (and `disabled:opacity-50`), but both are
    // gated on the HTML attribute this component never sets — which is also
    // why the row dim cannot stack with a second dim on the controls.
    //
    // So this pins one half only: no class sets the cursor unconditionally.
    // The other half — that the `disabled:` variants never fire — belongs to
    // the test above, which pins the absent attribute; that is why this title
    // claims the class and not the rendered cursor. jsdom applies no Tailwind,
    // so the rendered cursor is not observable at this level either way.
    renderRail(false);
    for (const btn of [insertBtn('e-image'), removeBtn('e-image')]) {
      const unconditional = btn.className
        .split(/\s+/)
        .filter((c) => c.includes('not-allowed') && !c.startsWith('disabled:'));
      expect(unconditional).toEqual([]);
    }
  });

  it('stays keyboard-reachable, so Enter and Space reach the click handler', () => {
    // A native <button> turns Enter / Space into a click itself, which is why
    // there is no onKeyDown here: adding one would fire the toast twice in a
    // real browser (once for the key, once for the click the browser
    // synthesizes). What this level can check is the precondition — unlike
    // `disabled`, `aria-disabled` leaves the button focusable and clickable,
    // so the keyboard path exists at all. That the keys really do reach it is
    // a browser behaviour, verified in the smoke run.
    renderRail(false);
    const btn = insertBtn('e-image');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).not.toHaveAttribute('tabindex', '-1');
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(KEY.modeOff);
  });
});

describe('ReferenceRail — the dim does not reach the hover preview', () => {
  it('opens the card outside the dimmed row, with no opacity above it', () => {
    // A preview's job is to say WHAT this row is, never whether the mode can
    // use it (user 2026-08-13). Two mechanisms could break that, and this
    // renders the REAL HoverPreview so both are in scope: the card could stop
    // being portaled (then the row's own `opacity-50` would inherit into it),
    // or something above the card could carry an opacity of its own. Asserting
    // instead on a `dimmed` prop would test neither — that prop no longer
    // exists, so the assertion could only ever hold.
    //
    // #1952 moved the dim from the row onto its CONTENT button, which is the
    // very element the card hangs off. So the anchor moved with it: the button
    // must be dim (otherwise this test proves nothing) and the card must still
    // carry none of that opacity.
    vi.useFakeTimers();
    render(
      <ReferenceRail
        references={[
          {
            refId: 'e-image',
            sourceNodeId: 'n-image',
            sourceNodeType: 'image',
            sourceNodeName: 'Character',
            thumbnail: 'https://cdn/char.png',
            mediaUrl: 'https://cdn/char.png',
          },
        ]}
        onInsert={vi.fn()}
        onRemove={vi.fn()}
        modeTakesReferences={false}
      />,
    );
    const dimmedRow = row('e-image');
    expect(insertBtn('e-image')).toHaveClass('opacity-50');

    fireEvent.pointerEnter(insertBtn('e-image'), { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10);
    });

    const card = screen.getByTestId('hover-preview-content');
    expect(dimmedRow.contains(card)).toBe(false);
    for (let el = card as HTMLElement | null; el; el = el.parentElement) {
      expect(el.className, el.tagName).not.toContain('opacity-');
    }
  });
});

describe('ReferenceRail — a model that sends no prompt (#1966)', () => {
  // 这一档的两个事实同时成立：模型不吃提示词，且这一档不吃参考素材。
  // 视频目录里 takes_prompt=false 的模型有三个（omnihuman-1.5 / video-upscale-pro
  // / rife-interpolation），但后两个的模式是 upscale / interpolate、不在生成
  // 面板那六档里，所以面板里够得着的只有口播档那一个，而口播档不吃参考。
  /**
   * Renders the rail under a mode whose model consumes no prompt.
   * @returns Nothing; assertions read the rendered rail.
   */
  function renderNoPrompt(): void {
    render(
      <ReferenceRail
        references={ROWS}
        onInsert={vi.fn()}
        onRemove={vi.fn()}
        modeTakesReferences={false}
        modelTakesPrompt={false}
      />,
    );
  }

  it('文本行的插入冻住并说清是提示词那个理由', () => {
    // 原来这条同时钉着 ✕；#1952 之后 ✕ 在任何状态下都可用（user 2026-08-19），
    // 那一半移进 ReferenceRail-decoupled.test.tsx 的「任何状态下都能删」。
    renderNoPrompt();
    expect(
      screen.getByTestId('generate-ref-insert-e-text').getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.click(screen.getByTestId('generate-ref-insert-e-text'));
    expect(toast.warning).toHaveBeenCalledWith(KEY.insertNoPrompt);
  });

  it('媒体行的插入给「不吃参考」那个理由，不给提示词那个', () => {
    // 媒体行在这一档里两条约束都不满足，而只有「切到使用参考的档」这条路
    // 真走得通 —— 切到一个发提示词但不吃参考的档，插入照样做不了。
    renderNoPrompt();
    for (const id of ['e-image', 'e-audio', 'e-video']) {
      vi.mocked(toast.warning).mockClear();
      fireEvent.click(screen.getByTestId(`generate-ref-insert-${id}`));
      expect(toast.warning, `insert ${id}`).toHaveBeenCalledWith(KEY.modeOff);
    }
  });

  it('文本行在这一档里也变暗 —— 它是提示词素材，而这一档没有提示词', () => {
    renderNoPrompt();
    // 判精确 token：`Button` 基类带着 `disabled:opacity-50`，子串匹配恒真。
    expect(
      screen
        .getByTestId('generate-ref-insert-e-text')
        .classList.contains('opacity-50'),
    ).toBe(true);
  });
});
