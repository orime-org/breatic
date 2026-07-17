// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Crop, Loader2, X } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ThumbnailHoverPreview } from '@web/spaces/canvas/generate/ThumbnailHoverPreview';
import { canConnect } from '@web/spaces/canvas/lib/connection-rules';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';

interface ReferenceRailProps {
  /** The node's derived reference rows (from {@link deriveReferences}). */
  references: ReferenceRailItem[];
  /**
   * Remove a row — the caller routes by the ROW's identity (`focus: true`
   * → crop removal, else edge deletion). Routing by row, never by parsing
   * the id string: edge ids are untrusted collaborative data, and a
   * crafted edge id starting with `focus:` must not misroute the ✕
   * (adversarial round-2 2026-07-16).
   */
  onRemove: (item: ReferenceRailItem) => void;
  /** Insert this reference's @-mention into the prompt at the cursor (chip click). */
  onInsert: (item: ReferenceRailItem) => void;
  /**
   * Dim + de-activate the IMAGE rows only — set in text-to-image, which
   * ignores source images (mode toggle §2.5; scope ruled 2026-07-11, round-3
   * R3-4 = A). Text rows stay fully interactive because their @-chips still
   * serialize into the prompt in t2i — the same scoping as the editor's chip
   * dim, which greys image chips only. Dimmed image chips still render (edges
   * stay visible); switch to image-to-image to manage them.
   */
  imageRefsDisabled?: boolean;
  /**
   * Focus crops whose upload is still in flight (#1782) — rendered as
   * disabled placeholder rows after the real entries; each disappears when
   * its upload lands (a real focus row replaces it) or fails (toast).
   */
  pendingFocus?: ReadonlyArray<{ id: string; name: string }>;
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
 * @param root0.imageRefsDisabled - Dim + de-activate the image rows (t2i).
 * @returns The reference rail, or null when empty.
 */
export const ReferenceRail = React.memo(function ReferenceRail({
  references,
  onRemove,
  onInsert,
  imageRefsDisabled = false,
  pendingFocus = [],
}: ReferenceRailProps): React.JSX.Element | null {
  const t = useTranslation();
  if (references.length === 0 && pendingFocus.length === 0) return null;
  return (
    <div
      className='flex flex-wrap gap-1.5'
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
        const inert = imageRefsDisabled && ref.sourceNodeType === 'image';
        // Empty-source hint (H, user 2026-07-12): an image / video with no
        // thumbnail or a text node with no content has no preview to show, so
        // tell the user it's not yet filled instead of showing nothing.
        const emptyHint =
          (ref.sourceNodeType === 'image' ||
            ref.sourceNodeType === 'video') &&
          !ref.thumbnail
            ? t('canvas.generatePanel.emptyImageReference')
            : ref.sourceNodeType === 'text' && !ref.textContent
              ? t('canvas.generatePanel.emptyTextReference')
              : undefined;
        return (
          <div
            key={ref.refId}
            role='listitem'
            data-testid={`generate-ref-${ref.refId}`}
            className={`group relative flex items-center gap-1.5 rounded-overlay border border-border bg-background/60 py-1 pl-1 pr-1.5 ${inert ? 'opacity-50' : ''}`}
          >
            <ThumbnailHoverPreview
              src={ref.thumbnail}
              text={ref.textContent}
              alt={ref.sourceNodeName}
              emptyHint={emptyHint}
            >
              <button
                type='button'
                data-testid={`generate-ref-insert-${ref.refId}`}
                // The accessible name must carry the ROW identity + the crop
                // tag (adversarial round-2): aria-label overrides
                // name-from-content, so a bare action label made every row
                // announce identically — and an sr-only span inside the
                // button is dead for the same reason. ICU messages so each
                // locale owns order and punctuation (round-3); the empty
                // name falls back like the chip and the @-list do.
                aria-label={t(
                  ref.focus
                    ? 'canvas.generatePanel.insertFocusCropNamed'
                    : 'canvas.generatePanel.insertReferenceNamed',
                  {
                    name:
                      ref.sourceNodeName ||
                      t('canvas.generatePanel.reference'),
                  },
                )}
                // preventDefault on mousedown keeps the prompt editor focused, so
                // the mention lands at the caret (not appended to the end).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInsert(ref)}
                disabled={inert || !insertable}
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
                {ref.focus ? (
                  // Focus badge (F, user 2026-07-16): a crop glyph tells a
                  // standalone focus copy apart from a live node reference.
                  // Order: thumbnail → crop glyph → name (user 2026-07-17) so
                  // the badge reads as a prefix marker, consistent across the
                  // rail, the prompt chip, and the @-suggestion list.
                  // The SR counterpart lives in the button's aria-label
                  // above — content inside a labelled button never reaches
                  // the accessible name (adversarial round-2).
                  <Crop
                    data-testid={`generate-ref-focus-badge-${ref.refId}`}
                    className='h-3 w-3 shrink-0 text-muted-foreground'
                    aria-hidden='true'
                  />
                ) : null}
                <span className='max-w-[7rem] truncate text-xs text-foreground'>
                  {ref.sourceNodeName}
                </span>
              </button>
            </ThumbnailHoverPreview>
            <button
              type='button'
              data-testid={`generate-ref-remove-${ref.refId}`}
              // Same identity-carrying label as insert (round-3): the
              // destructive ✕ must not announce identically across
              // same-named rows either.
              aria-label={t(
                ref.focus
                  ? 'canvas.generatePanel.removeFocusCropNamed'
                  : 'canvas.generatePanel.removeReferenceNamed',
                {
                  name:
                    ref.sourceNodeName || t('canvas.generatePanel.reference'),
                },
              )}
              onClick={() => onRemove(ref)}
              disabled={inert}
              className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed'
            >
              <X className='h-3 w-3' aria-hidden='true' />
            </button>
          </div>
        );
      })}
      {pendingFocus.map((p) => (
        <div
          key={p.id}
          role='listitem'
          data-testid={`generate-focus-pending-${p.id}`}
          className='flex items-center gap-1.5 rounded-overlay border border-dashed border-border bg-background/60 py-1 pl-1 pr-1.5 opacity-70'
        >
          <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground'>
            <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
          </span>
          <Crop
            className='h-3 w-3 shrink-0 text-muted-foreground'
            aria-hidden='true'
          />
          <span className='sr-only'>
            {t('canvas.generatePanel.focusCropTag')}
          </span>
          <span className='max-w-[7rem] truncate text-xs text-muted-foreground'>
            {p.name}
          </span>
        </div>
      ))}
    </div>
  );
});
