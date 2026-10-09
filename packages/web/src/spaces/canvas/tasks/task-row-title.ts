// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The first line of a task row: what the task was doing (inner#888 §7.7).
 * Every state of the row opens with it, so an upload, a generation, a reading
 * and a tool run read apart at a glance.
 */

import { UNDERSTAND_MODEL, type NodeTaskEntry } from '@breatic/shared';
import { miniToolById } from '@breatic/shared/mini-tools';

/** A translator, as the rows are given one. */
type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/**
 * The row's first line.
 * @param entry - The task's action and label.
 * @param entry.action - What the task was doing.
 * @param entry.label - The file name or address, the model id, or the tool id.
 * @param t - The translator.
 * @param displayNameOf - The catalog's name for a model id, or null when the
 *   catalog does not serve it (the id is shown then).
 * @returns The line.
 */
export function taskRowTitle(
  entry: Pick<NodeTaskEntry, 'action' | 'label'>,
  t: Translate,
  displayNameOf: (modelId: string) => string | null,
): string {
  switch (entry.action) {
    case 'upload':
      return t('canvas.task.title.upload', { name: entry.label });
    case 'generate':
      return t('canvas.task.title.generate', { name: displayNameOf(entry.label) ?? entry.label });
    case 'understand':
      return t('canvas.task.title.understand', {
        name: entry.label === UNDERSTAND_MODEL.id ? UNDERSTAND_MODEL.displayName : entry.label,
      });
    case 'mini_tool': {
      // A tool id written before the registry existed is shown as stored.
      const tool = miniToolById(entry.label);
      return tool ? t(tool.labelKey) : entry.label;
    }
  }
}
