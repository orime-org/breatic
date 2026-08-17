// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The reference rail's three-dimension state model (#1945, #1966).
 *
 * Dimension one — "does this mode use references at all" — dims the whole row
 * and governs the ✕. Dimension two — "is this row's modality one this run
 * consumes" — governs insertion and the `@` picker. These two are CONJUNCT for
 * media rows and do not reach text rows at all, and the point of pinning all 24
 * video combinations plus all 8 image ones is that a single boolean used to
 * carry both meanings and got both wrong.
 *
 * Dimension three — "does the ACTIVE MODEL take a prompt" (#1966) — is the one
 * that DOES govern text rows, and it is the only one that does. The 24 + 8
 * enumeration holds it true throughout, so those cases isolate the first two;
 * the third has its own block at the bottom, which walks it against both other
 * dimensions.
 */

import { describe, it, expect } from 'vitest';

import {
  insertRefusal,
  isReferenceMaterial,
  removeRefusal,
  type ReferenceUsabilityContext,
} from '@web/spaces/canvas/generate/reference-usability';
import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/** The four upstream modalities the connection rules let reach a video node. */
const ROW_KINDS: NodeKind[] = ['text', 'image', 'audio', 'video'];

/**
 * The video panel's six modes, with the one thing the rail asks of a mode.
 *
 * `takesReferences` mirrors `modeTakesReferences` — only `ref` collects the
 * `@` pool (#1927). It is NOT the same question as "does this mode need an
 * image at all": `i2v` needs one but takes it from a SLOT, so its rail is
 * dark while its backend source list is non-empty. That value is the only one
 * that varies across these rows.
 *
 * `takesPrompt` is pinned true on every one of them, deliberately: it belongs
 * to the MODEL, not the mode, so a mode row cannot state it. Holding it true
 * makes these cases about the reference dimension alone; the block at the
 * bottom of the file is where it varies.
 */
const VIDEO_MODES: ReadonlyArray<{ mode: string; ctx: ReferenceUsabilityContext }> = [
  { mode: 't2v', ctx: { takesReferences: false, takesPrompt: true } },
  { mode: 'i2v', ctx: { takesReferences: false, takesPrompt: true } },
  { mode: 'first_last', ctx: { takesReferences: false, takesPrompt: true } },
  { mode: 'animate', ctx: { takesReferences: false, takesPrompt: true } },
  { mode: 'ref', ctx: { takesReferences: true, takesPrompt: true } },
  { mode: 'talking_head', ctx: { takesReferences: false, takesPrompt: true } },
];

/** The image panel's two reference-relevant modes. */
const IMAGE_MODES: ReadonlyArray<{ mode: string; ctx: ReferenceUsabilityContext }> = [
  { mode: 't2i', ctx: { takesReferences: false, takesPrompt: true } },
  { mode: 'i2i', ctx: { takesReferences: true, takesPrompt: true } },
];

describe('insertRefusal — text rows are prompt material, not reference material', () => {
  it('never refuses a text row, in any of the six video modes', () => {
    for (const { mode, ctx } of VIDEO_MODES) {
      expect(insertRefusal('text', ctx), `text row in ${mode}`).toBeNull();
    }
  });

  it('never refuses a text row, in either image mode', () => {
    for (const { mode, ctx } of IMAGE_MODES) {
      expect(insertRefusal('text', ctx), `text row in ${mode}`).toBeNull();
    }
  });
});

describe('insertRefusal — media rows need BOTH conditions', () => {
  it('refuses every media row in a mode that does not take references', () => {
    for (const { mode, ctx } of VIDEO_MODES.filter(
      (m) => !m.ctx.takesReferences,
    )) {
      for (const kind of ['image', 'audio', 'video'] as const) {
        expect(insertRefusal(kind, ctx), `${kind} row in ${mode}`).toBe(
          'mode-takes-no-references',
        );
      }
    }
  });

  it('allows only the source types the reference-taking mode consumes', () => {
    const ref = VIDEO_MODES.find((m) => m.mode === 'ref')!.ctx;
    expect(insertRefusal('image', ref)).toBeNull();
    expect(insertRefusal('audio', ref)).toBe('source-type-unused');
    expect(insertRefusal('video', ref)).toBe('source-type-unused');
  });

  it('reports the MODE refusal, not the type one, when both would apply', () => {
    // An audio row under talking_head fails both tests — the mode does not
    // take references at all, AND the reference pool is images only. The mode
    // reason wins because it names the state the user can leave; the modality
    // reason names a rule that holds in every mode and leaves nothing to do.
    // (talking_head does consume audio — through its driving-audio SLOT, not
    // through the rail. That is why the rail's refusal must not be read as
    // "this audio node is useless here".)
    const talkingHead = VIDEO_MODES.find((m) => m.mode === 'talking_head')!.ctx;
    expect(insertRefusal('audio', talkingHead)).toBe(
      'mode-takes-no-references',
    );
  });

  it('refuses 3d / web / group / annotation rows too — none of them is an image', () => {
    const ref = VIDEO_MODES.find((m) => m.mode === 'ref')!.ctx;
    for (const kind of ['3d', 'web', 'group', 'annotation'] as NodeKind[]) {
      expect(insertRefusal(kind, ref), `${kind} row`).toBe('source-type-unused');
    }
  });

  it('pins the image panel: every media row refused in t2i, image-only in i2i', () => {
    const t2i = IMAGE_MODES.find((m) => m.mode === 't2i')!.ctx;
    const i2i = IMAGE_MODES.find((m) => m.mode === 'i2i')!.ctx;
    for (const kind of ['image', 'audio', 'video'] as const) {
      expect(insertRefusal(kind, t2i), `${kind} in t2i`).toBe(
        'mode-takes-no-references',
      );
    }
    expect(insertRefusal('image', i2i)).toBeNull();
    expect(insertRefusal('audio', i2i)).toBe('source-type-unused');
    expect(insertRefusal('video', i2i)).toBe('source-type-unused');
  });
});

describe('removeRefusal — the ✕ follows the dim, which reads on reference material', () => {
  it('refuses every MEDIA row in a mode that does not take references', () => {
    for (const { mode, ctx } of [...VIDEO_MODES, ...IMAGE_MODES].filter(
      (m) => !m.ctx.takesReferences,
    )) {
      for (const kind of ['image', 'audio', 'video'] as const) {
        expect(removeRefusal(kind, ctx), `remove ${kind} in ${mode}`).toBe(
          'mode-takes-no-references',
        );
      }
    }
  });

  it('allows every media row in a mode that takes references', () => {
    for (const { mode, ctx } of [...VIDEO_MODES, ...IMAGE_MODES].filter(
      (m) => m.ctx.takesReferences,
    )) {
      for (const kind of ['image', 'audio', 'video'] as const) {
        expect(removeRefusal(kind, ctx), `remove ${kind} in ${mode}`).toBeNull();
      }
    }
  });

  it('never refuses a TEXT row over references, in any mode of either panel', () => {
    // The dim rule reads on REFERENCE MATERIAL, and text is prompt material
    // (user 2026-08-13, second clarification). The reason for freezing a ✕ is
    // "this mode cannot use the row, so do not let you throw it away before
    // switching back" — and that premise is about reference material, which a
    // text row is not, so there is nothing to hold in trust.
    //
    // Scoped to the reference question, and the fixtures are what scope it:
    // every one of them takes a prompt. A model that takes none DOES freeze a
    // text row's ✕ — that is #1965, settled in #1966 — and the block at the
    // bottom of this file is where that case lives.
    for (const { mode, ctx } of [...VIDEO_MODES, ...IMAGE_MODES]) {
      expect(removeRefusal('text', ctx), `remove text in ${mode}`).toBeNull();
    }
  });

  it('does not let the media rows disagree with each other', () => {
    // The asymmetry this replaces: audio / video rows stayed removable inside
    // a dimmed mode while image rows were frozen (#1940). All three media
    // kinds now answer identically for a given mode.
    for (const { mode, ctx } of VIDEO_MODES) {
      const verdicts = (['image', 'audio', 'video'] as const).map((k) =>
        removeRefusal(k, ctx),
      );
      expect(new Set(verdicts).size, `media rows disagree in ${mode}`).toBe(1);
    }
  });
});

describe('insertRefusal — the criterion depends on nothing asynchronous', () => {
  it('answers from two plain booleans — no catalog handle, no promise', () => {
    // #1966 added the second field, and it is model-derived, so this is no
    // longer "no model context". What did NOT change is the property this
    // assertion exists for: neither field is a catalog handle or a promise, so
    // there is still no third state to name and no window during which the
    // rail answers differently from how it will answer a second later. Three
    // rounds of review once produced three different wrong answers to "what
    // while the catalog is loading"; the question was the defect. The caller
    // resolves both values and passes them in.
    const ref: ReferenceUsabilityContext = { takesReferences: true, takesPrompt: true };
    expect(Object.keys(ref).sort()).toEqual(['takesPrompt', 'takesReferences']);
    expect(insertRefusal('image', ref)).toBeNull();
    expect(insertRefusal('text', ref)).toBeNull();
    expect(insertRefusal('audio', ref)).toBe('source-type-unused');
    expect(insertRefusal('video', ref)).toBe('source-type-unused');
  });

  it('refuses every non-image reference row, because the pool is the image pool', () => {
    // Not a lookup: what the rail feeds is `params.images`, a list of image
    // URLs. Both of its producers — `imageUrlOf` for node rows, the image
    // panel's `focusImages` append for crops — require an image, so a
    // non-image row has nothing to give either one.
    const ref: ReferenceUsabilityContext = { takesReferences: true, takesPrompt: true };
    for (const kind of ['audio', 'video', '3d', 'web'] as NodeKind[]) {
      expect(insertRefusal(kind, ref), kind).toBe('source-type-unused');
    }
  });
});

describe('isReferenceMaterial — one name for the thing both dimensions read on', () => {
  it('holds for the three media modalities and not for text', () => {
    for (const kind of ['image', 'audio', 'video'] as const) {
      expect(isReferenceMaterial(kind), kind).toBe(true);
    }
    expect(isReferenceMaterial('text')).toBe(false);
  });

  it('holds for modalities that carry an asset but cannot reach these nodes', () => {
    // 3d / web are reference material by nature even though connection-rules
    // does not let them reach an image or video node today. Answering by
    // "is it text" and answering by "is it one of the three" diverge exactly
    // here, and two spellings of one concept is how the rail ended up with a
    // row that was lit but whose x was frozen.
    for (const kind of ['3d', 'web'] as NodeKind[]) {
      expect(isReferenceMaterial(kind), kind).toBe(true);
    }
  });
});

describe('insertRefusal — the rail and the @ picker give the same answer', () => {
  it('agrees across all 24 video combinations', () => {
    // The picker filters with `insertRefusal(...) === null` and the rail
    // disables with the same call, so pinning that one function pins both.
    // This block is that pinned table, not a check that the two call sites
    // still share it — before #1945 the rail asked `canConnect(type, "image")`
    // and the picker asked its own copy of it, hardcoded to the image panel's
    // target modality even inside the video panel.
    const seen: string[] = [];
    for (const { mode, ctx } of VIDEO_MODES) {
      for (const kind of ROW_KINDS) {
        seen.push(`${mode}/${kind}=${insertRefusal(kind, ctx) ?? 'ok'}`);
      }
    }
    expect(seen).toHaveLength(24);
    expect(seen.filter((s) => s.endsWith('=ok'))).toEqual([
      't2v/text=ok',
      'i2v/text=ok',
      'first_last/text=ok',
      'animate/text=ok',
      'ref/text=ok',
      'ref/image=ok',
      'talking_head/text=ok',
    ]);
  });

  it('agrees across all 8 image combinations', () => {
    const seen: string[] = [];
    for (const { mode, ctx } of IMAGE_MODES) {
      for (const kind of ROW_KINDS) {
        seen.push(`${mode}/${kind}=${insertRefusal(kind, ctx) ?? 'ok'}`);
      }
    }
    expect(seen).toHaveLength(8);
    expect(seen.filter((s) => s.endsWith('=ok'))).toEqual([
      't2i/text=ok',
      'i2i/text=ok',
      'i2i/image=ok',
    ]);
  });
});

// #1966：轨道多了一维「这个模型吃不吃提示词」。
//
// user 2026-08-16 的判定理由：文本行之所以不算参考素材、能一路放行，前提是
// 「这一档有提示词」——它是提示词材料。模式连提示词都不发了，它连提示词材料
// 都不算，那就该跟图片音频行同一套处理。
//
// 同时这一维把 #1962 那两处判断合成一处：此前「能不能插」由这个模块判一半
// （这个模式吃不吃参考素材）、由视频面板容器判另一半（这个模型要不要提示词）。
describe('这一档不发提示词时 (#1966)', () => {
  const noPrompt = { takesReferences: false, takesPrompt: false } as const;
  const noPromptButRefs = { takesReferences: true, takesPrompt: false } as const;
  const normal = { takesReferences: true, takesPrompt: true } as const;

  it('文本行的插入被拒，理由是没有提示词框', () => {
    expect(insertRefusal('text', noPrompt)).toBe('model-takes-no-prompt');
  });

  it('文本行的 ✕ 也被拒，同一个理由', () => {
    expect(removeRefusal('text', noPrompt)).toBe('model-takes-no-prompt');
  });

  it('参考素材行的两个动作说同一句：「这一档不吃参考」', () => {
    // 两个按钮问的是同一个问题的两面，答案必须一致，否则同一行会给出两个
    // 互相矛盾的理由。而在两条约束同时成立时，只有「不吃参考」这一句指得出
    // 真走得通的路：切到使用参考的档（ref）一次就成，切到一个发提示词但不吃
    // 参考的档（t2v / i2v / first_last / animate）仍然两个动作都做不了。
    for (const kind of ['image', 'audio', 'video'] as const) {
      expect(insertRefusal(kind, noPrompt), `insert ${kind}`).toBe(
        'mode-takes-no-references',
      );
      expect(removeRefusal(kind, noPrompt), `remove ${kind}`).toBe(
        'mode-takes-no-references',
      );
    }
  });

  it('这一档吃参考素材但不发提示词时，插入说没框、✕ 放行', () => {
    // 今天不可达（面板里唯一 takesPrompt=false 的模式，takesReferences 也是
    // false），但判定必须是全序，所以这一格要有定义。参考那一问已经过了，
    // 所以插入才轮到提示词那一问；而这一档真的在用这一行，所以删得掉。
    expect(insertRefusal('image', noPromptButRefs)).toBe('model-takes-no-prompt');
    expect(removeRefusal('image', noPromptButRefs)).toBeNull();
  });

  it('文本行的 ✕ 不受「吃不吃参考」影响，只看发不发提示词', () => {
    // 文本行不是参考素材，参考那一问对它不成立；它是提示词素材，所以只有
    // 提示词那一问管得着它，而「切到发提示词的档」对它确实是能走通的出路。
    expect(removeRefusal('text', noPromptButRefs)).toBe('model-takes-no-prompt');
    expect(removeRefusal('text', { takesReferences: false, takesPrompt: true })).toBeNull();
  });

  it('发提示词的档一切照旧，这一维不影响它', () => {
    expect(insertRefusal('text', normal)).toBeNull();
    expect(removeRefusal('text', normal)).toBeNull();
    expect(insertRefusal('image', normal)).toBeNull();
    expect(removeRefusal('image', normal)).toBeNull();
  });
});
