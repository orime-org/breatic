// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The first line of a task row says what the task was doing (inner#888 §7.7):
 * the action, then what it acted with. Every state of the row uses the same
 * line, so the reader can tell an upload from a generation at a glance.
 */

import { describe, it, expect } from 'vitest';
import { UNDERSTAND_MODEL } from '@breatic/shared';
import { miniToolById } from '@breatic/shared/mini-tools';

import { taskRowTitle } from '@web/spaces/canvas/tasks/task-row-title';

/**
 * A translator that spells out the key and its values, so each assertion
 * reads which sentence was chosen and what went into it.
 * @param key - The message key.
 * @param values - The interpolated values.
 * @returns A readable stand-in for the sentence.
 */
function t(key: string, values?: Record<string, unknown>): string {
  return values === undefined ? key : `${key}(${String(values.name)})`;
}

const NAMES: Record<string, string> = { 'seedream-5': 'Seedream 5' };

/**
 * The catalog's display name for a model id, or null when it is not served.
 * @param id - The model id.
 * @returns The display name, or null.
 */
function displayNameOf(id: string): string | null {
  return NAMES[id] ?? null;
}

describe('taskRowTitle', () => {
  it('puts the upload action before the file name', () => {
    expect(
      taskRowTitle({ action: 'upload', label: 'holiday.mp4' }, t, displayNameOf),
    ).toBe('canvas.task.title.upload(holiday.mp4)');
  });

  it('names a generation by the model the catalog shows', () => {
    expect(
      taskRowTitle({ action: 'generate', label: 'seedream-5' }, t, displayNameOf),
    ).toBe('canvas.task.title.generate(Seedream 5)');
  });

  it('falls back to the model id when the catalog no longer serves it', () => {
    expect(
      taskRowTitle({ action: 'generate', label: 'retired-model' }, t, displayNameOf),
    ).toBe('canvas.task.title.generate(retired-model)');
  });

  it('names a reading by the pinned model’s display name', () => {
    expect(
      taskRowTitle(
        { action: 'understand', label: UNDERSTAND_MODEL.id },
        t,
        displayNameOf,
      ),
    ).toBe(`canvas.task.title.understand(${UNDERSTAND_MODEL.displayName})`);
  });

  it('shows a mini-tool by its own name with no action word in front', () => {
    const upscale = miniToolById('image.upscale');
    expect(
      taskRowTitle({ action: 'mini_tool', label: 'image.upscale' }, t, displayNameOf),
    ).toBe(upscale?.labelKey);
  });

  it('shows a tool id the registry does not know exactly as it was stored', () => {
    // Rows written before the registry existed carry ids like `upscale`.
    expect(
      taskRowTitle({ action: 'mini_tool', label: 'upscale' }, t, displayNameOf),
    ).toBe('upscale');
  });
});
