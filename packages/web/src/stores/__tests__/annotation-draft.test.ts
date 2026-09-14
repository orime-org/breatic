// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import {
  CLOSED_DRAFT,
  reduceDraft,
  type DraftState,
} from '@web/stores/annotation-draft';

/**
 * Open a draft in one of the three uses and return the state it lands in.
 * @param use - Which of the three the caller wants.
 * @param seed - The text the entry point hands over.
 * @returns The opened draft.
 */
const opened = (use: DraftState['use'], seed = ''): DraftState =>
  reduceDraft(CLOSED_DRAFT, { type: 'open', use, text: seed });

describe('the annotation draft, before anything reaches Yjs', () => {
  it('opens empty for a new annotation and for a new reply', () => {
    expect(opened('annotation')).toMatchObject({
      mode: 'typing',
      use: 'annotation',
      text: '',
    });
    expect(opened('reply')).toMatchObject({ mode: 'typing', text: '' });
  });

  it('opens an edit on the text that is already there', () => {
    expect(opened('edit', 'the line as it stands')).toMatchObject({
      mode: 'typing',
      use: 'edit',
      text: 'the line as it stands',
    });
  });

  it('ignores a second open while one is already up', () => {
    const first = opened('annotation');
    const typed = reduceDraft(first, { type: 'type', text: 'half a thought' });
    expect(reduceDraft(typed, { type: 'open', use: 'reply', text: '' })).toBe(
      typed,
    );
  });

  it('commits on save and closes', () => {
    const typed = reduceDraft(opened('annotation'), {
      type: 'type',
      text: 'a cooler shot here',
    });
    expect(reduceDraft(typed, { type: 'save' })).toMatchObject({
      mode: 'closed',
      commit: 'a cooler shot here',
    });
  });

  it('stays open on save when the text is blank', () => {
    const blank = reduceDraft(opened('annotation'), {
      type: 'type',
      text: '   ',
    });
    const after = reduceDraft(blank, { type: 'save' });
    expect(after.mode).toBe('typing');
    expect(after.commit).toBeUndefined();
  });

  it('drops a new annotation on Escape without committing', () => {
    const typed = reduceDraft(opened('annotation'), {
      type: 'type',
      text: 'never mind',
    });
    const after = reduceDraft(typed, { type: 'escape' });
    expect(after.mode).toBe('closed');
    expect(after.commit).toBeUndefined();
  });

  it('drops a new annotation on blur, and leaves an edit alone', () => {
    const fresh = reduceDraft(opened('annotation'), {
      type: 'type',
      text: 'half typed',
    });
    expect(reduceDraft(fresh, { type: 'blur' }).mode).toBe('closed');

    const editing = reduceDraft(opened('edit', 'the original'), {
      type: 'type',
      text: 'the original, reworded',
    });
    expect(reduceDraft(editing, { type: 'blur' })).toBe(editing);
  });

  it('closes without committing when the target is deleted mid-edit', () => {
    const editing = reduceDraft(opened('edit', 'the original'), {
      type: 'type',
      text: 'words nobody will read',
    });
    const after = reduceDraft(editing, { type: 'targetGone' });
    expect(after).toMatchObject({ mode: 'closed', targetGone: true });
    expect(after.commit).toBeUndefined();
  });

  it('saves an edit through the button, and cancel throws it away', () => {
    const editing = reduceDraft(opened('edit', 'the original'), {
      type: 'type',
      text: 'the original, reworded',
    });
    expect(reduceDraft(editing, { type: 'save' })).toMatchObject({
      mode: 'closed',
      commit: 'the original, reworded',
    });
    const cancelled = reduceDraft(editing, { type: 'cancel' });
    expect(cancelled.mode).toBe('closed');
    expect(cancelled.commit).toBeUndefined();
  });

  it('refuses to save a blank edit, keeping the box open', () => {
    const emptied = reduceDraft(opened('edit', 'the original'), {
      type: 'type',
      text: '',
    });
    expect(reduceDraft(emptied, { type: 'save' })).toBe(emptied);
  });
});
