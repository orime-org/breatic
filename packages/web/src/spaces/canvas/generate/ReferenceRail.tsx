// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Crop, Loader2, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import {
  insertRefusal,
  isReferenceMaterial,
  type ReferenceUsabilityContext,
  type ReferenceRefusal,
} from '@web/spaces/canvas/generate/reference-usability';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';
import type { NodeKind } from '@web/spaces/canvas/types/node-view';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';

/**
 * Maps a row's modality to the preview form that can show it. Text previews
 * its body; the three media modalities preview themselves. Everything else
 * (3d / web / annotation / group) has no preview form of its own and falls
 * back to the image one, where — having no asset to show — it opens on the
 * empty hint. That is a change from before: main gave a hint to an image or a
 * video row with no thumbnail and to a text row with no body, so these four
 * kinds fell through to `undefined` and opened no card at all. No product path
 * creates such a row, because `connection-rules` lets neither an image nor a
 * video node take one, so the change is unreachable rather than intended.
 * @param kind - The upstream node's modality.
 * @returns The preview form to declare.
 */
function previewKindOf(kind: NodeKind): 'image' | 'text' | 'audio' | 'video' {
  switch (kind) {
    case 'text':
      return 'text';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
      return 'image';
  }
}

interface ReferenceRailProps {
  /** The node's derived reference rows (from `deriveReferences`). */
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
   * Does the active mode consume the reference pool at all? False dims every
   * REFERENCE MATERIAL row's CONTENT and refuses its insert. The row's ✕ is
   * untouched — it removes in every state (user 2026-08-19), so a row this
   * mode cannot use is still a row the user can clear.
   *
   * A text row is prompt material and outside this rule entirely (user
   * 2026-08-13). Among the rows it does govern the verdict never varies by
   * modality: dimming by type is what left audio / video rows looking live
   * inside a mode that would never read them (#1930, #1940).
   */
  modeTakesReferences?: boolean;
  /**
   * Does the ACTIVE MODEL consume the prompt (#1966)? False refuses INSERT on
   * every row — there is nowhere to insert into — and so dims every row.
   *
   * Text rows are exempt from `modeTakesReferences` because they are prompt
   * material; that exemption only holds while there IS a prompt. A mode
   * sending none has nothing for a text row to be material for, so it dims
   * there too (user 2026-08-16). A media row keeps answering to
   * `modeTakesReferences` as well: of the two questions, only that one names a
   * state the user can leave and reach a mode where the row WORKS.
   *
   * Defaulted `true` for the same reason as the prop above: a caller that
   * knows nothing about prompts gets the pre-#1966 rail.
   */
  modelTakesPrompt?: boolean;
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
 * @param root0.modeTakesReferences - Whether the active mode consumes the reference pool.
 * @param root0.modelTakesPrompt - Whether the active model consumes the prompt.
 * @param root0.pendingFocus - Focus crops whose upload is still in flight.
 * @returns The reference rail, or null when empty.
 */
export const ReferenceRail = React.memo(function ReferenceRail({
  references,
  onRemove,
  onInsert,
  modeTakesReferences = true,
  modelTakesPrompt = true,
  pendingFocus = [],
}: ReferenceRailProps): React.JSX.Element | null {
  const t = useTranslation();
  const usabilityCtx: ReferenceUsabilityContext = React.useMemo(
    () => ({
      takesReferences: modeTakesReferences,
      takesPrompt: modelTakesPrompt,
    }),
    [modeTakesReferences, modelTakesPrompt],
  );
  // Three refusal reasons, three messages, one each — they all belong to
  // insert now. Removal asks nothing since #1952, so there is no second family
  // and no crop variant (that one existed only because a focus crop has no
  // edge to delete, which mattered when removal could be refused).
  //
  // Each message names only the cause, not the way out: the mode selector is
  // in this same panel and every dimmed row is visibly dark, and UI copy states
  // the situation rather than explaining it (user 2026-08-17). Two of the three
  // predate that rule and are queued to follow it (todo #1970).
  const refuseInsert = React.useCallback(
    (refusal: ReferenceRefusal, kind: NodeKind): void => {
      if (refusal === 'model-takes-no-prompt') {
        toast.warning(t('canvas.generatePanel.refuseInsertNoPrompt'));
        return;
      }
      if (refusal === 'mode-takes-no-references') {
        toast.warning(t('canvas.generatePanel.refuseInsertModeOff'));
        return;
      }
      toast.warning(t('canvas.generatePanel.refuseInsertTypeUnused', { kind }));
    },
    [t],
  );
  if (references.length === 0 && pendingFocus.length === 0) return null;
  return (
    <div
      className='flex flex-wrap gap-1.5'
      role='list'
      data-testid='generate-reference-rail'
    >
      {references.map((ref) => {
        const NodeIcon = getNodeIcon(ref.sourceNodeType);
        // The one verdict on this row: can this mode use it. It drives the
        // content's dim and the insert button, and — through the same
        // `insertRefusal` call — what the `@` picker offers. The ✕ does not
        // consult it.
        const insertRefused = insertRefusal(ref.sourceNodeType, usabilityCtx);
        // Empty-source hint (H, user 2026-07-12): a source that has produced
        // nothing has no preview to show, so say so rather than opening a
        // blank card. Keyed on the ASSET rather than the thumbnail, because
        // the two answer different questions: a coverless video (#1821) has a
        // file to play and no still, and used to be called empty on the
        // strength of the missing still. `isReferenceMaterial` is
        // `kind !== 'text'`, so the second arm is the text one already and
        // needs no further test for it.
        const emptyHint = isReferenceMaterial(ref.sourceNodeType)
          ? ref.mediaUrl
            ? undefined
            : t('canvas.generatePanel.emptyImageReference')
          : ref.textContent
            ? undefined
            : t('canvas.generatePanel.emptyTextReference');
        return (
          <div
            key={ref.refId}
            role='listitem'
            data-testid={`generate-ref-${ref.refId}`}
            // The row itself never dims: the ✕ lives here too and it stays
            // usable in every state (user 2026-08-19). The dim belongs to the
            // CONTENT button below, which is the part this mode can or cannot
            // use. Keeping it on the row was what forced "the whole rail lights
            // or darkens together" — a per-row dim would have taken the ✕ with
            // it and left the user unable to clear a row they cannot use.
            //
            // Exactly one layer of opacity, on the content button. Two (a row
            // AND a control) would multiply to 0.25 and read as broken rather
            // than unavailable, which is what #1945 was fixing when it moved
            // the dim up here.
            //
            // The hover preview is unaffected either way: it is portaled, so
            // no opacity on this subtree reaches it, and that is the wanted
            // outcome — a dark row still shows its picture at full strength
            // (user 2026-08-13).
            className='group relative flex items-center gap-1.5 rounded-overlay border border-border bg-background/60 py-1 pl-1 pr-1.5'
          >
            <HoverPreview
              // The row's REAL modality, so audio and video preview as
              // something you can play — the same wiring the activity feed
              // already uses (`ProjectActivityButton.tsx`). Declaring every
              // non-text row as `image` was what made an audio reference
              // preview nothing at all (it has no thumbnail by design) and a
              // video reference preview a frozen cover.
              //
              // `src` is the asset itself and `poster` the still: a video
              // plays its file and shows its cover meanwhile, and the 24×24
              // `<img>` in the row below still uses `thumbnail`, because an
              // `<img>` pointed at an `.mp4` is a broken image (#1821).
              kind={previewKindOf(ref.sourceNodeType)}
              src={
                ref.mediaUrl
              }
              poster={ref.thumbnail}
              text={ref.textContent}
              alt={ref.sourceNodeName}
              emptyHint={emptyHint}
              followCanvas
            >
              <Button
                type='button'
                // The chip's own border (on the row wrapper) is what makes this
                // read as pressable, and the ✕ shares that frame — so this
                // button draws none of its own. `menu-item` is picked for its
                // metrics: it is the one size that imposes no height, leaving
                // the chip's. `p-0` keeps the padding on the wrapper, where it
                // was.
                variant={null}
                size={null}
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
                // aria-disabled, never the HTML `disabled` attribute: a
                // disabled element dispatches neither click nor pointerenter,
                // so it could neither explain its refusal nor open its hover
                // preview — and both are required here. The cursor stays
                // normal for the same reason: `not-allowed` would say
                // "clicking achieves nothing" while clicking is exactly how
                // the user finds out why (user 2026-08-13).
                aria-disabled={insertRefused !== null}
                onClick={() =>
                  insertRefused
                    ? refuseInsert(insertRefused, ref.sourceNodeType)
                    : onInsert(ref)
                }
                // The content dims exactly when it cannot be used, which is
                // the same answer the `@` popup gives this row (#1952). One
                // layer of opacity per row, and it is this one — the wrapper
                // no longer carries it, so 0.5 x 0.5 never happens.
                className={`flex items-center gap-1.5 rounded-overlay ${
                  insertRefused === null ? '' : 'opacity-50'
                }`}
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
                    // Same colour as the name it prefixes (text-foreground, the
                    // name span below), not the muted grey — the crop glyph is
                    // part of the row's identity, so it reads at full strength
                    // with the name rather than as a de-emphasised adornment
                    // (user 2026-07-19). The pending row keeps both glyph + name
                    // muted together (a placeholder), and the prompt chip already
                    // inherits text-foreground for both — so all three stay
                    // internally consistent (glyph matches its own name).
                    className='h-3 w-3 shrink-0 text-foreground'
                    aria-hidden='true'
                  />
                ) : null}
                <span className='max-w-[7rem] truncate text-xs text-foreground'>
                  {ref.sourceNodeName}
                </span>
              </Button>
            </HoverPreview>
            <Button
              type='button'
              variant={null}
              size={null}
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
              // Always usable, whatever the mode says about the content
              // (user 2026-08-19): a row you cannot use is exactly a row you
              // may want to clear, and the earlier "you might delete it by
              // accident" worry was withdrawn — the door swings both ways, a
              // deleted reference can be added back.
              onClick={() => onRemove(ref)}
              className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            >
              <X className='h-3 w-3' aria-hidden='true' />
            </Button>
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
