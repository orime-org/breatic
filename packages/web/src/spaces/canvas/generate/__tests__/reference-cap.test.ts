// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The reference-image cap, read the same way by both Generate panels (#1927).
 *
 * It began life private to the image panel's view model, where its docstring
 * said out loud why it exists: to keep the frontend's count gate agreeing with
 * the server rule (`reference-count.ts`, which guards on `limit >= 1`) and the
 * worker's truthy `spec.max_items`. The video panel needs the same answer, and
 * a second copy would be a fourth statement of a rule that only works when all
 * of them agree — so it moved here rather than being written again.
 */

import { describe, it, expect } from 'vitest';

import {
  positiveCap,
  referenceCapExceeded,
} from '@web/spaces/canvas/generate/reference-cap';

describe('positiveCap', () => {
  it('takes a positive cap at face value', () => {
    expect(positiveCap(1)).toBe(1);
    expect(positiveCap(7)).toBe(7);
  });

  it('reads zero as uncapped, not as "none allowed"', () => {
    // The server rule ignores a limit below 1 and the worker ignores a falsy
    // one. A frontend that honoured 0 would refuse every submit with a toast
    // saying "at most 0 reference images" — a sentence neither of the other
    // two layers would ever produce.
    expect(positiveCap(0)).toBeUndefined();
  });

  it('reads a negative, fractional-below-one, or non-finite cap as uncapped', () => {
    expect(positiveCap(-3)).toBeUndefined();
    expect(positiveCap(0.5)).toBeUndefined();
    expect(positiveCap(Number.NaN)).toBeUndefined();
    expect(positiveCap(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('reads an absent cap as uncapped', () => {
    // A model that declares no `max_items` is not capped; the param descriptor
    // has no way to say "at most none".
    expect(positiveCap(undefined)).toBeUndefined();
  });
});

/**
 * The count gate itself, not just the cap it reads.
 *
 * Both Generate panels refuse a submit that carries more references than the
 * model takes, and both name the limit in the refusal. That rule was written
 * out twice, character for character — which is the shape the cap extraction
 * above exists to avoid, since a later change to what the rule means (`>=`,
 * a different message, a mode that opts out) would land in one panel only.
 *
 * What it hands back is the message's VALUES, not its key: the key stays
 * spelled out at each call site, because the check that every id reaches a
 * real message only sees ids written inside a `t("…")` call. Measured —
 * returning the key from here left that check green after the message was
 * deleted from the catalog it resolves against (`locales/en.json`, the
 * source; the other four are held level by a check of their own).
 */
describe('referenceCapExceeded', () => {
  it('says nothing while the count is within the cap', () => {
    expect(referenceCapExceeded(7, 7)).toBeNull();
    expect(referenceCapExceeded(0, 7)).toBeNull();
  });

  it('reports the limit, not the count, so the refusal can name it', () => {
    // What the user needs is the number to get under, which is the only one
    // they cannot see anywhere in the panel.
    expect(referenceCapExceeded(8, 7)).toEqual({ limit: 7 });
  });

  it('says nothing when the model is uncapped', () => {
    expect(referenceCapExceeded(99, undefined)).toBeNull();
  });
});
