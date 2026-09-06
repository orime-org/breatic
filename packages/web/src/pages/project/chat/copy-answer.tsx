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

interface CopyAnswer {
  /** Whether the last press is still being answered. */
  answered: boolean;
  /** Puts the text on the clipboard and starts the answer. */
  copy: () => void;
}

/**
 * Copying, and saying it worked.
 *
 * Every copy in the panel behaves this way -- the one under a reply, the one
 * under a reader's own message, the one over a code block -- so all three ask
 * here rather than each keeping its own state and its own timer.
 * @param source - What goes on the clipboard, or a way to read it at the
 *   moment of the press. A code block reads its own rendered text, which the
 *   highlighter rebuilds, so a copy held from an earlier render would be the
 *   version before whatever the last rebuild did.
 * @returns Whether the answer is up, and the press handler.
 */
export function useCopyAnswer(source: string | (() => string)): CopyAnswer {
  const t = useTranslation();
  const [answered, setAnswered] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Read through a ref so the handler keeps one identity: it is passed to a
  // memoised button, and a fresh one each render would defeat the memo.
  const latest = React.useRef(source);
  latest.current = source;

  React.useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const copy = React.useCallback(() => {
    const text = typeof latest.current === 'function' ? latest.current() : latest.current;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        // A second press while the answer is up leaves the first timer
        // running, so the answer neither flickers nor outstays the press
        // that put it there.
        if (timer.current !== undefined) return;
        setAnswered(true);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          setAnswered(false);
        }, COPY_ANSWER_MS);
      })
      .catch(() => {
        toast.error(t('common.clipboardError'));
      });
  }, [t]);

  return { answered, copy };
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
  /** Whether the label hangs below the button rather than above it. */
  below?: boolean;
}

/**
 * What a press says back.
 *
 * A status rather than a description of the control, so it is said here
 * rather than through the tooltip primitive: a tooltip is what hovering an
 * element tells you about it, and this is what pressing it did. Nothing in it
 * can be pointed at, so it needs none of what a real overlay is for.
 * @param root0 - The component props.
 * @param root0.side - Which edge of the button the label hangs from.
 * @param root0.below - Whether it hangs below the button.
 * @returns The label.
 */
export function CopyAnswerLabel({ side, below }: CopyAnswerLabelProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <span
      data-testid='copy-answer'
      role='status'
      className={cn(
        'pointer-events-none absolute z-10 whitespace-nowrap rounded-chrome bg-accent-strong px-2 py-1 text-2xs leading-none text-foreground',
        below === true ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
        side === 'right' ? 'right-0' : 'left-0',
      )}
    >
      {t('chat.action.copied')}
    </span>
  );
}
