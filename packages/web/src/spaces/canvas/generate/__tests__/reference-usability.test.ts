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
  removeRefusal,
  type ReferenceModeContext,
} from '@web/spaces/canvas/generate/reference-usability';
import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/** The four upstream modalities the connection rules let reach a video node. */
const ROW_KINDS: NodeKind[] = ['text', 'image', 'audio', 'video'];

/**
 * The video panel's six modes, with what each one actually consumes.
 *
 * `takesReferences` mirrors `modeTakesReferences` (only `ref` collects the
 * `@` pool, #1927); `allowedSourceTypes` mirrors the backend-computed
 * `sourcesByMode[mode]` (domain's MODE_REQUIRED_SOURCES). The two are
 * independent on purpose: `i2v` needs an image but takes it from a SLOT, not
 * from the rail, so its rail is dark even though its source list is non-empty.
 */
const VIDEO_MODES: ReadonlyArray<{
  mode: string;
  ctx: ReferenceModeContext;
}> = [
  { mode: 't2v', ctx: { takesReferences: false, allowedSourceTypes: [] } },
  {
    mode: 'i2v',
    ctx: { takesReferences: false, allowedSourceTypes: ['image'] },
  },
  {
    mode: 'first_last',
    ctx: { takesReferences: false, allowedSourceTypes: ['image'] },
  },
  {
    mode: 'animate',
    ctx: { takesReferences: false, allowedSourceTypes: ['image', 'video'] },
  },
  { mode: 'ref', ctx: { takesReferences: true, allowedSourceTypes: ['image'] } },
  {
    mode: 'talking_head',
    ctx: { takesReferences: false, allowedSourceTypes: ['image', 'audio'] },
  },
];

/** The image panel's two reference-relevant modes. */
const IMAGE_MODES: ReadonlyArray<{
  mode: string;
  ctx: ReferenceModeContext;
}> = [
  { mode: 't2i', ctx: { takesReferences: false, allowedSourceTypes: [] } },
  { mode: 'i2i', ctx: { takesReferences: true, allowedSourceTypes: ['image'] } },
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
    // take references AND audio is not in that mode's rail-consumable list.
    // The mode reason wins because it is the one the user can act on: switch
    // to a mode that uses references. Saying "this model's references do not
    // take audio" here would be true and useless.
    const talkingHead = VIDEO_MODES.find((m) => m.mode === 'talking_head')!.ctx;
    expect(insertRefusal('audio', talkingHead)).toBe(
      'mode-takes-no-references',
    );
  });

  it('refuses modalities outside the source-type vocabulary (3d / web / group)', () => {
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

describe('removeRefusal — the ✕ follows the row dim, and only that', () => {
  it('refuses removal in every mode that does not take references', () => {
    for (const { mode, ctx } of [...VIDEO_MODES, ...IMAGE_MODES].filter(
      (m) => !m.ctx.takesReferences,
    )) {
      expect(removeRefusal(ctx), `remove in ${mode}`).toBe(
        'mode-takes-no-references',
      );
    }
  });

  it('allows removal in every mode that takes references', () => {
    for (const { mode, ctx } of [...VIDEO_MODES, ...IMAGE_MODES].filter(
      (m) => m.ctx.takesReferences,
    )) {
      expect(removeRefusal(ctx), `remove in ${mode}`).toBeNull();
    }
  });

  it('does not vary with the row modality — a dark row is dark for all four', () => {
    // The ✕ is the one control that must NOT read the row's type: it is the
    // reason audio / video rows used to be removable inside a dimmed mode
    // while image rows were not (#1940). `removeRefusal` takes no row
    // argument at all, which is how that asymmetry is made unrepresentable.
    const ref = VIDEO_MODES.find((m) => m.mode === 'ref')!.ctx;
    const t2v = VIDEO_MODES.find((m) => m.mode === 't2v')!.ctx;
    expect(removeRefusal(ref)).toBeNull();
    expect(removeRefusal(t2v)).toBe('mode-takes-no-references');
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
        const refusal = insertRefusal(kind, ctx);
        seen.push(`${mode}/${kind}=${refusal ?? 'ok'}`);
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
});
