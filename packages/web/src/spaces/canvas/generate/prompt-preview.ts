// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The line a collapsed prompt row shows (#1201): the first line with words in
 * it, read the way the box shows it. A chip reads as the name on its pill and
 * a note as its prefixed line, so the row matches what opening it reveals.
 */

import * as React from 'react';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import type * as Y from 'yjs';

import { useTranslation } from '@web/i18n/use-translation';
import { PROMPT_NOTE_LABEL_ATTR, PROMPT_NOTE_NODE } from '@web/features/prompt-note/prompt-note';
import { chipDisplayText } from '@web/spaces/canvas/generate/reference-mention';

/** The interface words the box itself draws around stored content. */
export interface PreviewWords {
  /** What a chip with no name shows (`canvas.generatePanel.reference`). */
  reference: string;
  /** What a note's line starts with (`canvas.generatePanel.notePrefix`). */
  notePrefix: string;
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
 * A prompt's preview line, kept up to date as anyone types into it.
 * @param fragment - The prompt.
 * @returns The line, or the empty string for a prompt with no words.
 */
export function usePromptPreviewLine(fragment: Y.XmlFragment): string {
  const t = useTranslation();
  const reference = t('canvas.generatePanel.reference');
  const notePrefix = t('canvas.generatePanel.notePrefix');
  const subscribe = React.useCallback(
    (notify: () => void): (() => void) => {
      fragment.observeDeep(notify);
      return () => fragment.unobserveDeep(notify);
    },
    [fragment],
  );
  const read = React.useCallback(
    (): string => promptPreviewLine(fragment, { reference, notePrefix }),
    [fragment, reference, notePrefix],
  );
  return React.useSyncExternalStore(subscribe, read);
}
