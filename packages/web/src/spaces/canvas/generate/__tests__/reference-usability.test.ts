// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The reference rail's two-dimension state model (#1945).
 *
 * Dimension one — "does this mode use references at all" — dims the whole row
 * and governs the ✕. Dimension two — "is this row's modality one this run
 * consumes" — governs insertion and the `@` picker. They are CONJUNCT for
 * media rows and irrelevant for text rows, and the point of pinning all 24
 * video combinations plus all 8 image ones is that a single boolean used to
 * carry both meanings and got both wrong.
 */

import { describe, it, expect } from 'vitest';

import {
  insertRefusal,
  isReferenceMaterial,
  removeRefusal,
  type ReferenceModeContext,
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
 * dark while its backend source list is non-empty. The rail reads nothing
 * model-indexed, which is why this fixture has one field and not two.
 */
const VIDEO_MODES: ReadonlyArray<{ mode: string; ctx: ReferenceModeContext }> = [
  { mode: 't2v', ctx: { takesReferences: false } },
  { mode: 'i2v', ctx: { takesReferences: false } },
  { mode: 'first_last', ctx: { takesReferences: false } },
  { mode: 'animate', ctx: { takesReferences: false } },
  { mode: 'ref', ctx: { takesReferences: true } },
  { mode: 'talking_head', ctx: { takesReferences: false } },
];

/** The image panel's two reference-relevant modes. */
const IMAGE_MODES: ReadonlyArray<{ mode: string; ctx: ReferenceModeContext }> = [
  { mode: 't2i', ctx: { takesReferences: false } },
  { mode: 'i2i', ctx: { takesReferences: true } },
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

  it('pins the image panel: dark in t2i, image-only in i2i', () => {
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

  it('never refuses a TEXT row, in any mode of either panel', () => {
    // The dim rule reads on REFERENCE MATERIAL, and text is prompt material
    // (user 2026-08-13, second clarification). The reason for freezing a ✕ is
    // "this mode cannot use the row, so do not let you throw it away before
    // switching back" — and a text row is consumed by every mode, so the
    // premise never holds and there is nothing to hold in trust.
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
  it('answers from the row and the mode alone, with no model context', () => {
    // The context carries one field. There is no catalog to be unresolved, so
    // there is no third state to name and no window during which the rail
    // answers differently from how it will answer a second later. Three
    // rounds of Gate 2 produced three different wrong answers to "what while
    // the catalog is loading"; the question was the defect.
    const ref: ReferenceModeContext = { takesReferences: true };
    expect(Object.keys(ref)).toEqual(['takesReferences']);
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
    const ref: ReferenceModeContext = { takesReferences: true };
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
    // The picker filters with `insertRefusal(...) === null`; the rail disables
    // with the same call. This test is the contract that they are the same
    // function — before #1945 the rail asked `canConnect(type, "image")` and
    // the picker asked its own copy of it, hardcoded to the image panel's
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
