// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ImageOff, X } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

interface ReferenceRailProps {
  /** The node's derived reference rows (from {@link deriveReferences}). */
  references: ReferenceRailItem[];
  /** Remove a reference by id — the caller deletes the backing edge. */
  onRemove: (refId: string) => void;
}

/**
 * The Generate panel's reference rail: one chip per incoming edge (a connection
 * IS a reference). Each chip shows the source node's live thumbnail + name and
 * a ✕ that removes it (the caller deletes the backing edge). Renders nothing
 * when the node has no references.
 * @param root0 - Component props.
 * @param root0.references - The derived reference rows.
 * @param root0.onRemove - Remove a reference by id.
 * @returns The reference rail, or null when empty.
 */
export const ReferenceRail = React.memo(function ReferenceRail({
  references,
  onRemove,
}: ReferenceRailProps): React.JSX.Element | null {
  const t = useTranslation();
  if (references.length === 0) return null;
  return (
    <div className='flex flex-wrap gap-1.5' role='list'>
      {references.map((ref) => (
        <div
          key={ref.refId}
          role='listitem'
          data-testid={`generate-ref-${ref.refId}`}
          className='group relative flex items-center gap-1.5 rounded-md border border-border bg-background/60 py-1 pl-1 pr-1.5'
        >
          {ref.thumbnail ? (
            <img
              src={ref.thumbnail}
              alt={ref.sourceNodeName}
              className='h-6 w-6 shrink-0 rounded object-cover'
            />
          ) : (
            <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground'>
              <ImageOff className='h-3.5 w-3.5' aria-hidden='true' />
            </span>
          )}
          <span className='max-w-[7rem] truncate text-xs text-foreground'>
            {ref.sourceNodeName}
          </span>
          <button
            type='button'
            data-testid={`generate-ref-remove-${ref.refId}`}
            aria-label={t('canvas.generatePanel.removeReference')}
            onClick={() => onRemove(ref.refId)}
            className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          >
            <X className='h-3 w-3' aria-hidden='true' />
          </button>
        </div>
      ))}
    </div>
  );
});
