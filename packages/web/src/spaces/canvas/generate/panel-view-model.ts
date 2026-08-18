// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure derivation of the Generate panel's render inputs from a node's live Yjs
 * data + the model catalog. Kept out of the container so the model-default
 * pick, param reconciliation, reference rail, and reference-URL snapshot are
 * all unit-testable without React / Yjs / react-query.
 */

import {
  isImageGenerationMode,
  type FocusImage,
  type ModelEntry,
} from '@breatic/shared';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import {
  deriveReferences,
  focusRefId,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import { validFocusImages } from '@web/data/focus-images';
import {
  resolveMode,
  type ImageGenMode,
} from '@web/spaces/canvas/generate/image-mode-selection';
import {
  filterModelsByMode,
  pickModelForMode,
} from '@web/spaces/canvas/generate/mode-selection';
import { resolveModelSwitch } from '@web/spaces/canvas/generate/model-params';
import { positiveCap } from '@web/spaces/canvas/generate/reference-cap';
import { mentionedImageUrls } from '@web/spaces/canvas/generate/reference-urls';
import type {
  ContentNodeView,
  NodeView,
} from '@web/spaces/canvas/types/node-view';

/** Shared empty set for nodes with no `@`-picked references (avoids per-call allocation). */
const EMPTY_SOURCE_IDS: ReadonlySet<string> = new Set();

/** The render inputs the Generate panel needs, derived from live node data. */
export interface GeneratePanelViewModel {
  /** Catalog image models offered by the picker. */
  models: ModelEntry[];
  /** Effective model id (stored, else the catalog default). */
  model: string;
  /** Effective params, reconciled against the current model. */
  params: Record<string, unknown>;
  /** Reference rail rows derived from incoming edges. */
  references: ReferenceRailItem[];
  /** Reference source asset URLs, snapshotted for the execute payload. */
  referenceUrls: string[];
  /**
   * The node's style-reference image URL (#1664) — a pick-time COPY stored on
   * the node (`data.styleImageUrl`, one max, no upstream relationship). Unlike
   * `referenceUrls` (i2i only), style rides the payload in EVERY mode — but
   * only when {@link GeneratePanelViewModel.styleSupported} (capability gate).
   * Undefined when none picked or the stored value is malformed (untrusted Yjs).
   */
  styleImageUrl?: string;
  /**
   * Whether the ACTIVE model supports style-reference images — it declares the
   * `style_images` param on the wire (capability gate, not a mode gate: config
   * decides which models take style). Gates the Style tool button and whether
   * `styleImageUrl` is sent in the execute payload. False when no model
   * resolved (empty catalog).
   */
  styleSupported: boolean;
  /**
   * Whether the active model declares the `camera` param cluster on the wire
   * (#1788) → the Camera control is usable. Gates whether the footer Camera
   * button is RENDERED (hidden when false, not greyed — GeneratePanel renders
   * it only when true). False when no model resolved.
   */
  cameraSupported: boolean;
  /**
   * The node's focus crops (#1782) — standalone copies stored on the node
   * (`data.focusImages`, zero upstream relationship). Rendered as the rail's
   * focus entries and offered in the @ mention pool; a crop reaches the
   * execute payload only when @-mentioned (same explicit-selection rule as
   * node references). Malformed entries (untrusted Yjs) are dropped.
   */
  focusImages: FocusImage[];
  /** Credit cost of one generation with the current model. */
  creditEstimate: number;
  /** The target node's display status — gates execute (no submit while handling). */
  nodeStatus: string | undefined;
  /** Active generation sub-mode (the t2i / i2i toggle state; default t2i). */
  mode: ImageGenMode;
  /**
   * Whether the effective model needs a source image (i2i / edit modes). Drives
   * the #1675 execute gate: submitting one of these with no `@`-picked source
   * image is blocked in the panel (and re-checked server-side before billing).
   * False when the catalog is empty (no model resolved) — nothing to gate.
   */
  requiresSource: boolean;
  /**
   * Max reference images the active model accepts — the `images` param
   * `max_items` on the wire (backend-computed from config), normalized so only
   * a POSITIVE finite cap is set (0 / negative / absent → undefined = uncapped,
   * matching the server rule + worker guard). Drives the #1735 count gate:
   * submitting more `@`-picked sources than this is blocked in the panel (and
   * re-checked server-side before enqueue, which otherwise silently truncates).
   */
  maxReferences?: number;
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
  /**
   * Whether the GLOBAL generatable-image catalog is empty. Since #1964 that has
   * exactly one cause left — no generation model configured — because the panel
   * does not render at all until the catalog lands, so "still loading" and
   * "failed to load" never reach a rendered panel. Distinct from `models.length`,
   * which is the ACTIVE-mode-filtered subset: the mode toggle gates its disabled
   * state on THIS (not the mode subset) so a node stuck in a mode with zero
   * models can still toggle back to the populated mode (adversarial round 2).
   */
  catalogEmpty: boolean;
}

/**
 * Narrows a node view to a content view (the only kind carrying generate
 * inputs). `status` is a required field on every content view and absent on
 * annotation / group, so it is a reliable runtime discriminant.
 * @param data - The node view to narrow.
 * @returns The content view, or undefined for annotation / group / missing.
 */
function asContentView(data: NodeView | undefined): ContentNodeView | undefined {
  return data && 'status' in data ? data : undefined;
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
  const mode = resolveMode(content?.mode);
  // Wide filter kept separately: catalogEmpty means "no generatable model in
  // ANY mode" (it gates the whole panel), which is a different question from
  // "what does this mode offer" and the only remaining use of this predicate.
  const generatable = input.models.filter((m) => isImageGenerationMode(m.mode));
  const models = selectModeModels(input.models, mode);

  const model = pickModelForMode(content?.model, mode, content?.modelByMode, models);
  const current = models.find((m) => m.name === model);
  // Resolved from the model's OWN record, the same way a switch resolves it
  // (#1948). The records this returns are dropped — rendering reads, it does
  // not persist.
  const params = current ? resolveModelSwitch(content, current).params : {};

  const references = deriveReferences(nodeId, nodes, edges, input.textById);
  // t2i generates from scratch and ignores source images (design §2.5): the
  // rail still renders (greyed in the panel) but contributes NO reference URLs
  // to the execute payload. i2i sends them. (Style images are the exception
  // that survives t2i — resolved 30 lines down from the node's own
  // styleImageUrl, and they ride the payload in every mode.)
  // i2i sends ONLY the @-picked source images (design B): a reference that is
  // connected but not @-mentioned contributes nothing; no @ at all → empty, and
  // the #1675 execute gate then blocks submitting an i2i task with no source.
  // Focus crops (#1782): stored on the node as a plain array — collaborative
  // Yjs data, untrusted. ONE sanitizer shared with the pool-cap count so
  // every reader agrees on what an entry is (validFocusImages).
  const focusImages: FocusImage[] = validFocusImages(content?.focusImages);

  const atMentioned = input.atMentionedSourceIds ?? EMPTY_SOURCE_IDS;
  const referenceUrls =
    mode === 't2i'
      ? []
      : [
        ...mentionedImageUrls(references, atMentioned, nodes),
        // Focus crops (#1782): the same @-only rule — a crop reaches the
        // payload only when its focus: pool id is mentioned. Appended after
        // node references (pool order → payload order).
        // Focus crops (#1782) live on this panel alone, which is why they
        // stay here rather than moving into the shared derivation above.
        ...focusImages
          .filter((f) => atMentioned.has(focusRefId(f.id)))
          .map((f) => f.url),
      ];

  // Style image (#1664): a pick-time URL copy stored on the node itself, so —
  // unlike i2i references — it survives t2i and rides the payload in every
  // mode (when the model supports it). The stored value is collaborative Yjs
  // data — untrusted — so a malformed non-string resolves to undefined.
  const rawStyle = content?.styleImageUrl;
  const styleImageUrl =
    typeof rawStyle === 'string' && rawStyle.length > 0 ? rawStyle : undefined;


  return {
    models,
    model,
    params,
    references,
    referenceUrls,
    styleImageUrl,
    focusImages,
    // Capability gate (#1664): the model declares `style_images` on the wire →
    // it can take a style reference. Config decides which models (t2i and/or
    // edit) support style; the frontend only reads the capability.
    styleSupported: current ? current.params.style_images != null : false,
    // Capability gate (#1788): the model declares the `camera` cluster on the
    // wire → it can take camera/lens/focal/aperture simulation. Edit variants
    // omit it, so `params.camera` is undefined and the Camera control is hidden
    // (rendered only when supported, unlike the greyed-disabled Style button).
    cameraSupported: current ? current.params.camera != null : false,
    // `?? 0` covers only the model-not-found case (empty catalog / stale model);
    // when current is found, cost_per_call is a trusted number (boundary).
    creditEstimate: current?.cost_per_call ?? 0,
    nodeStatus: content?.status,
    mode,
    // Execute gate (#1675, cross-modality): the ACTIVE PANEL MODE decides the
    // submission semantics — read the model's precomputed per-mode source needs
    // (`sourcesByMode`, backend-computed on the wire) for the active mode. Under
    // t2i that is `[]` (no source), even for a HYBRID whose capability array
    // also spans i2i; under i2i it is `["image"]`. No model resolved (empty
    // catalog) → no gate. The rule itself lives backend-side; the panel only
    // reads the wire field, never runs it.
    requiresSource: current ? (current.sourcesByMode[mode]?.length ?? 0) > 0 : false,
    // #1735 count gate: the active model's reference-image cap (the `images`
    // param's `max_items`, backend-computed on the wire). Only a POSITIVE finite
    // cap counts — 0 / negative / NaN / undefined all mean "uncapped", matching
    // the server rule (reference-count.ts, `limit >= 1`) and the worker's truthy
    // `spec.max_items` guard, so all three layers agree (else a `max_items: 0`
    // would block every submit here with a nonsensical "limit: 0" toast).
    maxReferences: positiveCap(current?.params.images?.max_items),
    promptRequired: current?.takes_prompt ?? true,
    catalogEmpty: generatable.length === 0,
  };
}
