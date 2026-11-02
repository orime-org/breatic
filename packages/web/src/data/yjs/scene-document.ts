// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as Y from 'yjs';
import { z } from 'zod';

import {
  SCENE_FORMAT_VERSION, SceneObjectSchema, SceneObjectValuesSchema, getSceneRootMap,
  type SceneEditableField, type SceneModel, type SceneObject, type SceneObjectValues,
} from '@breatic/shared';

import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';

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
type ScenePlan = { ok: true; ids: readonly string[]; creates: SceneCreation[]; writes: SceneWrite[]; deletes: string[] }
  | { ok: false; reason: SceneCommandFailure };

/**
 * Values read for an editable key that has no live value. Two members writing
 * the same key at once, followed by the winner's undo, leaves the key empty;
 * the object stays visible and editable, as canvas nodes do.
 * @param model - The record's model, which names the fallback.
 * @returns Defaults for every editable key.
 */
function editableDefaults(model: SceneModel): Omit<SceneObjectValues, 'model'> {
  return { name: model.kind === 'builtin' ? model.id : 'Model', position: [0, 0, 0],
    rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
}

/**
 * Read one record of current values without mutating stored JSON.
 * @param id - Stable scene object identity.
 * @param value - Stored scene value to validate.
 * @returns Validated plain object.
 * @throws {Error} When the record is not a shared map.
 * @throws {z.ZodError} When the model or a stored value does not match the scene format.
 */
function readRecord(id: string, value: unknown): SceneObject {
  if (!(value instanceof Y.Map)) throw new Error('Object must be a shared map');
  const model = SceneObjectValuesSchema.shape.model.parse(value.get('model'));
  const stored: Record<string, unknown> = {};
  value.forEach((item: unknown, key: string) => { stored[key] = item; });
  return SceneObjectSchema.parse({ ...editableDefaults(model), ...stored, model, id });
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
    version = getSceneRootMap(doc, 'scene').get('formatVersion');
    records = getSceneRootMap(doc, 'objects');
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
        objects.push(readRecord(id, value));
      } catch (error) {
        invalidObjects.push({ id, error: String(error) });
      }
    });
  }
  return { status, version, objects, invalidObjects };
}

/**
 * Whether a stored format version predates this build; such scenes stay unopened and unchanged.
 * @param version - The document's `formatVersion` value.
 * @returns True for a number lower than the current format version.
 */
export function isOlderSceneFormat(version: unknown): boolean {
  return typeof version === 'number' && version < SCENE_FORMAT_VERSION;
}

/**
 * Validate a recovery candidate without upgrading or discarding unknown formats.
 * @param doc - Live collaborative scene document.
 * @throws {Error} When root types or format metadata are invalid.
 */
export function validateSceneRecovery(doc: Y.Doc): void {
  const scene = getSceneRootMap(doc, 'scene');
  const objects = getSceneRootMap(doc, 'objects');
  const version: unknown = scene.get('formatVersion');
  if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
    throw new Error('Invalid scene format version');
  }
  if (version === undefined && (scene.size > 0 || objects.size > 0)) {
    throw new Error('Missing scene format version');
  }
}

/**
 * Bind personal command history to the objects root; only this client's command origin is tracked.
 * @param doc - Live collaborative scene document.
 * @param origin - Origin tracked only by this local command history.
 * @returns Personal undo manager over local record creations, field overwrites and deletions.
 */
export function createSceneHistory(doc: Y.Doc, origin: symbol): Y.UndoManager {
  const root = doc.share.get('objects');
  // A decoded root must first acquire its Map constructor. An already typed
  // incompatible root stays intact for inspection by the format validator.
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
 * @returns Record creations, field overwrites and deletions, or the typed refusal.
 */
export function planSceneCommand(doc: Y.Doc, command: SceneCommand, canEdit: boolean): ScenePlan {
  if (!canEdit) return { ok: false, reason: 'readOnly' };
  const scene = readSceneDocument(doc);
  if (scene.status !== 'ready') return { ok: false, reason: 'unsupported' };
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const invalidIds = new Set(scene.invalidObjects.map((object) => object.id));
  const plan: Extract<ScenePlan, { ok: true }> = { ok: true, ids: [], creates: [], writes: [], deletes: [] };

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
        const name = SceneObjectValuesSchema.shape.name.safeParse(`${source.name} copy`);
        creations.push({ ...source, id: copy.id, name: name.success ? name.data : source.name,
          position: [source.position[0] + 1, source.position[1], source.position[2] + 1], locked: false });
      }
    }
    for (const creation of creations) {
      const parsed = SceneObjectSchema.safeParse(creation);
      if (!parsed.success || parsed.data.locked) return { ok: false, reason: 'invalid' };
      const { id, ...values } = parsed.data;
      plan.creates.push({ id, values });
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
    if (typeof command.locked !== 'boolean') return { ok: false, reason: 'invalid' };
    ids.forEach((id) => plan.writes.push({ id, field: 'locked', value: command.locked }));
  } else plan.deletes.push(...ids);
  plan.ids = ids;
  plan.writes = plan.writes.filter((write) => JSON.stringify(byId.get(write.id)?.[write.field]) !== JSON.stringify(write.value));
  return plan;
}

/**
 * Apply a validated command in one local transaction, which is one personal undo item.
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
  doc.transact(() => {
    for (const creation of plan.creates) {
      objects.set(creation.id, new Y.Map<unknown>(Object.entries(creation.values)));
    }
    for (const write of plan.writes) (objects.get(write.id) as Y.Map<unknown>).set(write.field, write.value);
    for (const id of plan.deletes) objects.delete(id);
  }, origin);
  return { ok: true, ids: plan.ids };
}
