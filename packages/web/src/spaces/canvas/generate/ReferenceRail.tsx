// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { X } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ThumbnailHoverPreview } from '@web/spaces/canvas/generate/ThumbnailHoverPreview';
import { canConnect } from '@web/spaces/canvas/lib/connection-rules';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';

interface ReferenceRailProps {
  /** The node's derived reference rows (from {@link deriveReferences}). */
  references: ReferenceRailItem[];
  /** Remove a reference by id — the caller deletes the backing edge. */
  onRemove: (refId: string) => void;
  /** Insert this reference's @-mention into the prompt at the cursor (chip click). */
  onInsert: (item: ReferenceRailItem) => void;
  /**
   * Grey out + de-activate the rail — set in text-to-image, which ignores
   * source images (mode toggle 2026-07-09 §2.5). The chips still render (so the
   * node's edges stay visible) but are non-interactive; switch to image-to-image
   * to manage them.
   */
  disabled?: boolean;
}

/**
 * The Generate panel's reference rail: one chip per incoming edge (a connection
 * IS a reference). Each chip shows the source node's live thumbnail + name and
 * a ✕ that removes it (the caller deletes the backing edge). Renders nothing
 * when the node has no references.
 * @param root0 - Component props.
 * @param root0.references - The derived reference rows.
 * @param root0.onRemove - Remove a reference by id.
 * @param root0.onInsert - Insert a reference's @-mention into the prompt.
 * @returns The reference rail, or null when empty.
 */
export const ReferenceRail = React.memo(function ReferenceRail({
  references,
  onRemove,
  onInsert,
  disabled = false,
}: ReferenceRailProps): React.JSX.Element | null {
  const t = useTranslation();
  if (references.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap gap-1.5 ${disabled ? 'opacity-50' : ''}`}
      role='list'
      data-testid='generate-reference-rail'
    >
      {references.map((ref) => {
        const NodeIcon = getNodeIcon(ref.sourceNodeType);
        // Legacy-edge parity with the @ picker (round-2 adversarial): a
        // pre-rules incompatible edge (audio/video → image) stays listed so
        // the user can REMOVE it, but inserting it as an @-mention would
        // recreate the execute-time dead-end the connection rules eliminated
        // — the picker refuses to offer it, so the rail refuses to insert it.
        const insertable = canConnect(ref.sourceNodeType, 'image');
        return (
          <div
            key={ref.refId}
            role='listitem'
            data-testid={`generate-ref-${ref.refId}`}
            className='group relative flex items-center gap-1.5 rounded-overlay border border-border bg-background/60 py-1 pl-1 pr-1.5'
          >
            <ThumbnailHoverPreview
              src={ref.thumbnail}
              text={ref.textContent}
              alt={ref.sourceNodeName}
            >
              <button
                type='button'
                data-testid={`generate-ref-insert-${ref.refId}`}
                aria-label={t('canvas.generatePanel.insertReference')}
                // preventDefault on mousedown keeps the prompt editor focused, so
                // the mention lands at the caret (not appended to the end).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInsert(ref)}
                disabled={disabled || !insertable}
                className='flex items-center gap-1.5 rounded-overlay disabled:cursor-not-allowed'
              >
                {ref.thumbnail ? (
                  <img
                    src={ref.thumbnail}
                    alt={ref.sourceNodeName}
                    className='h-6 w-6 shrink-0 rounded object-cover'
                  />
                ) : (
                  <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground'>
                    <NodeIcon className='h-3.5 w-3.5' aria-hidden='true' />
                  </span>
                )}
                <span className='max-w-[7rem] truncate text-xs text-foreground'>
                  {ref.sourceNodeName}
                </span>
              </button>
            </ThumbnailHoverPreview>
            <button
              type='button'
              data-testid={`generate-ref-remove-${ref.refId}`}
              aria-label={t('canvas.generatePanel.removeReference')}
              onClick={() => onRemove(ref.refId)}
              disabled={disabled}
              className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed'
            >
              <X className='h-3 w-3' aria-hidden='true' />
            </button>
          </div>
        );
      })}
    </div>
  );
});
