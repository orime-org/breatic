// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task row opens with what the task is (inner#1454): a badge naming the
 * kind, as the history panel's rows do, then what it acted on.
 */

import { describe, it, expect } from 'vitest';
import { ArrowUp, Captions, ScanText, Sparkles } from 'lucide-react';
import { UNDERSTAND_MODEL } from '@breatic/shared';
import { miniToolById } from '@breatic/shared/mini-tools';

import { MINI_TOOL_ICONS } from '@web/spaces/canvas/mini-tool/tool-icons';
import { taskRowKind } from '@web/spaces/canvas/tasks/task-row-kind';

/**
 * A translator that returns the key, so each assertion reads which message
 * was chosen.
 * @param key - The message key.
 * @returns The key.
 */
function t(key: string): string {
  return key;
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

describe('taskRowKind', () => {
  it('badges an upload and names its file', () => {
    expect(taskRowKind({ action: 'upload', label: 'holiday.mp4' }, t, displayNameOf)).toEqual({
      icon: ArrowUp,
      label: 'canvas.task.kind.upload',
      detail: 'holiday.mp4',
    });
  });

  it('badges a generation and names the model the catalog shows', () => {
    expect(taskRowKind({ action: 'generate', label: 'seedream-5' }, t, displayNameOf)).toEqual({
      icon: Sparkles,
      label: 'canvas.task.kind.generate',
      detail: 'Seedream 5',
    });
  });

  it('falls back to the model id when the catalog no longer serves it', () => {
    expect(
      taskRowKind({ action: 'generate', label: 'retired-model' }, t, displayNameOf).detail,
    ).toBe('retired-model');
  });

  it('badges a reading with the menu entry that starts it', () => {
    expect(
      taskRowKind({ action: 'understand', label: UNDERSTAND_MODEL.id }, t, displayNameOf),
    ).toEqual({
      icon: ScanText,
      label: 'canvas.task.kind.understand',
      detail: UNDERSTAND_MODEL.displayName,
    });
  });

  // inner#856: a transcription names itself, with the menu entry's icon.
  it('badges a transcription with the menu entry that starts it', () => {
    expect(
      taskRowKind({ action: 'transcribe', label: UNDERSTAND_MODEL.id }, t, displayNameOf),
    ).toEqual({
      icon: Captions,
      label: 'canvas.task.kind.transcribe',
      detail: UNDERSTAND_MODEL.displayName,
    });
  });

  it('badges a mini-tool with its own icon and name, and nothing after', () => {
    const upscale = miniToolById('image.upscale');
    expect(upscale).toBeDefined();
    expect(
      taskRowKind({ action: 'mini_tool', label: 'image.upscale' }, t, displayNameOf),
    ).toEqual({
      icon: MINI_TOOL_ICONS[upscale!.icon],
      label: upscale!.labelKey,
      detail: null,
    });
  });

  it('shows a tool id the registry does not know exactly as it was stored', () => {
    // Rows written before the registry existed carry ids like `upscale`.
    expect(taskRowKind({ action: 'mini_tool', label: 'upscale' }, t, displayNameOf)).toEqual({
      icon: Sparkles,
      label: 'upscale',
      detail: null,
    });
  });
});
