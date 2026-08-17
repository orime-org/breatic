// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure derivation of the video Generate panel's render inputs from a node's
 * live Yjs data + the model catalog (#1896). Kept out of the container so the
 * model narrowing, the default pick and param reconciliation are all testable
 * without React / Yjs / react-query.
 *
 * A sibling of the image panel's view model rather than a shared one: the two
 * panels offer different modes and different params (user 2026-08-08). What IS
 * shared sits one level down — the mode filter, the param reconciler and the
 * param value reader all serve both.
 */

import { VIDEO_GENERATION_MODES } from '@breatic/shared';
import type { ModelEntry } from '@breatic/shared';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import {
  deriveReferences,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import {
  filterModelsByMode,
  pickModelForMode,
} from '@web/spaces/canvas/generate/mode-selection';
import { resolveModelSwitch } from '@web/spaces/canvas/generate/model-params';
import { positiveCap } from '@web/spaces/canvas/generate/reference-cap';
import { mentionedImageUrls } from '@web/spaces/canvas/generate/reference-urls';
import {
  modeTakesReferences,
  slotsForMode,
} from '@web/spaces/canvas/generate/video-mode-options';
import {
  VIDEO_SLOTS,
  readSlotPick,
} from '@web/spaces/canvas/generate/video-slots';
import type {
  VideoSlot,
  VideoSlotSpec,
  VideoSlotUrls,
} from '@web/spaces/canvas/generate/video-slots';
import type {
  ContentNodeView,
  NodeView,
} from '@web/spaces/canvas/types/node-view';

/**
 * The generation modes the video panel offers — the six the user decided
 * belong here (2026-08-08); the other five video modes (extend / edit /
 * motion-control / upscale / interpolate) belong to the mini-tool system.
 * Derived from the shared list so the panel and the catalog classifier can
 * never disagree on what counts as generation.
 */
export type VideoGenMode = (typeof VIDEO_GENERATION_MODES)[number];

/**
 * The render inputs the video Generate panel needs, derived from live node
 * data. Only what the panel actually renders: the model list it shows comes
 * from `selectVideoModeModels`, memoized separately by the container so a
 * canvas mutation cannot rebuild it and defeat the pickers' memo.
 */
export interface VideoPanelViewModel {
  /** Effective model id (stored, else the first offered). Empty when the mode offers none. */
  model: string;
  /** Effective params, reconciled against the current model. */
  params: Record<string, unknown>;
  /** Credit cost of one generation with the current model. */
  creditEstimate: number;
  /** The target node's display status — gates execute (no submit while handling). */
  nodeStatus: string | undefined;
  /**
   * The mode this view model was built for. Echoed back because the payload is
   * built from the mode, and the container must send the same one the slots
   * came from rather than reading the graph a second time.
   */
  mode: VideoGenMode;
  /**
   * The source slots the active mode collects, in the order the toolbar shows
   * them. This is what a mode sends upstream: the toolbar renders one control
   * per slot, execute checks these are filled, and the payload is built from
   * them (#1904). A mode that collects nothing gets an empty list.
   */
  slots: readonly VideoSlot[];
  /**
   * What is currently picked, by slot — for EVERY slot, not just the active
   * mode's. A pick survives a mode switch (user 2026-08-10, either frame can
   * be changed whenever), so the panel keeps reading it; what the mode
   * decides is which of these get built into the payload.
   */
  slotUrls: VideoSlotUrls;
  /**
   * What each slot SHOWS for its pick — the pick itself for an image slot,
   * the copied poster for one holding an asset an `<img>` cannot paint.
   * Separate from {@link VideoPanelViewModel.slotUrls} because only that one
   * travels upstream: a poster is ours, for the toolbar.
   */
  slotThumbnails: VideoSlotUrls;
  /**
   * Reference rail rows derived from incoming edges — everything connected,
   * whether or not the prompt mentions it. What the rail SHOWS.
   */
  references: ReferenceRailItem[];
  /**
   * The reference image URLs this submit sends (#1927) — the `@`-mentioned
   * ones only, in rail order, and only under a mode that takes references.
   * What the PAYLOAD carries, which is a smaller thing than what the rail
   * shows: connecting an image offers it, mentioning it uses it.
   */
  referenceUrls: string[];
  /**
   * How many reference images the active model takes, or undefined when it is
   * uncapped. Read off the wire so the panel, the server rule and the worker
   * all count against the same figure.
   */
  maxReferences: number | undefined;
  /**
   * Whether the active model takes a prompt at all — the model's own
   * `takes_prompt` (#1935, #1966). Read off the wire for the same reason as
   * {@link VideoPanelViewModel.maxReferences}: what a model accepts is
   * declared per model, so a demand belongs to the model rather than to the
   * mode that happens to select it.
   *
   * It used to be DERIVED, from whether the model declared a `prompt` under
   * `params`, and that is what #1966 replaced. The declaration was a
   * per-catalog writing habit rather than a statement about the model — not
   * one image model ever wrote it — so the image panel could not use the same
   * derivation and hardcoded `true` instead. Both panels now read this one
   * field the same way (`panel-view-model.ts` does the identical lookup), and
   * every `params.prompt` declaration is gone from the catalog. Omitting
   * `takes_prompt` is a load-time error, never a silent `false`
   * (`assertTakesPromptDeclared`).
   *
   * What this measures is the model's catalog entry, not the endpoint behind
   * it — the prompt travels as its own argument the whole way down and never
   * passes the param check, so nothing downstream would strip it from a model
   * that declares none. The panel is what stops it: since #1950 such a model
   * is sent an empty string.
   *
   * True when the model is unknown: an unrecognised model is not a licence to
   * skip the requirement every other model has. That fallback no longer has
   * to cover the catalog being in flight — since #1966 the frame holds the
   * whole panel back until a catalog is in hand, so by the time this is read
   * there is one to look the model up in. What reaches the fallback now is a
   * stored model id the catalog does not carry.
   */
  promptRequired: boolean;
}

/** Shared empty set for a prompt that mentions nothing (avoids a per-call allocation). */
const EMPTY_SOURCE_IDS: ReadonlySet<string> = new Set();

/**
 * Sanitizes a node's stored `mode` into one this panel offers.
 *
 * The node stores ONE `mode` field, shared with the image panel's own mode set
 * (a node can only ever be one modality, so they never collide in practice) —
 * but a value this panel does not offer must not be honoured: opening on `t2i`
 * or on a mini-tool video mode would narrow the model list to nothing and
 * leave the panel with no model to submit.
 * @param stored - The node's stored `mode`, if any.
 * @returns The stored mode when this panel offers it, else text-to-video.
 */
function resolveVideoMode(stored: string | undefined): VideoGenMode {
  return VIDEO_GENERATION_MODES.includes(stored as VideoGenMode)
    ? (stored as VideoGenMode)
    : 't2v';
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
 * Reads every slot's picked URL off the node.
 * @param content - The node's content view, if it has one.
 * @returns The URLs that are really there, by slot.
 */
function readSlotUrls(content: ContentNodeView | undefined): VideoSlotUrls {
  const urls: VideoSlotUrls = {};
  for (const slot of Object.keys(VIDEO_SLOTS) as VideoSlot[]) {
    const spec: VideoSlotSpec = VIDEO_SLOTS[slot];
    const pick = readSlotPick(spec, content?.[spec.field]);
    if (pick) urls[slot] = pick.url;
  }
  return urls;
}

/**
 * Reads what each slot should SHOW for its pick.
 *
 * The same URL as the pick for a slot holding an image, and the copied poster
 * for one holding something an `<img>` cannot paint. A slot whose poster is
 * missing is absent from this map rather than falling back to the asset:
 * handed a video URL the `<img>` draws a blank square, and with `alt=''` not
 * even a broken-image marker. Absent here does not mean the slot looks empty —
 * the toolbar covers it with the asset node's icon instead (#1946).
 * @param content - The node's content view, if it has one.
 * @returns The URLs to display, by slot.
 */
function readSlotThumbnails(
  content: ContentNodeView | undefined,
): VideoSlotUrls {
  const thumbnails: VideoSlotUrls = {};
  for (const slot of Object.keys(VIDEO_SLOTS) as VideoSlot[]) {
    const spec: VideoSlotSpec = VIDEO_SLOTS[slot];
    const pick = readSlotPick(spec, content?.[spec.field]);
    if (pick?.thumbnail !== undefined) thumbnails[slot] = pick.thumbnail;
  }
  return thumbnails;
}

/**
 * The mode the panel shows for one node, read off its live view.
 *
 * The panel reads this rather than storing a mode of its own: the switch is
 * collaborative (a mode a collaborator picks has to show up here), and every
 * write-callback re-reads it at click time so a switch that landed after the
 * last render cannot be built over.
 * @param nodes - Current canvas node views.
 * @param nodeId - The node whose panel is open.
 * @returns The mode this panel opens in — text-to-video for anything it does
 *   not offer, a node with no stored mode, or a node that is gone.
 */
export function nodeVideoMode(
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>,
  nodeId: string,
): VideoGenMode {
  return resolveVideoMode(
    asContentView(nodes.find((n) => n.id === nodeId)?.data)?.mode,
  );
}

/**
 * The video models the panel offers under one generation mode.
 *
 * `catalog.video` also ships the mini-tool entries — video upscaling, frame
 * interpolation, extension, editing, motion control — and offering one of
 * those here would put "Video Upscale Pro" in the text-to-video picker, where
 * a submit is then refused by the backend source gate. Narrowing to the mode
 * is by itself enough to keep them out: `mode` is one of the six generation
 * modes, and a mini-tool entry declares none of them. A separate
 * "is this generatable" pass would be dead weight — it can only remove models
 * the mode filter removes anyway (verified by exhausting every one- and
 * two-mode combination against every panel mode: 726 cases, zero differences).
 *
 * Exported so the container can memoize the SAME selection on [models, mode]
 * alone — the view model rebuilds on every canvas graph mutation, and a freshly
 * filtered array each time would defeat the React.memo on the pickers.
 * @param models - The sanitized catalog video models.
 * @param mode - The active generation mode.
 * @returns The models offered under that mode.
 */
export function selectVideoModeModels(
  models: ModelEntry[],
  mode: VideoGenMode,
): ModelEntry[] {
  return filterModelsByMode(models, mode);
}

/**
 * Derives the video Generate panel's render inputs from a node's live data.
 * @param input - The target node id, current nodes, catalog models and mode.
 * @param input.nodeId - The node whose panel is open.
 * @param input.nodes - Current canvas node views.
 * @param input.models - Catalog video models (the `video` bucket, unfiltered).
 * @param input.mode - The active generation mode. Passed in rather than read off
 *   the node: the panel owns which mode it is showing, and the node stores one
 *   `mode` field shared with the image panel's own mode set.
 * @param input.edges - Current canvas edges; the incoming ones are the references.
 * @param input.textById - What each referenced text node says, for the rail's previews.
 * @param input.atMentionedSourceIds - The sources the prompt `@`-mentions right
 *   now. Absent means none, which is what an untouched prompt has.
 * @returns The derived view model.
 */
export function buildVideoPanelViewModel(input: {
  nodeId: string;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  models: ModelEntry[];
  mode: VideoGenMode;
  edges: ReadonlyArray<CanvasEdge>;
  textById: ReadonlyMap<string, string>;
  atMentionedSourceIds?: ReadonlySet<string>;
}): VideoPanelViewModel {
  const { nodeId, nodes, mode } = input;
  const content = asContentView(nodes.find((n) => n.id === nodeId)?.data);

  const models = selectVideoModeModels(input.models, mode);

  // The stored model wins only while this mode still offers it. A stale pick
  // (another mode's, or one dropped from the catalog) falls back to what the
  // user chose under THIS mode, then to the first offered model — submitting a
  // model the mode does not offer would generate something else entirely, and
  // the backend catches only part of that (its source gate passes any model
  // with one source-less mode). The image panel resolves it the same way; this
  // side skipped the per-mode memory until #1948.
  const model = pickModelForMode(
    content?.model,
    mode,
    content?.modelByMode,
    models,
  );
  const current = models.find((m) => m.name === model);

  const references = deriveReferences(nodeId, nodes, input.edges, input.textById);
  // Only the `@`-mentioned ones travel, and only under a mode that asked for
  // them (#1927). A reference survives a mode switch — that is deliberate, so
  // switching back finds it — which is exactly why the mode, not the rail,
  // decides whether anything is sent: otherwise the images someone connected
  // for reference-to-video would ride into a first-last-frame task.
  const atMentioned = input.atMentionedSourceIds ?? EMPTY_SOURCE_IDS;
  const referenceUrls = modeTakesReferences(mode)
    ? mentionedImageUrls(references, atMentioned, nodes)
    : [];

  return {
    model,
    // Resolved from the model's OWN record, the same way a switch resolves it
    // (#1948). It matters here too: `model` above falls back to the first
    // offered one when the stored pick has left the catalog, and reconciling
    // the outgoing model's params against that fallback is the very leak this
    // slice closes. The records this returns are dropped — rendering reads,
    // it does not persist.
    params: current ? resolveModelSwitch(content, current).params : {},
    // `?? 0` covers only the model-not-found case (empty catalog / stale
    // model); when current is found, cost_per_call is a trusted number.
    creditEstimate: current?.cost_per_call ?? 0,
    nodeStatus: content?.status,
    mode,
    slots: slotsForMode(mode),
    slotUrls: readSlotUrls(content),
    slotThumbnails: readSlotThumbnails(content),
    references,
    referenceUrls,
    maxReferences: positiveCap(current?.params.images?.max_items),
    // The model states it (#1966). This used to be inferred from a `prompt`
    // entry under `params`, which happened to work for video because all four
    // video yaml files wrote one — a per-catalog writing habit, not a rule, and
    // the image catalog's habit was the opposite. The fallback still applies
    // when no model resolves: an unrecognised model is not a licence to skip a
    // requirement every other mode has.
    promptRequired: current?.takes_prompt ?? true,
  };
}
