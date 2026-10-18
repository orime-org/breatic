// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { miniToolById } from '@breatic/shared/mini-tools';
import { useNodeId } from '@xyflow/react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { cn } from '@web/lib/utils';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { useTranslation } from '@web/i18n/use-translation';
import { MODALITY_ICONS } from '@web/spaces/canvas/nodes/_shared/modality';
import {
  NodeBusyContext,
  PeerActivityContext,
} from '@web/spaces/canvas/nodes/_shared/node-peer-activity-context';
import { useUploadMark } from '@web/spaces/canvas/nodes/_shared/use-upload-mark';
import type { Modality } from '@web/data/yjs/node-view';

interface NodePlaceholderProps {
  modality: Modality;
  /**
   * Fires the call-to-action (upload a file / write): double-click, or Enter /
   * Space while the button has focus.
   */
  onActivate?: () => void;
}

/**
 * The line saying who else is doing what to this node (inner#1303 §6.8), or
 * null when there is none to show: no one is, the node has tasks, or the
 * roster cannot name them.
 * @returns The sentence, or null.
 * @throws {never} Never.
 */
function usePeerLine(): string | null {
  const t = useTranslation();
  const nodeId = useNodeId();
  const table = React.useContext(PeerActivityContext);
  const busy = React.useContext(NodeBusyContext);
  const names = useCollaboratorNames();
  const act = nodeId === null || busy ? undefined : table.get(nodeId);
  const name = act ? names?.resolve(act.userId) : null;
  if (!act || !name) return null;
  if (act.action === 'upload') return t('canvas.nodePlaceholder.peer.upload', { name });
  if (act.action === 'readText') return t('canvas.nodePlaceholder.peer.readText', { name });
  const tool = miniToolById(act.action);
  if (!tool) return null;
  return t('canvas.nodePlaceholder.peer.tool', { name, tool: t(tool.labelKey) });
}

/**
 * Empty-state body shown when a content node has no `content` / `url` yet. Two
 * lines: the modality's primary double-click action (upload / write), then a
 * shared, smaller hint pointing at the right-click menu (generate & more). Both
 * lines are i18n keys. A single click selects the node; a **double**-click, or
 * Enter / Space on the focused button, fires `onActivate`. What it shows
 * goes in this order (inner#1303 §6.8): the viewer's own upload still awaited
 * shows a skeleton; else someone else filling the node puts who and what on
 * the first line; else the viewer's own failed upload shows why; else the two
 * lines.
 *
 * The keyboard half is not a bonus feature — `Button` renders a real
 * `<button>`, so it is
 * focusable and clicking an empty node lands focus here
 * rather than on the node wrapper. Without a keyboard path the most common
 * sequence there (click the node, press Enter to start) would do nothing at
 * all, and the node most in need of a way in is exactly the empty one. The
 * browser turns a keyboard activation into a click with no pointer behind it,
 * which is what `detail === 0` means; a real click keeps its count and still
 * only selects the node.
 * @param root0 - Node placeholder props.
 * @param root0.modality - Node modality, selecting the icon and the primary-line copy.
 * @param root0.onActivate - Called on double-click, or on Enter / Space while
 *   the button has focus, to upload a file / enter edit.
 * @returns The empty-state call-to-action button.
 */
export function NodePlaceholder({
  modality,
  onActivate,
}: NodePlaceholderProps): React.JSX.Element {
  const t = useTranslation();
  const Icon = MODALITY_ICONS[modality];
  // The uploader's own mark (inner#1303 §6.7): a skeleton while the server's
  // answer is awaited, a line saying why when it ended before that.
  const mark = useUploadMark();
  const waiting = mark?.state === 'waiting';
  // Someone else filling the node is shown over the viewer's own failure
  // line, an operation that ended; the viewer's own skeleton wins over both.
  const peerLine = usePeerLine();
  const failed = mark?.state === 'failed' && peerLine === null ? mark.message : undefined;
  return (
    <Button
      type='button'
      // No variant, no size: the node shell already draws this control's
      // frame and the 9th-slice system fixes how a node body answers hover
      // (it brightens its text rather than filling), so every chrome the
      // primitive could add would be a second edge or a wrong hover. The
      // classes below are the whole appearance. NodePlaceholder.test.tsx
      // pins the hover behaviour.
      variant={null}
      size={null}
      onDoubleClick={onActivate}
      onClick={(event) => {
        if (event.detail === 0) onActivate?.();
      }}
      data-testid='node-placeholder'
      data-modality={modality}
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-2 whitespace-normal text-center',
        waiting ? 'p-1' : 'p-4',
        failed ? 'text-status-error' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {waiting ? (
        <Skeleton data-testid='node-upload-skeleton' className='h-full w-full rounded-sm' />
      ) : (
        <Icon className='h-5 w-5 shrink-0 opacity-70' aria-hidden='true' />
      )}
      {waiting ? null : failed ? (
        <span data-testid='node-upload-error' className='text-xs wrap-anywhere'>
          {'text' in failed ? failed.text : t(failed.key, failed.params)}
        </span>
      ) : (
        <span className='flex flex-col gap-0.5'>
          <span
            className='text-xs'
            data-testid={peerLine === null ? undefined : 'node-peer-activity'}
          >
            {peerLine ?? t(`canvas.nodePlaceholder.${modality}`)}
          </span>
          <span className='text-2xs text-muted-foreground'>
            {t('canvas.nodePlaceholder.rightClickHint')}
          </span>
        </span>
      )}
    </Button>
  );
}
