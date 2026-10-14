// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { useUploadMark } from '@web/spaces/canvas/nodes/_shared/use-upload-mark';

/**
 * Lets an empty node's placeholder say it draws the uploader's mark itself,
 * in place of its call to action, so the frame does not draw a second one.
 * Null outside a content frame.
 */
export const UploadMarkPlaceholderContext: React.Context<((shown: boolean) => void) | null> =
  React.createContext<((shown: boolean) => void) | null>(null);

/**
 * Tell the surrounding frame that this placeholder draws the mark, for as long
 * as it is mounted.
 * @throws {never} Never.
 */
export function useClaimUploadMark(): void {
  const claim = React.useContext(UploadMarkPlaceholderContext);
  React.useLayoutEffect(() => {
    if (claim === null) return undefined;
    claim(true);
    return () => claim(false);
  }, [claim]);
}

/**
 * The uploader's own mark over a node that already shows something (inner#1303
 * §6.7): a skeleton over the content until the server answers, and a line along
 * the bottom saying why it ended before that. Drawn by the frame every content
 * node shares, so every modality has it.
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
      className='absolute inset-x-1 bottom-1 bg-popover px-2 py-1 text-xs text-status-error'
    >
      {'text' in mark.message ? mark.message.text : t(mark.message.key, mark.message.params)}
    </span>
  );
}
