// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The line a collapsed prompt row shows (#1201): the first line with words in
 * it, read the way the box shows it. A chip reads as the name on its pill and
 * a note as its prefixed line, so the row matches what opening it reveals;
 * what the model is sent for a chip is a different text and plays no part.
 */

import * as React from 'react';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import type * as Y from 'yjs';

import { PROMPT_NOTE_LABEL_ATTR, PROMPT_NOTE_NODE } from '@web/features/prompt-note/prompt-note';
import { chipDisplayText } from '@web/spaces/canvas/generate/reference-mention';

/** The interface words the box itself draws around stored content. */
export interface PreviewWords {
  /** What a chip with no name shows (`canvas.generatePanel.reference`). */
  reference: string;
  /** What a note's line starts with (`canvas.generatePanel.notePrefix`). */
  notePrefix: string;
}

/** One prompt to follow, by the id its row goes by. */
export interface PreviewSource {
  readonly id: string;
  readonly fragment: Y.XmlFragment;
}

/**
 * The first line of a prompt that has words in it, as the box shows it.
 * @param fragment - The prompt.
 * @param words - What the box draws for a nameless chip and before a note.
 * @returns The line, or the empty string for a prompt with no words.
 */
export function promptPreviewLine(fragment: Y.XmlFragment, words: PreviewWords): string {
  const text = bodyToPlainText(fragment, (element) =>
    element.nodeName === PROMPT_NOTE_NODE
      ? `${words.notePrefix}${String(element.getAttribute(PROMPT_NOTE_LABEL_ATTR) ?? '')}`
      : chipDisplayText(element, words.reference),
  );
  return text.split('\n').find((line) => line.trim() !== '') ?? '';
}

/**
 * Whether two preview records say the same thing.
 * @param a - One record.
 * @param b - The other.
 * @returns True when both hold the same lines under the same ids.
 */
function samePreviews(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Each prompt's preview line, kept up to date as anyone types into it.
 * @param sources - The prompts, stable between renders that do not change them.
 * @param words - The interface words, stable between renders.
 * @returns The lines by id; the same object until a line changes.
 */
export function usePromptPreviews(
  sources: readonly PreviewSource[],
  words: PreviewWords,
): Readonly<Record<string, string>> {
  const read = React.useCallback(
    (): Record<string, string> =>
      Object.fromEntries(sources.map((source) => [source.id, promptPreviewLine(source.fragment, words)])),
    [sources, words],
  );
  const [previews, setPreviews] = React.useState(read);
  React.useEffect(() => {
    /** Re-reads every line, keeping the old record when nothing changed. */
    const update = (): void => {
      const next = read();
      setPreviews((prev) => (samePreviews(prev, next) ? prev : next));
    };
    update();
    for (const source of sources) source.fragment.observeDeep(update);
    return () => {
      for (const source of sources) source.fragment.unobserveDeep(update);
    };
  }, [read, sources]);
  return previews;
}
