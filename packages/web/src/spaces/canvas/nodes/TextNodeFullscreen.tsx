// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';

import { useEditedTextBody, useTextBody } from '@web/data/yjs/use-text-body';
import { useTranslation } from '@web/i18n/use-translation';
import { spaceFocusRoot } from '@web/lib/space-focus-root';
import { useCanvasContext, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { flowNodeWrapper } from '@web/spaces/canvas/flow-node-wrapper';
import { endKeptEditor } from '@web/spaces/canvas/kept-editors';
import { MODALITY_LABEL } from '@web/spaces/canvas/nodes/_shared/modality';
import { TextFullscreen } from '@web/spaces/canvas/nodes/_shared/TextFullscreen';
import { TextNodeEditor } from '@web/spaces/canvas/nodes/TextNodeEditor';

/** Props for {@link TextNodeFullscreen}. */
interface TextNodeFullscreenProps {
  /** The node open full screen. */
  nodeId: string;
  /** Its name; the modality's label when blank. */
  name: string | undefined;
  /** Whether the node is still on the canvas, read from the graph, which culling never trims. */
  exists: boolean;
  /** Whether the node's own lock is on. */
  locked: boolean;
}

/**
 * What the full-screen editor is kept under: apart from the in-place one, so
 * closing either ends only its own.
 * @param nodeId - The node.
 * @returns The key.
 */
function fullscreenEditorKey(nodeId: string): string {
  return `${nodeId}:fullscreen`;
}

/** Writing classes for the reading size; the box metrics of a node body do not apply here. */
const FULLSCREEN_EDITOR_CLASS = 'min-h-[60vh] p-0 text-base leading-7 focus:bg-transparent';

/**
 * A text node open full screen (inner#2115). It belongs to the canvas, not to
 * the node: a node culled out of view, or carried off screen by following a
 * collaborator, keeps it. It has an editor of its own on the node's body, kept
 * under its own key, so a hidden Space comes back to it as the in-place editor
 * does (inner#1235 A13); the in-place editor has ended before it opens, so one
 * editor at a time publishes this person's caret. Writing follows the node's
 * lock and the person's role as they change; the node leaving the canvas
 * closes it.
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.name - Its name.
 * @param root0.exists - Whether it is still on the canvas.
 * @param root0.locked - Whether its own lock is on.
 * @returns The layer.
 */
export function TextNodeFullscreen({ nodeId, name, exists, locked }: TextNodeFullscreenProps): React.JSX.Element | null {
  const t = useTranslation();
  const { projectId, spaceId, readOnly, caretProvider } = useCanvasContext();
  const sessionStore = useCanvasSessionStore();
  const canWrite = !readOnly && !locked;
  const key = fullscreenEditorKey(nodeId);
  const text = useTextBody(projectId, spaceId, nodeId);
  // A body replaced by a repair arrives here as the new fragment, and the
  // editor rebuilds on it; one gone with the node is answered by `exists`.
  const editedBody = useEditedTextBody(projectId, spaceId, nodeId, canWrite && exists, () => undefined);

  const close = React.useCallback((): void => {
    endKeptEditor(spaceId, key);
    sessionStore.getState().closeTextFullscreen(nodeId);
  }, [sessionStore, spaceId, key, nodeId]);

  React.useEffect(() => {
    if (!exists) close();
  }, [exists, close]);
  // Locked or no longer allowed to write: the editor goes, so no editor of a
  // person who may only read keeps publishing their caret (TextNode round-5).
  React.useEffect(() => {
    if (!canWrite) endKeptEditor(spaceId, key);
  }, [canWrite, spaceId, key]);

  const onLeave = React.useCallback(
    (focus: 'return-focus' | 'keep-focus'): void => {
      // A blur inside full screen is not leaving it: the title bar and the
      // scrollbar take focus too. The layer takes every Escape before the
      // editor sees it; an Escape that reaches the editor some other way
      // closes the layer as well.
      if (focus === 'return-focus') close();
    },
    [close],
  );

  if (!exists) return null;
  return (
    <TextFullscreen
      title={name && name.length > 0 ? name : MODALITY_LABEL.text}
      readOnly={!canWrite}
      onClose={close}
      onOpenFocus={(body) => {
        const editable = body.querySelector<HTMLElement>('[contenteditable="true"]');
        (editable ?? body).focus();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const target = flowNodeWrapper(spaceId, nodeId) ?? spaceFocusRoot(spaceId);
        target?.focus({ preventScroll: true });
      }}
    >
      {canWrite && editedBody !== null ? (
        <div data-testid='text-fullscreen-editor'>
          <TextNodeEditor
            spaceId={spaceId}
            nodeId={nodeId}
            editorKey={key}
            fragment={editedBody}
            caretProvider={caretProvider}
            placeholder={t('canvas.textNode.editorPlaceholder')}
            className={FULLSCREEN_EDITOR_CLASS}
            editable
            onLeave={onLeave}
          />
        </div>
      ) : (
        <div data-testid='text-fullscreen-readonly' className='min-h-[60vh] select-text whitespace-break-spaces break-words'>
          {text}
        </div>
      )}
    </TextFullscreen>
  );
}
