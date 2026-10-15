// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { useUploadMark } from '@web/spaces/canvas/nodes/_shared/use-upload-mark';

/**
 * The uploader's own mark over a node that already shows something (inner#1303
 * §6.7): a skeleton over the content until the server answers, and a line along
 * the bottom saying why it ended before that, which presses go through to the
 * content under it (a player's controls sit on that edge). Drawn in the branch of
 * `NodeContent` every content node shows its content through, so every
 * modality has it; an empty node's placeholder draws the mark itself.
 * @returns The overlay, or null when the node has no mark.
 * @throws {never} Never.
 */
export function NodeUploadMarkOverlay(): React.JSX.Element | null {
  const t = useTranslation();
  const mark = useUploadMark();
  if (mark === undefined) return null;
  if (mark.state === 'waiting') {
    return <Skeleton data-testid='node-upload-skeleton' className='absolute inset-1 rounded-none' />;
  }
  return (
    <span
      data-testid='node-upload-error'
      className='pointer-events-none absolute inset-x-1 bottom-1 bg-popover px-2 py-1 text-xs text-status-error wrap-anywhere'
    >
      {'text' in mark.message ? mark.message.text : t(mark.message.key, mark.message.params)}
    </span>
  );
}
