// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which of a canvas node's fields an over-limit canvas keeps (inner#1413).
 *
 * A field is judged by its key and the node's kind, never by what its value
 * looks like: who the node is, what it points at, what it says, or something
 * else. A slim entry keeps the first three, which take in the mode, model and
 * settings it would run; only what it says is ever cut.
 */

import { MULTI_SHOT_MODE } from '@breatic/shared';
import type { CanvasNodeFields, ParamDescriptor } from '@breatic/shared';

import type { NodeView } from '@web/data/yjs/node-view';
import { nodeNameOf } from '@web/spaces/canvas/attach-nodes';

/** What a field is to the reader: who the node is, what it points at, what it says, or none of these. */
export type FieldClass = 'identity' | 'reference' | 'content' | 'other';

/**
 * How a node field is kept. Besides a class: `byKind` when the same key means
 * different things on different kinds; `idle` for what the reader picked,
 * kept only when nothing would run; `perMode` for a text stored once per
 * mode, kept for the mode in effect; `shots` for the multi-shot mode's shots;
 * `each` for an array whose elements are judged by {@link ARRAY_FIELD_RULES}.
 */
type FieldRule =
  | FieldClass
  | { readonly byKind: Readonly<Record<string, FieldClass>>; readonly otherwise: FieldClass }
  | 'idle'
  | 'perMode'
  | 'shots'
  | 'each';

/** Every key of every member of a union. */
type KeysOf<T> = T extends unknown ? keyof T : never;

/** Every key of every kind of node view. */
type ViewKey = KeysOf<NodeView>;

/**
 * A node's `data` keys as a snapshot carries them: what the document stores,
 * what the canvas view carries, and what lives only in the shared map
 * (`body`, and the single `prompt` of nodes older than one prompt per mode).
 */
type FieldKey = keyof CanvasNodeFields['data'] | ViewKey | 'body' | 'prompt';

/** Every field a node is handed over with. A key added to a node and not named here fails the typecheck. */
export const FIELD_RULES: { readonly [K in FieldKey]: FieldRule } = {
  name: 'identity',
  sourceNodeId: 'identity',
  // A picture's or a clip's address; a sticky's words; on a text node, words
  // from before the body, which nothing reads.
  content: { byKind: { annotation: 'content', text: 'other' }, otherwise: 'reference' },
  body: 'content',
  prompt: 'content',
  prompts: 'perMode',
  lyrics: 'perMode',
  shots: 'shots',
  mode: 'idle',
  model: 'idle',
  coverUrl: 'reference',
  styleImageUrls: 'reference',
  firstFrameUrl: 'reference',
  endFrameUrl: 'reference',
  characterImageUrl: 'reference',
  moodImageUrl: 'reference',
  drivingVideo: 'reference',
  drivingAudio: 'reference',
  refAudio: 'reference',
  sourceVideo: 'reference',
  leftAudio: 'reference',
  rightAudio: 'reference',
  musicSong: 'reference',
  coverSong: 'reference',
  musicMelody: 'reference',
  musicVocal: 'reference',
  soundVideo: 'reference',
  focusImages: 'each',
  replies: 'each',
  attachments: 'each',
  createdAt: 'other',
  createdBy: 'other',
  editedAt: 'other',
  locked: 'other',
  handling: 'other',
  taskCounts: 'other',
  taskResultEventId: 'other',
  // Which template node it was placed as: part of who the node is.
  templateNode: 'identity',
  width: 'other',
  height: 'other',
  mediaWidth: 'other',
  mediaHeight: 'other',
  duration: 'other',
  mimeType: 'other',
  size: 'other',
  sizeBytes: 'other',
  operation: 'other',
  operationParams: 'other',
  modelByMode: 'other',
  paramsByModel: 'other',
  backgroundColor: 'other',
};

/** The fields of one element of each array field. */
export const ARRAY_FIELD_RULES: Readonly<Record<'shots' | 'replies' | 'focusImages' | 'attachments', Readonly<Record<string, FieldClass>>>> = {
  shots: { id: 'identity', prompt: 'content', duration: 'reference' },
  replies: { id: 'identity', content: 'content', createdBy: 'reference', createdAt: 'other', editedAt: 'other' },
  focusImages: { id: 'identity', url: 'reference', name: 'content', width: 'other', height: 'other' },
  attachments: { id: 'identity', url: 'reference', name: 'content', mimeType: 'other', size: 'other', uploadedAt: 'other' },
};

/** A text the reader wrote, and where it sits in a slim entry. */
export interface TextAt {
  readonly path: ReadonlyArray<string | number>;
  readonly text: string;
}

/** A node at its two smaller sizes. */
export interface FitParts {
  /** Who it is, what it points at (the mode, model and settings it would run among them) and what it says. */
  slim: Record<string, unknown>;
  /** The texts in the slim entry that may be cut, in order. */
  texts: readonly TextAt[];
  /** Its id, kind, group and name. */
  named: Record<string, unknown>;
}

/** A node as a snapshot hands it over. */
type Entry = Record<string, unknown> & { id: string };

/**
 * Whether a value is a plain object.
 * @param value - The value.
 * @returns True for an object that is not an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keep the fields of an object that are named and not `other`, noting the
 * texts among them.
 * @param value - The object.
 * @param rules - Each field's class.
 * @param at - Where the object sits.
 * @param texts - Collects the texts.
 * @returns The kept fields.
 */
function keepByClass(
  value: Record<string, unknown>,
  rules: Readonly<Record<string, FieldClass>>,
  at: ReadonlyArray<string | number>,
  texts: TextAt[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const rule = rules[key];
    if (rule === undefined || rule === 'other') continue;
    kept[key] = inner;
    if (rule === 'content' && typeof inner === 'string') texts.push({ path: [...at, key], text: inner });
  }
  return kept;
}

/**
 * Keep each element of an array by its fields.
 * @param value - The array.
 * @param rules - Each element field's class.
 * @param at - Where the array sits.
 * @param texts - Collects the texts.
 * @returns The kept elements, or the value as it is when it is not an array.
 */
function keepEach(
  value: unknown,
  rules: Readonly<Record<string, FieldClass>>,
  at: ReadonlyArray<string | number>,
  texts: TextAt[],
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item: unknown, i) => (isRecord(item) ? keepByClass(item, rules, [...at, i], texts) : item));
}

/**
 * The name a node is known by, as its attachment card names it; a sticky by
 * the start of what it says, since every sticky is named the same.
 * @param type - The node's type.
 * @param data - Its data.
 * @returns The name.
 */
function nameOf(type: string, data: Record<string, unknown>): string {
  return nodeNameOf(type, type === 'annotation' ? { content: data.content } : data);
}

/**
 * The run settings as a slim entry keeps them: a free text, and the text
 * fields of each entry of a list, are what the reader wrote; everything else
 * is a choice and goes whole.
 * @param params - The settings.
 * @param descriptors - What the model says each setting is, when known.
 * @param texts - Collects the texts.
 * @returns The settings.
 */
function keepParams(
  params: Record<string, unknown>,
  descriptors: Readonly<Record<string, ParamDescriptor>> | undefined,
  texts: TextAt[],
): Record<string, unknown> {
  for (const [key, value] of Object.entries(params)) {
    const descriptor = descriptors?.[key];
    const at = ['current', 'params', key];
    if (descriptor?.type === 'text' && typeof value === 'string') texts.push({ path: at, text: value });
    if (descriptor?.type === 'items' && Array.isArray(value)) {
      const fields = descriptor.fields ?? {};
      for (const [i, item] of (value as unknown[]).entries()) {
        if (!isRecord(item)) continue;
        for (const [field, inner] of Object.entries(item)) {
          if (fields[field]?.type === 'text' && typeof inner === 'string') texts.push({ path: [...at, i, field], text: inner });
        }
      }
    }
  }
  return params;
}

/**
 * A node's slim and names-only entries.
 * @param entry - The node as a snapshot hands it over.
 * @param descriptors - The run settings of the model it would run, when it would run one.
 * @returns Its smaller sizes and the texts that may be cut.
 */
export function fitPartsOf(entry: Entry, descriptors: Readonly<Record<string, ParamDescriptor>> | undefined): FitParts {
  const data = isRecord(entry.data) ? entry.data : {};
  const kind = typeof entry.type === 'string' ? entry.type : '';
  const head = { id: entry.id, type: entry.type, ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}) };
  const named: Record<string, unknown> = { ...head, name: nameOf(kind, data) };
  if (kind === 'group') return { slim: named, texts: [], named };

  const current = isRecord(entry.current) ? entry.current : undefined;
  const mode = typeof current?.mode === 'string' ? current.mode : typeof data.mode === 'string' ? data.mode : undefined;
  const texts: TextAt[] = [];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const rule: FieldRule = key in FIELD_RULES ? FIELD_RULES[key as FieldKey] : 'other';
    const at = ['data', key];
    if (rule === 'perMode') {
      if (mode === undefined || !isRecord(value) || typeof value[mode] !== 'string') continue;
      kept[key] = { [mode]: value[mode] };
      texts.push({ path: [...at, mode], text: value[mode] });
    } else if (rule === 'shots') {
      if (mode === MULTI_SHOT_MODE) kept[key] = keepEach(value, ARRAY_FIELD_RULES.shots, at, texts);
    } else if (rule === 'each') {
      kept[key] = keepEach(value, ARRAY_FIELD_RULES[key as keyof typeof ARRAY_FIELD_RULES], at, texts);
    } else if (rule === 'idle') {
      if (current === undefined) kept[key] = value;
    } else {
      const cls = typeof rule === 'string' ? rule : (rule.byKind[kind] ?? rule.otherwise);
      if (cls === 'other') continue;
      kept[key] = key === 'name' ? named.name : value;
      if (cls === 'content' && typeof value === 'string') texts.push({ path: at, text: value });
    }
  }
  const slim: Record<string, unknown> = { ...head, data: kept };
  if (current !== undefined) {
    slim.current = {
      mode: current.mode,
      model: current.model,
      params: isRecord(current.params) ? keepParams(current.params, descriptors, texts) : current.params,
    };
  }
  return { slim, texts, named };
}
