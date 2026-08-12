// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { canExecuteGenerate } from '@web/spaces/canvas/generate/generate-guards';

/** A gate input where every condition is satisfied. */
const ok = {
  promptText: 'a cat',
  model: 'midjourney-v7',
  nodeStatus: 'idle' as string | undefined,
  isSubmitting: false,
  promptRequired: true,
};

describe('canExecuteGenerate — every execute precondition must hold', () => {
  it('is true when the prompt, model, idle status and non-submitting all hold', () => {
    expect(canExecuteGenerate(ok)).toBe(true);
  });

  it('trims surrounding whitespace before judging the prompt', () => {
    expect(canExecuteGenerate({ ...ok, promptText: '  hi  ' })).toBe(true);
  });

  it('is false for an empty or whitespace-only prompt', () => {
    expect(canExecuteGenerate({ ...ok, promptText: '' })).toBe(false);
    expect(canExecuteGenerate({ ...ok, promptText: '  \n\t ' })).toBe(false);
  });

  it('lets an empty prompt through when the caller says none is required (#1935)', () => {
    // The talking-head model declares no `prompt` param at all, so demanding
    // one would be a requirement we invented: the caller asks the selected
    // model, and passes the answer here. Whitespace-only counts as empty on
    // both sides of the switch, so the two paths differ in exactly one thing.
    expect(
      canExecuteGenerate({ ...ok, promptText: '', promptRequired: false }),
    ).toBe(true);
    expect(
      canExecuteGenerate({ ...ok, promptText: ' \n\t ', promptRequired: false }),
    ).toBe(true);
  });

  it('still weighs every other precondition when no prompt is required', () => {
    // Dropping the prompt requirement must not become a way past the model,
    // the node's existence, or the in-flight latch.
    const noPrompt = { ...ok, promptText: '', promptRequired: false };
    expect(canExecuteGenerate({ ...noPrompt, model: '' })).toBe(false);
    expect(canExecuteGenerate({ ...noPrompt, nodeStatus: undefined })).toBe(
      false,
    );
    expect(canExecuteGenerate({ ...noPrompt, isSubmitting: true })).toBe(false);
  });

  it('is false when no model is selected (empty catalog fallback)', () => {
    expect(canExecuteGenerate({ ...ok, model: '' })).toBe(false);
  });

  it('stays executable while handling — the click surfaces the gate toast (user 2026-07-18)', () => {
    // handling no longer greys the button; clicking it hits the node-state gate,
    // which shows the handling warn-toast (same pattern as a locked node) rather
    // than a silently-disabled button. The gate still blocks the actual submit.
    expect(canExecuteGenerate({ ...ok, nodeStatus: 'handling' })).toBe(true);
  });

  it('is false when the node no longer exists (status undefined = deleted)', () => {
    expect(canExecuteGenerate({ ...ok, nodeStatus: undefined })).toBe(false);
  });

  it('stays executable after a prior failure so the user can retry', () => {
    expect(canExecuteGenerate({ ...ok, nodeStatus: 'error' })).toBe(true);
  });

  it('is false while a submission is already in flight', () => {
    expect(canExecuteGenerate({ ...ok, isSubmitting: true })).toBe(false);
  });
});
