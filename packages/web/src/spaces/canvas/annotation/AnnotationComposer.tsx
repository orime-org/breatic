// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The box that opens where somebody put a new note, before the note exists.
 *
 * The node is created on Enter, not on the click (#1881 §8.6). Creating it
 * first and then editing it would put a note with an empty body into the
 * document for every collaborator to see, which is the invariant §6.3 rests
 * on.
 *
 * The draft runs through `reduceDraft` with the `annotation` use — the same
 * reducer the sticky's edit box and reply box use, so one transition table
 * covers all three.
 */

import * as React from 'react';

import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { useAutosizeTextarea } from '@web/lib/use-autosize-textarea';
import {
  pressLandedOnTheBox,
  usePressKeepsFocus,
} from '@web/lib/use-press-keeps-focus';
import {
  NOTE_BOX_CLASS,
  NOTE_BOX_MAX_HEIGHT,
  NOTE_MAX_CHARS,
} from '@web/spaces/canvas/annotation/caps';
import { useNoteBox } from '@web/spaces/canvas/annotation/note-box-keys';
import { NoteScroller } from '@web/spaces/canvas/annotation/NoteScroller';
import {
  CLOSED_DRAFT,
  reduceDraft,
  type DraftAction,
  type DraftState,
} from '@web/stores/annotation-draft';

interface AnnotationComposerProps {
  /** Called with the body when the author presses Enter on something worth writing. */
  onCommit: (content: string) => void;
  /** Called whenever the box closes, whether or not anything was written. */
  onClose: () => void;
}

/**
 * Draw the new-note box.
 * @param root0 - The component props.
 * @param root0.onCommit - Receives the body worth writing.
 * @param root0.onClose - Runs when the box closes, committed or not.
 * @returns The floating composer.
 */
export function AnnotationComposer({
  onCommit,
  onClose,
}: AnnotationComposerProps): React.JSX.Element {
  const t = useTranslation();
  const boxRef = React.useRef<HTMLTextAreaElement>(null);
  // A press anywhere in the shell but the box leaves the caret where it is:
  // losing focus is how this box is told the person is done, and for a note
  // that does not exist yet that means the words go.
  const [shell, setShell] = React.useState<HTMLDivElement | null>(null);
  usePressKeepsFocus(shell, pressLandedOnTheBox);
  const [draft, setDraft] = React.useState<DraftState>(() =>
    reduceDraft(CLOSED_DRAFT, { type: 'open', use: 'annotation', text: '' }),
  );
  // The draft as it stands at the moment of an event: a state updater must
  // stay pure, and under StrictMode it runs twice, so the commit is written
  // from the handler instead. `apply` is the only writer of both.
  const draftRef = React.useRef(draft);
  // Always exactly as tall as what is written, so the box itself never
  // scrolls and never draws the browser's scrollbar; the panel below owns
  // the cap and the bar.
  useAutosizeTextarea(boxRef, draft.text);

  // Somebody pressed the tool and then clicked a spot; typing is the next
  // thing they mean to do. A ref rather than `autoFocus`, which the a11y rule
  // refuses.
  React.useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const apply = React.useCallback(
    (action: DraftAction): void => {
      const next = reduceDraft(draftRef.current, action);
      if (next === draftRef.current) return;
      draftRef.current = next;
      setDraft(next);
      if (next.commit !== undefined) onCommit(next.commit);
      if (next.mode === 'closed') onClose();
    },
    [onCommit, onClose],
  );
  // §6.2's one criterion for the IME, asked by every way out of this box —
  // here that is the blur as well as the keyboard.
  const placingBoxKeys = useNoteBox(apply);

  return (
    <div
      ref={setShell}
      className='w-[200px] rounded-chrome border border-note-border bg-note p-2 text-note-foreground shadow-md'
      data-testid='annotation-composer'
    >
      <NoteScroller
        cap={NOTE_BOX_MAX_HEIGHT}
        data-testid='annotation-composer-scroller'
      >
        <Textarea
          ref={boxRef}
          rows={2}
          maxLength={NOTE_MAX_CHARS}
          value={draft.text}
          placeholder={t('canvas.annotation.placeholder')}
          className={NOTE_BOX_CLASS}
          data-testid='annotation-composer-input'
          onChange={(e) => apply({ type: 'type', text: e.target.value })}
          {...placingBoxKeys.box}
          onBlur={() => {
            // Leaving the browser is not leaving the box: the whole document
            // loses focus, and coming back should find the words still here.
            // `relatedTarget` cannot tell that apart from a press on
            // something unfocusable, so the question is whether the document
            // has focus at all — the same criterion the text node's editor
            // asks (`TextNodeEditor.tsx`). This box is the one whose content
            // exists nowhere else, so nothing brings it back.
            if (!document.hasFocus()) return;
            if (placingBoxKeys.composing()) return;
            apply({ type: 'blur' });
          }}
        />
      </NoteScroller>
    </div>
  );
}
