// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pure derivation of the Generate panel's render inputs from a node's live Yjs
 * data + the model catalog. Kept out of the container so the model-default
 * pick, param reconciliation, reference rail, and reference-URL snapshot are
 * all unit-testable without React / Yjs / react-query.
 */

import type { FocusImage, MissingSource, ModelEntry } from '@breatic/shared';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import {
  deriveReferences,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import { validFocusImages } from '@web/data/focus-images';
import {
  IMAGE_MODE_OPTIONS,
  resolveMode,
  type ImageGenMode,
} from '@web/spaces/canvas/generate/image-mode-selection';
import {
  filterAvailableModes,
  filterModelsByMode,
  pickModelForMode,
} from '@web/spaces/canvas/generate/mode-selection';
import { resolveModelSwitch } from '@web/spaces/canvas/generate/model-params';
import { itemCap, missingSources, referenceKinds, referencePool, type ReferencePool } from '@breatic/shared';
import {
  mentionTokens,
  mentionedReferenceUrls,
  NO_MENTION_TOKENS,
  NO_REFERENCE_URLS,
  poolParams,
  type MentionTokens,
  type ReferenceUrls,
} from '@web/spaces/canvas/generate/reference-urls';
import { asContentView } from '@web/data/yjs/node-view';
import { IMAGE_SLOTS, imageSlotsForModel, type ImageSlot } from '@web/spaces/canvas/generate/image-slots';
import { readSlotPicks } from '@web/spaces/canvas/generate/slots';

/** Shared empty set for nodes with no `@`-picked references (avoids per-call allocation). */
const EMPTY_SOURCE_IDS: ReadonlySet<string> = new Set();

/** The render inputs the Generate panel needs, derived from live node data. */
export interface GeneratePanelViewModel {
  /** Catalog image models offered by the picker. */
  models: ModelEntry[];
  /** Effective model id (stored, else the catalog default). */
  model: string;
  /**
   * Effective params, reconciled against the current model, plus the node's
   * style images as `style_images` when the model takes them (inner#826):
   * the payload, the estimate and the gate all read this one record.
   */
  params: Record<string, unknown>;
  /** The source slots the current model fills off the canvas in this mode. */
  slots: readonly ImageSlot[];
  /**
   * How many style images the current model takes in this mode, or undefined
   * when it takes none and the toolbar draws no style area (inner#826).
   */
  styleCap: number | undefined;
  /** Every style image the node holds, in pick order; at most `styleCap` are sent. */
  styleImages: readonly string[];
  /** Reference rail rows derived from incoming edges. */
  references: ReferenceRailItem[];
  /** The `@`-mentioned reference URLs, by kind, snapshotted for the execute payload. */
  referenceUrls: ReferenceUrls;
  /**
   * How each mentioned picture, clip or track is written into the prompt the
   * model reads, by pool id (#2156, design §13.2) — numbered in the same lists
   * `referenceUrls` sends.
   */
  mentionTokens: MentionTokens;
  /** Where the active model's pool takes each kind in this mode, and how many (#2156). */
  pool: ReferencePool;
  /**
   * The node's focus crops (#1782) — standalone copies stored on the node
   * (`data.focusImages`, zero upstream relationship). Rendered as the rail's
   * focus entries and offered in the @ mention pool; a crop reaches the
   * execute payload only when @-mentioned (same explicit-selection rule as
   * node references). Malformed entries (untrusted Yjs) are dropped.
   */
  focusImages: FocusImage[];
  /** The selected model's catalog entry, when the catalog has it. */
  modelEntry: ModelEntry | undefined;
  /** The target node's display status — gates execute (no submit while handling). */
  nodeStatus: string | undefined;
  /** Active generation sub-mode (the t2i / i2i toggle state; default t2i). */
  mode: ImageGenMode;
  /**
   * The sources this run still needs, by the effective model's own
   * declarations (`missingSources`, the rule the server re-checks before
   * enqueue). Drives the #1675 execute gate. Empty when the catalog is empty
   * (no model resolved) — nothing to gate.
   */
  missing: readonly MissingSource[];
  /**
   * How much prompt text the active model takes in one request (#1960), when
   * it states a limit.
   *
   * The proposal tool reads the same declaration, so a model gaining this line
   * would otherwise have the agent refusing a prompt this panel sends on.
   * Undefined when the model states none, or when no model resolved.
   */
  maxInputChars?: number;
  /**
   * Whether the active model consumes the prompt (#1966) — the model states
   * it, this panel does not decide.
   *
   * It used to be stated as a literal `true` at the two gates in the
   * container, because the video panel's derivation (a `prompt` entry under
   * `params`) would have answered "no" for every image model: not one of them
   * writes that entry. That was a per-catalog writing habit, and the field
   * replaces it with something each model says about itself.
   *
   * `true` when no model resolves: an unrecognised model is not a licence to
   * skip a requirement every other one has. Same fallback as the video panel.
   */
  promptRequired: boolean;
}

/**
 * Narrows the sanitized catalog to the models offered under a panel mode.
 *
 * models is trusted (sanitizeModelCatalog at the API boundary). Narrowing to
 * the ACTIVE mode (mode toggle 2026-07-09) is the whole job: a mini-tool entry
 * (background removal, upscale) declares none of the panel modes, so it fails
 * the mode test on its own. There is no separate "is this generatable" pass —
 * one was here until #1948, and it could not remove anything the mode test
 * keeps, because every panel mode IS a generation mode.
 *
 * Exported so the container can memoize the SAME selection on [models, mode]
 * alone — the view-model rebuilds every canvas graph mutation, and a freshly
 * filtered array each time would defeat the React.memo on the pickers
 * (round-2 adversarial; memo discipline). It also keeps the image mode union
 * on the signature, which the shared narrowing takes as a plain string.
 * @param models - The sanitized catalog models.
 * @param mode - The active generation sub-mode.
 * @returns The models offered under that mode.
 */
export function selectModeModels(
  models: ModelEntry[],
  mode: ImageGenMode,
): ModelEntry[] {
  return filterModelsByMode(models, mode);
}

/**
 * Derives the Generate panel's render inputs from a node's live data.
 * @param input - The target node id, current nodes / edges, and catalog models.
 * @param input.nodeId - The node whose panel is open.
 * @param input.nodes - Current canvas node views (target + reference sources).
 * @param input.edges - Current canvas edges (incoming = references).
 * @param input.models - Catalog image models.
 * @param input.atMentionedSourceIds - Source node ids `@`-picked in the prompt; only these feed the i2i execute payload (design B — no `@` = no source image). Absent = none picked.
 * @param input.textById - Body text per referenced text node (#1774).
 * @returns The derived view-model.
 */
export function buildGeneratePanelViewModel(input: {
  nodeId: string;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  edges: ReadonlyArray<CanvasEdge>;
  /**
   * Body text per referenced text node (#1774) — see `deriveReferences`.
   * Required for the same reason it is there: optional, a caller that forgot
   * it got blank text for every reference and no signal at all.
   */
  textById: ReadonlyMap<string, string>;
  models: ModelEntry[];
  atMentionedSourceIds?: ReadonlySet<string>;
}): GeneratePanelViewModel {
  const { nodeId, nodes, edges } = input;
  const content = asContentView(nodes.find((n) => n.id === nodeId)?.data);
  // Availability first (#1951): a stored mode this deployment cannot serve is
  // resolved away rather than passed through, so nothing downstream has to
  // have an answer for a node sitting on a mode the picker does not list.
  // Computed here rather than taken as an input because the result is not
  // returned — handing an array out of the view model would rebuild it on
  // every canvas mutation and defeat the pickers' React.memo.
  const mode = resolveMode(
    content?.mode,
    filterAvailableModes(IMAGE_MODE_OPTIONS, input.models),
  );
  const models = selectModeModels(input.models, mode);

  const model = pickModelForMode(content?.model, mode, content?.modelByMode, models);
  const current = models.find((m) => m.name === model);
  // Resolved from the model's OWN record, the same way a switch resolves it
  // (#1948). The records this returns are dropped — rendering reads, it does
  // not persist.
  const modelParams = current ? resolveModelSwitch(content, current).params : {};
  // The style slot is the model's to declare, per mode (inner#826).
  const slots = imageSlotsForModel(current, mode);
  const styleSpec = current?.params[IMAGE_SLOTS.style.param];
  const styleCap = styleSpec !== undefined && slots.includes('style') ? itemCap(styleSpec) : undefined;
  const styleImages = readSlotPicks(IMAGE_SLOTS.style, content?.styleImageUrls).map((p) => p.url);
  const sentStyle = styleCap === undefined ? [] : styleImages.slice(0, styleCap);
  const params = sentStyle.length > 0 ? { ...modelParams, [IMAGE_SLOTS.style.param]: sentStyle } : modelParams;

  const references = deriveReferences(nodeId, nodes, edges, input.textById);
  // t2i generates from scratch and ignores source images (design §2.5): the
  // rail still renders (greyed in the panel) but contributes NO reference URLs
  // to the execute payload. i2i sends them.
  // i2i sends ONLY the @-picked source images (design B): a reference that is
  // connected but not @-mentioned contributes nothing; no @ at all → empty, and
  // the #1675 execute gate then blocks submitting an i2i task with no source.
  // Focus crops (#1782): stored on the node as a plain array — collaborative
  // Yjs data, untrusted. ONE sanitizer shared with the pool-cap count so
  // every reader agrees on what an entry is (validFocusImages). Which of them
  // ride the payload is `mentionedReferenceUrls`, shared with the video panel
  // since #1978 gave that panel crops too.
  const focusImages: FocusImage[] = validFocusImages(content?.focusImages);

  const atMentioned = input.atMentionedSourceIds ?? EMPTY_SOURCE_IDS;
  // The model's own pool says which kinds a run sends and under which param
  // (#2156); text-to-image models declare none.
  const pool = referencePool(current, mode);
  const sendsReferences = referenceKinds(pool).length > 0;
  const referenceUrls = sendsReferences
    ? mentionedReferenceUrls({ references, focusImages, atMentioned, nodes })
    : NO_REFERENCE_URLS;
  const mentionTokenMap = sendsReferences
    ? mentionTokens(pool, { references, focusImages, atMentioned, nodes })
    : NO_MENTION_TOKENS;

  return {
    models,
    model,
    params,
    slots,
    styleCap,
    styleImages,
    references,
    referenceUrls,
    mentionTokens: mentionTokenMap,
    pool,
    focusImages,
    modelEntry: current,
    nodeStatus: content?.status,
    mode,
    // Execute gate (#1675): the active panel mode and the model's own
    // declarations decide, through the same rule the server re-checks.
    missing: current
      ? missingSources(current, mode, { ...params, ...poolParams(pool, referenceUrls) })
      : [],
    maxInputChars: current?.max_input_chars,
    promptRequired: current?.takes_prompt ?? true,
  };
}
