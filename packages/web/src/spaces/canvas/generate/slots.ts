// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a source slot is, how its stored value reads, and which slot a pick fills.
 *
 * A slot is a pick-time COPY of one asset, with a role — the first frame, the
 * driving audio, the voice to clone. It is not a reference: references are a
 * relationship (an edge), a slot is a value.
 *
 * The structure lives here while the entries live in per-panel registries
 * ({@link ./video-slots} and {@link ./audio-slots}), because a second copy of
 * `SlotSpec` would be a second place to remember when a slot grows a field.
 * The lookup below spans BOTH registries for the same reason the registries
 * exist at all: its callers read `undefined` as "this pick fills no slot" and
 * carry on — the canvas wires an edge, the candidate highlighting falls back
 * to what the node's edges accept — so a registry it cannot see is a pick that
 * silently does the wrong thing, with nothing failing to compile (#1960).
 */

import type { LucideIcon } from 'lucide-react';

// The two registries are imported for their DATA; each imports only the types
// declared below, and `import type` is erased at compile time, so there is no
// cycle at runtime.
import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type { PickPurpose } from '@web/stores/canvas';

/** What one slot is made of. */
export interface SlotSpec {
  /** Node data field holding this slot's pick — a URL, or `{url, cover}` when `storesCover`. */
  field: string;
  /**
   * Whether this slot stores `{url, cover}` rather than a bare URL string.
   *
   * The toolbar draws a filled slot with an `<img>`, which works only while
   * the picked URL is an image. A video or audio URL there renders nothing —
   * and with `alt=''` not even a broken-image marker, just a blank square. A
   * slot taking anything other than an image copies its node's poster
   * alongside the asset, inside the one field, so the pair converges as a unit.
   */
  storesCover?: true;
  /** The param the URL travels as, under the vendor's own name. */
  param: string;
  /** The pick this slot starts; the canvas dispatches on it. */
  purpose: PickPurpose;
  /**
   * The node type this slot takes. Read by both the candidate highlighting
   * and the click that fills the slot, so the two cannot disagree.
   *
   * Narrower than `NodeType` deliberately: what a slot holds is also what its
   * button shows and what its hover preview renders (#1946), and those two can
   * only handle an asset form. Declaring a slot for anything else would fail
   * to type-check here rather than render an empty card at runtime.
   */
  accepts: 'image' | 'video' | 'audio';
  /** Icon shown while the slot is empty. */
  Icon: LucideIcon;
  /** Test id of the slot control. */
  testId: string;
  /** Test id of the filled thumbnail. */
  thumbnailTestId: string;
  /** Test id of the clear badge. */
  clearTestId: string;
  /** Translation key for the slot's label. */
  labelKey: string;
  /** Translation key for the one line saying what to go pick — the slot's hover card carries it as the hint while empty (#1946). */
  tipKey: string;
  /** Translation key for the clear badge's accessible name. */
  clearLabelKey: string;
  /** Translation key for the refusal shown when execute finds it empty. */
  errorKey: string;
}

/** A registry of slots, keyed by the name its panel calls each one. */
export type SlotRegistry = Readonly<Record<string, SlotSpec>>;

/**
 * A stored value that is really a URL.
 *
 * An empty string is a string and no URL, and node data is a CRDT map any
 * client may write, so the type saying `string` proves nothing.
 * @param value - The raw stored value.
 * @returns The URL, or undefined when there is not one.
 */
function usableUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads a slot's stored pick, in the shape THAT slot keeps it in.
 *
 * This function IS the stored contract — a slot keeps a bare URL, or `{url,
 * cover}` when the picked asset is not its own picture. Stated here rather
 * than as a type alias nothing is checked against: the wire declaration
 * (`CanvasNodeFields.data`) and this reader are what a stored value actually
 * has to satisfy, and a third restatement would be one more thing to drift.
 *
 * A video's poster travels WITH it rather than in a field of its own, because
 * two fields are two independent last-writer-wins registers: two clients
 * picking different videos at once converge per-key, and the loser's poster
 * can survive under the winner's video (`canvas-space-slot-concurrency.test`).
 *
 * The shape is the slot's, not the value's: a slot storing a bare URL refuses
 * an object and a slot storing `{url, cover}` refuses a bare string. Slot
 * values are collaborative Yjs data — untrusted, whatever the type says — so
 * reading whichever shape happens to be there would let a malformed value
 * ride the payload as a source param and be refused upstream AFTER the task
 * was accepted and billed.
 *
 * An empty string is a string and no URL. A poster that is missing or
 * malformed leaves the slot covering itself with the asset node's icon rather
 * than an empty frame, which at least names what it holds (#1946).
 * @param spec - The slot being read, which states its stored shape.
 * @param value - The raw node-data value for that slot's field.
 * @returns The asset URL and what to show for it, or null when there is no pick.
 */
export function readSlotPick(
  spec: SlotSpec,
  value: unknown,
): { url: string; thumbnail?: string } | null {
  if (!spec.storesCover) {
    const bare = usableUrl(value);
    return bare ? { url: bare, thumbnail: bare } : null;
  }
  if (value === null || typeof value !== 'object') return null;
  const url = usableUrl((value as { url?: unknown }).url);
  if (!url) return null;
  const cover = usableUrl((value as { cover?: unknown }).cover);
  return cover ? { url, thumbnail: cover } : { url };
}

/**
 * Reads every slot's picked URL off a node.
 *
 * Takes the registry rather than closing over one, because both panels ask
 * this same question of their own slots and two copies of the loop would be
 * two places to remember what a stored pick looks like.
 * @param registry - The panel's slot registry.
 * @param content - The node's content view, if it has one.
 * @returns The URLs that are really there, by slot.
 */
export function readSlotUrls<K extends string>(
  registry: Readonly<Record<K, SlotSpec>>,
  content: unknown,
): Partial<Record<K, string>> {
  const urls: Partial<Record<K, string>> = {};
  for (const slot of Object.keys(registry) as K[]) {
    // A slot's field is a key on a CRDT map, so it is read as one. That is
    // the premise `readSlotPick` is built on: whatever the projected type
    // says, the value came from collaborative data and is checked there.
    const pick = readSlotPick(
      registry[slot],
      (content as Record<string, unknown> | undefined)?.[registry[slot].field],
    );
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
 * @param registry - The panel's slot registry.
 * @param content - The node's content view, if it has one.
 * @returns The URLs to display, by slot.
 */
export function readSlotThumbnails<K extends string>(
  registry: Readonly<Record<K, SlotSpec>>,
  content: unknown,
): Partial<Record<K, string>> {
  const thumbnails: Partial<Record<K, string>> = {};
  for (const slot of Object.keys(registry) as K[]) {
    const pick = readSlotPick(
      registry[slot],
      (content as Record<string, unknown> | undefined)?.[registry[slot].field],
    );
    if (pick?.thumbnail !== undefined) thumbnails[slot] = pick.thumbnail;
  }
  return thumbnails;
}

/** Every registry a pick can fill a slot in. */
const REGISTRIES: readonly SlotRegistry[] = [VIDEO_SLOTS, AUDIO_SLOTS];

/**
 * Finds the slot a pick is filling, if any.
 *
 * Spans every registry. Its callers read `undefined` as "this pick fills no
 * slot" and carry on — the canvas click handler falls through to the reference
 * branch and wires an EDGE, the candidate highlighting falls back to what the
 * node's edges accept — so a registry left out here is a pick that silently
 * does something else, with nothing failing to compile.
 * @param purpose - The running pick's purpose.
 * @returns The slot name that pick fills, or undefined when it fills none.
 */
export function slotForPurpose(purpose: PickPurpose): string | undefined {
  for (const registry of REGISTRIES) {
    const name = Object.keys(registry).find((slot) => registry[slot]!.purpose === purpose);
    if (name) return name;
  }
  return undefined;
}

/**
 * The spec behind a slot name, from whichever registry holds it.
 * @param slot - The slot name.
 * @returns Its spec, or undefined when no registry names it.
 */
export function slotSpec(slot: string): SlotSpec | undefined {
  for (const registry of REGISTRIES) {
    const spec = registry[slot];
    if (spec) return spec;
  }
  return undefined;
}

/**
 * Every slot both panels offer.
 *
 * The delete accounting walks this to answer "does any node still hold this
 * asset" (`canvas-upload`). A registry missing from the walk makes a
 * still-referenced asset look unheld the moment its source node is deleted.
 * @returns One spec per slot, video first.
 */
export function allSlotSpecs(): SlotSpec[] {
  return REGISTRIES.flatMap((registry) => Object.values(registry));
}
