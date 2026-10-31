// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a task row opens with (inner#1454): a badge naming the kind of task,
 * drawn as the history panel draws its rows, then what the task acted on.
 * Every state of the row opens the same way, so an upload, a generation, a
 * reading and a tool run read apart at a glance.
 */

import { ArrowUp, Captions, ScanText, Sparkles, type LucideIcon } from 'lucide-react';
import { UNDERSTAND_MODEL, type NodeTaskEntry } from '@breatic/shared';
import { miniToolById } from '@breatic/shared/mini-tools';

import { MINI_TOOL_ICONS } from '@web/spaces/canvas/mini-tool/tool-icons';

/** A translator, as the rows are given one. */
type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/** The badge and the text after it. */
export interface TaskRowKind {
  /** The badge's icon. */
  icon: LucideIcon;
  /** The badge's word. */
  label: string;
  /** The file, address or model the task acted with; null for a tool, whose badge says it all. */
  detail: string | null;
}

/**
 * The row's kind.
 * @param entry - The task's action and label.
 * @param entry.action - What the task was doing.
 * @param entry.label - The file name or address, the model id, or the tool id.
 * @param t - The translator.
 * @param displayNameOf - The catalog's name for a model id, or null when the
 *   catalog does not serve it (the id is shown then).
 * @returns The badge and what follows it.
 */
export function taskRowKind(
  entry: Pick<NodeTaskEntry, 'action' | 'label'>,
  t: Translate,
  displayNameOf: (modelId: string) => string | null,
): TaskRowKind {
  switch (entry.action) {
    case 'upload':
      return { icon: ArrowUp, label: t('canvas.task.kind.upload'), detail: entry.label };
    case 'generate':
      return {
        icon: Sparkles,
        label: t('canvas.task.kind.generate'),
        detail: displayNameOf(entry.label) ?? entry.label,
      };
    case 'understand':
      return {
        icon: ScanText,
        label: t('canvas.task.kind.understand'),
        detail: entry.label === UNDERSTAND_MODEL.id ? UNDERSTAND_MODEL.displayName : entry.label,
      };
    case 'transcribe':
      return {
        icon: Captions,
        label: t('canvas.task.kind.transcribe'),
        detail: entry.label === UNDERSTAND_MODEL.id ? UNDERSTAND_MODEL.displayName : entry.label,
      };
    case 'mini_tool': {
      // A tool id written before the registry existed is shown as stored.
      const tool = miniToolById(entry.label);
      return tool
        ? { icon: MINI_TOOL_ICONS[tool.icon], label: t(tool.labelKey), detail: null }
        : { icon: Sparkles, label: entry.label, detail: null };
    }
  }
}
