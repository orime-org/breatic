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
  removeRefusal,
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
   * REFERENCE MATERIAL row and freezes its ✕ — references are shared across
   * modes, so a row thrown away in a mode that ignores it would be gone on
   * switching back (decision 2026-08-11). A text row is prompt material and
   * outside this rule entirely (user 2026-08-13). Among the rows it does
   * govern the verdict never varies by modality: dimming by type is what left
   * audio / video rows looking live and removable inside a mode that would
   * never read them (#1930, #1940). The ways out of a dark rail — switch to a
   * mode that uses references, or delete the edge on the canvas — are named by
   * the REMOVE message, the one refusal where the user is being denied
   * something they asked to be rid of (#1934).
   */
  modeTakesReferences?: boolean;
  /**
   * Does the ACTIVE MODEL consume the prompt (#1966)? False freezes INSERT on
   * every row — there is nowhere to insert into — and the ✕ on TEXT rows only,
   * which also dims them (the dim reads the ✕ verdict).
   *
   * Text rows are exempt from `modeTakesReferences` because they are prompt
   * material; that exemption only holds while there IS a prompt. A mode
   * sending none has nothing for a text row to be material for, so it freezes
   * there too (user 2026-08-16). A media row keeps answering to
   * `modeTakesReferences`: of the two questions, only that one names a state
   * the user can leave and reach a mode where the row WORKS, and both controls
   * on a row have to give the same first answer or the row would show two
   * contradictory reasons at once.
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
  // Three refusal reasons, six messages, and the split is not 3 + 3 by reason:
  // insert states all three; remove states only two (`source-type-unused` never
  // reaches it) and one of those splits by row, because a focus crop has no
  // edge to delete.
  // Insert names only the cause, because the mode selector is in this same
  // panel and every dimmed row is visibly dark. The reference-family remove
  // messages also name the way out, which is why the crop variant exists at
  // all — a focus crop has no edge to delete, so the shared sentence would
  // offer it an exit it does not have.
  //
  // The no-prompt remove message names no way out: UI copy states the
  // situation and does not explain it (user 2026-08-17), and this one fires on
  // a click, where a paragraph is the wrong shape. The two reference sentences
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
  const refuseRemove = React.useCallback(
    (refusal: ReferenceRefusal, isCrop: boolean): void => {
      // Remove takes the REASON now, not just the crop flag (#1966). Reusing
      // the insert copy here would answer a different question than the one
      // asked — the user clicked ✕, and "no prompt to insert into" tells them
      // nothing about getting rid of the row. Freezing a control while being
      // unable to explain itself is exactly what `aria-disabled` rather than
      // the HTML attribute exists to avoid.
      //
      // No crop variant on this branch, and it is not an omission: this reason
      // reaches the ✕ only for a TEXT row (`removeRefusal` asks the reference
      // question for every other kind), while a focus crop is always an image
      // row (`focusToRailItem` writes `sourceNodeType: 'image'`). The two
      // cannot coexist, so a crop-specific message here would be a string no
      // one could ever read.
      if (refusal === 'model-takes-no-prompt') {
        toast.warning(t('canvas.generatePanel.refuseRemoveNoPrompt'));
        return;
      }
      // A focus crop is a standalone copy, not an edge projection — its ✕
      // removes the crop, never an edge. The shared message offers two ways
      // out and one of them, "delete its edge on the canvas", does not exist
      // for this row, so the crop gets the half that is true for it.
      toast.warning(
        t(
          isCrop
            ? 'canvas.generatePanel.refuseRemoveModeOffCrop'
            : 'canvas.generatePanel.refuseRemoveModeOff',
        ),
      );
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
        // Both start from the row kind, and each asks only what can refuse
        // that kind: a text row answers to the prompt question, a media row to
        // the reference one. Insert then asks two more of a media row — is
        // there a prompt to insert INTO, and can the pool carry this modality.
        // `removeRefused` answers for the row dim as well as the ✕: they are
        // the same question, and spelling it twice is how a row once ended up
        // lit with its ✕ frozen (#1940).
        const insertRefused = insertRefusal(ref.sourceNodeType, usabilityCtx);
        const removeRefused = removeRefusal(ref.sourceNodeType, usabilityCtx);
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
            // The dim belongs to the ROW, because what it says is about the
            // whole row: this mode does not use this reference. Putting it on
            // the controls instead (as it was until #1945) said it about them
            // individually, which is why it could reach the image row's two
            // buttons and no other row at all. The controls carry no opacity
            // of their own, so nothing multiplies down to 0.25.
            //
            // It reads the ✕ verdict, which for a media row is the
            // reference question and for a text row is the prompt question.
            // So a text row stays lit under a mode that merely ignores
            // references — that rule is not about it (user 2026-08-13) — and
            // dims under one whose model sends no prompt, where it really has
            // nothing to be material for (#1966). This component answers that
            // second question from `modelTakesPrompt`; the video container used
            // to answer it on insert, and that second home is gone (#1962).
            //
            // The hover preview is deliberately NOT dimmed: it is portaled, so
            // this opacity does not reach it, and that is the wanted outcome —
            // a dark row still shows its picture at full strength (user
            // 2026-08-13).
            className={`group relative flex items-center gap-1.5 rounded-overlay border border-border bg-background/60 py-1 pl-1 pr-1.5 ${
              removeRefused === null ? '' : 'opacity-50'
            }`}
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
                ref.sourceNodeType === 'text' ? undefined : ref.mediaUrl
              }
              poster={ref.sourceNodeType === 'video' ? ref.thumbnail : undefined}
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
                className='flex items-center gap-1.5 rounded-overlay'
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
              aria-disabled={removeRefused !== null}
              onClick={() =>
                removeRefused
                  ? refuseRemove(removeRefused, ref.focus === true)
                  : onRemove(ref)
              }
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
