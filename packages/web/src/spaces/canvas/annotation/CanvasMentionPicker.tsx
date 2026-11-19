// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import type { CommentMention } from '@breatic/shared';

import { MentionPicker } from '@web/features/comment-mention/MentionPicker';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import type { DraftAction } from '@web/stores/annotation-draft';

interface CanvasMentionPickerProps {
  /** The note box being typed in. */
  boxRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Its words. */
  text: string;
  /** The draft the pick goes into. */
  onDraft: (action: DraftAction) => void;
}

/**
 * The `@` member list for a note box on the canvas: it follows the board
 * as it pans and zooms, and a pick goes into the box's draft.
 * @param props - The picker's props.
 * @param props.boxRef - The note box.
 * @param props.text - Its words.
 * @param props.onDraft - Receives the pick.
 * @returns The list.
 */
export function CanvasMentionPicker({ boxRef, text, onDraft }: CanvasMentionPickerProps): React.JSX.Element {
  const { projectId } = useCanvasContext();
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  const onPick = React.useCallback(
    (next: string, mention: CommentMention): void => {
      onDraft({ type: 'mention', text: next, mention });
    },
    [onDraft],
  );
  return (
    <MentionPicker
      projectId={projectId}
      boxRef={boxRef}
      text={text}
      onPick={onPick}
      onOpenChange={setOpen}
      avoidCollisions={false}
    />
  );
}
