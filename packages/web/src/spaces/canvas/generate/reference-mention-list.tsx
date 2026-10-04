// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One row of the generate panel's `@` list: the source's thumbnail (or its
 * modality icon) and its node name. The list around it is the shared one
 * (features/reference-mention/mention-list).
 */

import { Crop } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';

/**
 * The key a reference row is listed under.
 * @param item - The row.
 * @returns Its source node id.
 */
export function referenceKey(item: ReferenceRailItem): string {
  return item.sourceNodeId;
}

interface ReferenceRowProps {
  /** The pool row to show. */
  item: ReferenceRailItem;
}

/**
 * What a reference row shows inside the `@` list.
 * @param root0 - Component props.
 * @param root0.item - The pool row to show.
 * @returns The row's content.
 */
export function ReferenceRow({ item }: ReferenceRowProps): React.JSX.Element {
  const t = useTranslation();
  // A source with no thumbnail (text / audio / …) shows its MODALITY icon,
  // not a blanket broken-image glyph — the same getNodeIcon the prompt chip
  // uses, so the picker and the inserted chip read identically (P4, user
  // 2026-07-12).
  const FallbackIcon = getNodeIcon(item.sourceNodeType);
  return (
    <>
      {typeof item.thumbnail === 'string' && item.thumbnail.length > 0 ? (
        <img
          src={item.thumbnail}
          alt=''
          className='h-6 w-6 shrink-0 rounded-sm object-cover'
          draggable={false}
        />
      ) : (
        <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-muted'>
          <FallbackIcon className='h-3 w-3' aria-hidden='true' />
        </span>
      )}
      {/* Crop glyph before the name marks a focus copy so a standalone focus
          crop reads apart from a live node reference in the picker (user
          2026-07-17, consistent with rail + chip). */}
      {item.focus ? (
        <>
          <Crop
            data-testid={`reference-mention-option-focus-badge-${item.sourceNodeId}`}
            className='h-3 w-3 shrink-0'
            aria-hidden='true'
          />
          <span className='sr-only'>{t('canvas.generatePanel.focusCropTag')}</span>
        </>
      ) : null}
      <span className='truncate'>{item.sourceNodeName || t('canvas.generatePanel.reference')}</span>
    </>
  );
}

/**
 * {@link ReferenceRow} as the shared list's row renderer.
 * @param item - The pool row.
 * @returns The row's content.
 */
export function renderReferenceRow(item: ReferenceRailItem): React.ReactNode {
  return <ReferenceRow item={item} />;
}
