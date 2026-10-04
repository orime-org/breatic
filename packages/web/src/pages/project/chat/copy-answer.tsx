// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * How long the answer to a press stays up.
 *
 * Long enough to be read after the eye has moved on, short enough that the
 * control is back to offering copy before the reader thinks to press again.
 */
export const COPY_ANSWER_MS = 1600;

/** A copy whose answer names what was copied. */
export interface KeyedCopy {
  /** The key of the copy still being answered, or null when none is. */
  answeredKey: string | null;
  /** Puts the text on the clipboard and answers it under the key. */
  copy: (text: string, key: string) => void;
}

/**
 * Copying, and saying it worked.
 *
 * Every copy in the panel behaves this way -- the one under a reply, the one
 * under a reader's own message, the one over a code block, the ones on a found
 * picture -- so all of them ask here rather than each keeping its own state
 * and its own timer. The key says which thing the answer belongs to, so
 * several buttons can share one answer and tell whose it is.
 * @returns The key being answered, and the press handler.
 */
export function useKeyedCopy(): KeyedCopy {
  const t = useTranslation();
  const [answeredKey, setAnsweredKey] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = React.useRef<string | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const copy = React.useCallback(
    (text: string, key: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          // A second press of the same thing while the answer is up leaves
          // the first timer running, so the answer neither flickers nor
          // outstays the press that put it there. Another thing takes over.
          if (timer.current !== undefined && current.current === key) return;
          if (timer.current !== undefined) clearTimeout(timer.current);
          current.current = key;
          setAnsweredKey(key);
          timer.current = setTimeout(() => {
            timer.current = undefined;
            current.current = null;
            setAnsweredKey(null);
          }, COPY_ANSWER_MS);
        })
        .catch(() => {
          toast.error(t('common.clipboardError'));
        });
    },
    [t],
  );

  return React.useMemo(() => ({ answeredKey, copy }), [answeredKey, copy]);
}

interface CopyAnswer {
  /** Whether the last press is still being answered. */
  answered: boolean;
  /** Puts the text on the clipboard and starts the answer. */
  copy: () => void;
}

/** The one key a single-source copy answers under. */
const ONLY = 'only';

/**
 * Copying one thing, and saying it worked.
 * @param source - What goes on the clipboard, or a way to read it at the
 *   moment of the press. A code block reads its own rendered text, which the
 *   highlighter rebuilds, so a copy held from an earlier render would be the
 *   version before whatever the last rebuild did.
 * @returns Whether the answer is up, and the press handler.
 */
export function useCopyAnswer(source: string | (() => string)): CopyAnswer {
  const keyed = useKeyedCopy();
  // Read through a ref so the source stays out of the handler's dependencies:
  // a source given as a function is a new one each render, and listing it
  // would rebuild the handler on every render of the message it sits under.
  const latest = React.useRef(source);
  latest.current = source;
  const { copy: copyKeyed } = keyed;
  const copy = React.useCallback(() => {
    const text = typeof latest.current === 'function' ? latest.current() : latest.current;
    copyKeyed(text, ONLY);
  }, [copyKeyed]);
  const answered = keyed.answeredKey !== null;
  return React.useMemo(() => ({ answered, copy }), [answered, copy]);
}

interface CopyAnswerLabelProps {
  /**
   * Which edge of the button the label hangs from.
   *
   * The label is wider than the button, so a centred one reaches past the
   * column it sits in and is clipped: measured at 1315 wide, the Chinese
   * words already lost 6px off the left and the Japanese ones four times
   * that. Each caller names the edge its button is against.
   */
  side: 'left' | 'right';
}

/**
 * What a press says back.
 *
 * A status rather than a description of the control, so it is said here
 * rather than through the tooltip primitive: a tooltip is what hovering an
 * element tells you about it, and this is what pressing it did. Nothing in it
 * can be pointed at, so it needs none of what a real overlay is for.
 *
 * Above the button, wherever the button is: a reader who has pressed copy
 * once knows where the word appears, and a second button that answered
 * somewhere else would be a second thing to learn.
 * @param root0 - The component props.
 * @param root0.side - Which edge of the button the label hangs from.
 * @returns The label.
 */
export function CopyAnswerLabel({ side }: CopyAnswerLabelProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <span
      data-testid='copy-answer'
      role='status'
      className={cn(
        'pointer-events-none absolute bottom-full z-10 mb-1.5 whitespace-nowrap rounded-chrome bg-accent-strong px-2 py-1 text-2xs leading-none text-foreground',
        side === 'right' ? 'right-0' : 'left-0',
      )}
    >
      {t('chat.action.copied')}
    </span>
  );
}
