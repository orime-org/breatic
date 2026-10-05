// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useFocusReturn, type FocusReturn } from '@web/lib/use-focus-return';
import { whenBlurLeaves } from '@web/spaces/canvas/blur-left';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';

/** The props a text box takes from {@link useDraftBox}. */
export interface DraftBoxProps {
  ref: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * A text box whose value is written when the reader leaves it or presses
 * Enter, so each edit is one canvas undo step. The Enter that confirms an IME
 * word is not the reader finishing.
 *
 * Its Space hidden by a switch of Space is not the reader leaving: the words
 * typed so far stay in the box, and the caret goes back in when the Space is
 * shown again (inner#1235 A13).
 * @param held - The value the node holds.
 * @param onCommit - Called with a changed value.
 * @returns The props for the box.
 */
export function useDraftBox(held: string, onCommit: (next: string) => void): DraftBoxProps {
  const { spaceId } = useCanvasContext();
  const [draft, setDraft] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLInputElement>(null);
  const commit = React.useCallback((): void => {
    if (draft !== null && draft !== held) onCommit(draft);
    setDraft(null);
  }, [draft, held, onCommit]);
  const [focusReturn] = React.useState<FocusReturn>(() => ({
    hadFocus: false,
    returning: false,
  }));
  useFocusReturn(
    focusReturn,
    () => ref.current !== null && document.activeElement === ref.current,
    () => ref.current?.focus(),
  );
  const onChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setDraft(event.target.value);
  }, []);
  const onBlur = React.useCallback((): void => {
    whenBlurLeaves(spaceId, commit);
  }, [spaceId, commit]);
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit();
    },
    [commit],
  );
  return { ref, value: draft ?? held, onChange, onBlur, onKeyDown };
}
