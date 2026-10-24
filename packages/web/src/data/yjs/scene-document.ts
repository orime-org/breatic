// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';
import { z } from 'zod';

import {
  SCENE_EDITABLE_FIELDS, SCENE_FORMAT_VERSION, SceneObjectSchema, SceneObjectValuesSchema,
  type SceneEditableField, type SceneObject, type SceneObjectValues,
} from '@breatic/shared';

import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';

const SYSTEM_ORIGIN = Symbol('scene-stable-record');
const PATCH_SCHEMA = SceneObjectValuesSchema.pick({ name: true, position: true, rotation: true, scale: true })
  .partial().extend({ id: z.string().uuid() }).strict();

export type ScenePatch = z.infer<typeof PATCH_SCHEMA>;
export type SceneCommand =
  | { type: 'create'; objects: readonly SceneObject[] }
  | { type: 'patch'; patches: readonly ScenePatch[] }
  | { type: 'delete'; ids: readonly string[] }
  | { type: 'lock'; ids: readonly string[]; locked: boolean }
  | { type: 'duplicate'; copies: readonly { sourceId: string; id: string }[] };

export type SceneCommandFailure = 'readOnly' | 'unsupported' | 'invalid' | 'locked' | 'missing' | 'duplicate';
export type SceneCommandResult = { ok: true; ids: readonly string[] } | { ok: false; reason: SceneCommandFailure };

export interface SceneDocumentSnapshot {
  status: 'loading' | 'ready' | 'unsupported';
  version: unknown;
  objects: readonly SceneObject[];
  invalidObjects: readonly { id: string; error: string }[];
}

interface SceneWrite { id: string; field: SceneEditableField; value: unknown }
interface SceneCreation { id: string; values: SceneObjectValues }
type ScenePlan = { ok: true; ids: readonly string[]; creates: SceneCreation[]; writes: SceneWrite[] }
  | { ok: false; reason: SceneCommandFailure };

/**
 * Read complete values from stable arrays without mutating stored JSON.
 * @param id - Stable scene object identity.
 * @param value - Stored scene value to validate or format.
 * @returns Validated plain object with independently owned JSON tuples.
 * @throws {Error} When the record structure or initial flags are invalid.
 * @throws {z.ZodError} When stored values do not match the scene format.
 */
function readRecord(id: string, value: unknown): SceneObject {
  if (!(value instanceof Y.Map)) throw new Error('Object must be a shared map');
  const initial = SceneObjectValuesSchema.parse(value.get('initial'));
  if (initial.exists || initial.locked) throw new Error('Invalid initial protection or existence flag');
  const current: Record<string, unknown> = { ...initial, id };
  for (const field of SCENE_EDITABLE_FIELDS) {
    const sequence: unknown = value.get(field);
    if (!(sequence instanceof Y.Array)) throw new Error(`Missing ${field} sequence`);
    const schema = SceneObjectValuesSchema.shape[field];
    const values: unknown[] = sequence.toArray();
    for (const item of values) schema.parse(item);
    current[field] = values.length ? values[values.length - 1] : initial[field];
  }
  return SceneObjectSchema.parse(current);
}

/**
 * Project independently readable objects, keeping invalid records available for diagnosis.
 * @param doc - Live collaborative scene document.
 * @returns Format status, visible valid objects and isolated object errors.
 */
export function readSceneDocument(doc: Y.Doc): SceneDocumentSnapshot {
  let version: unknown;
  let records: Y.Map<unknown>;
  try {
    version = doc.getMap('scene').get('formatVersion');
    records = doc.getMap('objects');
  } catch (error) {
    return { status: 'unsupported', version, objects: [], invalidObjects: [
      { id: 'scene', error: String(error) },
    ] };
  }
  const status = version === undefined ? 'loading' : version === SCENE_FORMAT_VERSION ? 'ready' : 'unsupported';
  const objects: SceneObject[] = [];
  const invalidObjects: { id: string; error: string }[] = [];
  if (status === 'ready') {
    records.forEach((value: unknown, id: string) => {
      try {
        const object = readRecord(id, value);
        if (object.exists) objects.push(object);
      } catch (error) {
        invalidObjects.push({ id, error: String(error) });
      }
    });
  }
  return { status, version, objects, invalidObjects };
}

/**
 * Validate a recovery candidate without upgrading or discarding unknown formats.
 * @param doc - Live collaborative scene document.
 * @throws {Error} When root types or format metadata are invalid.
 */
export function validateSceneRecovery(doc: Y.Doc): void {
  const scene = doc.getMap('scene');
  const objects = doc.getMap('objects');
  const version: unknown = scene.get('formatVersion');
  if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
    throw new Error('Invalid scene format version');
  }
  const snapshot = readSceneDocument(doc);
  if (snapshot.status === 'loading' && (scene.size > 0 || objects.size > 0)) {
    throw new Error('Missing scene format version');
  }
  // Invalid objects remain independently inspectable, just as on the wire.
}

/**
 * Bind personal command history to stable records; remote and setup origins are excluded.
 * @param doc - Live collaborative scene document.
 * @param origin - Origin tracked only by this local command history.
 * @returns Personal undo manager observing only local command inserts.
 */
export function createSceneHistory(doc: Y.Doc, origin: symbol): Y.UndoManager {
  const root = doc.share.get('objects');
  // A decoded root must first acquire its Map constructor. An already typed
  // incompatible root stays intact so the session can expose recovery/export.
  const scope = root && root.constructor !== Y.AbstractType ? root : doc.getMap('objects');
  return withDestroyListenerCleanup(doc, () => new Y.UndoManager(scope, {
    trackedOrigins: new Set([origin]), captureTimeout: 0,
  }));
}

/**
 * Plan one command from current committed content and the caller's current permission.
 * @param doc - Live collaborative scene document.
 * @param command - User operation to validate against current committed scene data.
 * @param canEdit - Current write permission derived from role and connection facts.
 * @returns Atomic field writes and creations, or the typed refusal.
 */
export function planSceneCommand(doc: Y.Doc, command: SceneCommand, canEdit: boolean): ScenePlan {
  if (!canEdit) return { ok: false, reason: 'readOnly' };
  const scene = readSceneDocument(doc);
  if (scene.status !== 'ready') return { ok: false, reason: 'unsupported' };
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const invalidIds = new Set(scene.invalidObjects.map((object) => object.id));
  const plan: Extract<ScenePlan, { ok: true }> = { ok: true, ids: [], creates: [], writes: [] };

  if (command.type === 'create' || command.type === 'duplicate') {
    const requested = command.type === 'create' ? command.objects.map((object) => object.id) : command.copies.map((copy) => copy.id);
    if (new Set(requested).size !== requested.length || requested.some((id) => doc.getMap('objects').has(id))) {
      return { ok: false, reason: 'duplicate' };
    }
    const creations: unknown[] = [];
    if (command.type === 'create') creations.push(...command.objects);
    else {
      for (const copy of command.copies) {
        const source = byId.get(copy.sourceId);
        if (!source) return { ok: false, reason: invalidIds.has(copy.sourceId) ? 'invalid' : 'missing' };
        creations.push({ ...source, id: copy.id, locked: false });
      }
    }
    for (const creation of creations) {
      const parsed = SceneObjectSchema.safeParse(creation);
      if (!parsed.success || parsed.data.locked || !parsed.data.exists) return { ok: false, reason: 'invalid' };
      const { id, ...values } = parsed.data;
      plan.creates.push({ id, values: { ...values, exists: false, locked: false } });
      plan.writes.push({ id, field: 'exists', value: true });
    }
    plan.ids = requested;
    return plan;
  }

  const ids = command.type === 'patch' ? command.patches.map((patch) => patch.id) : command.ids;
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'invalid' };
  for (const id of ids) {
    const object = byId.get(id);
    if (!object) return { ok: false, reason: invalidIds.has(id) ? 'invalid' : 'missing' };
    if (object.locked && command.type !== 'lock') return { ok: false, reason: 'locked' };
  }
  if (command.type === 'patch') {
    for (const patch of command.patches) {
      const parsed = PATCH_SCHEMA.safeParse(patch);
      if (!parsed.success) return { ok: false, reason: 'invalid' };
      for (const field of ['name', 'position', 'rotation', 'scale'] as const) {
        if (parsed.data[field] !== undefined) plan.writes.push({ id: patch.id, field, value: parsed.data[field] });
      }
    }
  } else if (command.type === 'lock') {
    ids.forEach((id) => plan.writes.push({ id, field: 'locked', value: command.locked }));
  } else ids.forEach((id) => plan.writes.push({ id, field: 'exists', value: false }));
  plan.ids = ids;
  plan.writes = plan.writes.filter((write) => JSON.stringify((byId.get(write.id) as SceneObject)[write.field]) !== JSON.stringify(write.value));
  return plan;
}

/**
 * Apply a freshly validated command; each complete user operation creates one undo item.
 * @param doc - Live collaborative scene document.
 * @param command - User operation to validate against current committed scene data.
 * @param origin - Origin tracked only by this local command history.
 * @param canEdit - Current write permission derived from role and connection facts.
 * @returns Affected object identities or the command refusal.
 */
export function applySceneCommand(doc: Y.Doc, command: SceneCommand, origin: symbol, canEdit: boolean): SceneCommandResult {
  const plan = planSceneCommand(doc, command, canEdit);
  if (!plan.ok) return plan;
  const objects = doc.getMap<unknown>('objects');
  if (plan.creates.length) {
    doc.transact(() => {
      for (const creation of plan.creates) {
        const record = new Y.Map<unknown>();
        record.set('initial', structuredClone(creation.values));
        SCENE_EDITABLE_FIELDS.forEach((field) => record.set(field, new Y.Array<unknown>()));
        objects.set(creation.id, record);
      }
    }, SYSTEM_ORIGIN);
  }
  doc.transact(() => {
    for (const write of plan.writes) {
      const record = objects.get(write.id) as Y.Map<unknown>;
      const sequence = record.get(write.field) as Y.Array<unknown>;
      sequence.push([structuredClone(write.value)]);
    }
  }, origin);
  return { ok: true, ids: plan.ids };
}
