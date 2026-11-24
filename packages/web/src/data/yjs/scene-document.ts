// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as Y from 'yjs';
import { z } from 'zod';

import {
  SCENE_AMBIENT_COLOR_DEFAULT, SCENE_AMBIENT_INTENSITY_DEFAULT, SCENE_AMBIENT_INTENSITY_MAX,
  SCENE_FORMAT_VERSION, SCENE_LOOK_FIELDS, SCENE_LOOK_KEY_PREFIX,
  SCENE_LOOK_MAX_PARTS, SCENE_POSE_KEY_PREFIX, SCENE_POSE_MAX_KEYS, SceneColorSchema, SceneLookSchema, SceneObjectSchema, SceneObjectValuesSchema,
  ScenePoseSchema, expandSceneLook, expandScenePose, getSceneRootMap, isSceneModelFile, nextDirectorNumber, readSceneRecord,
  type SceneEditableField, type SceneLook, type SceneLookField, type SceneLookPart, type SceneModel, type SceneObject, type SceneObjectValues, type ScenePose,
} from '@breatic/shared';

import { strongestKind, writeSpaceDoc, type SpaceRefusalReason, type SpaceWriteKind } from '@web/data/yjs/space-write';
import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';

/** Fields a `patch` command may write; a pose and a look are written by their own commands, a number and the lock by theirs. */
const PATCH_MASK = { name: true, position: true, rotation: true, scale: true,
  focalLength: true, frame: true, freeRatio: true, color: true, intensity: true, castShadow: true, angle: true } as const;
const PATCH_FIELDS = Object.keys(PATCH_MASK) as Array<keyof typeof PATCH_MASK>;
const PATCH_SCHEMA = SceneObjectValuesSchema.pick(PATCH_MASK).partial().extend({ id: z.string().uuid() }).strict();

/** The ambient light stored on the `scene` root. */
const SceneEnvironmentSchema = z.object({
  ambientColor: SceneColorSchema,
  ambientIntensity: z.number().finite().min(0).max(SCENE_AMBIENT_INTENSITY_MAX),
}).strict();
export type SceneEnvironmentValues = z.infer<typeof SceneEnvironmentSchema>;
const ENVIRONMENT_DEFAULTS: SceneEnvironmentValues = { ambientColor: SCENE_AMBIENT_COLOR_DEFAULT, ambientIntensity: SCENE_AMBIENT_INTENSITY_DEFAULT };

/** Limits a command is checked against; a caller that passes none may add no light. */
export interface SceneCommandLimits {
  maxLights: number;
}
const NO_LIGHTS: SceneCommandLimits = { maxLights: 0 };

export type ScenePatch = z.infer<typeof PATCH_SCHEMA>;
/** Look fields to write on one part; a null field is deleted. */
export type SceneLookSet = { readonly [K in SceneLookField]?: SceneLookPart[K] | null };
export type SceneCommand =
  | { type: 'create'; objects: readonly SceneObject[] }
  | { type: 'patch'; patches: readonly ScenePatch[] }
  | { type: 'delete'; ids: readonly string[] }
  | { type: 'lock'; ids: readonly string[]; locked: boolean }
  | { type: 'duplicate'; copies: readonly { sourceId: string; id: string }[] }
  | { type: 'pose'; id: string; set: ScenePose; replace: boolean }
  /** Writes one part's fields, or with a null part deletes every look key of the object. */
  | { type: 'look'; id: string; part: string | null; set: SceneLookSet }
  | { type: 'environment'; set: Partial<SceneEnvironmentValues> };

/**
 * Why a scene command was refused. `full`, `over_ceiling` and `resyncing` come from the Space's size (inner#1790)
 * and have already been told: `full` and `over_ceiling` by `writeSpaceDoc`'s toast, `resyncing` by the rebuild's
 * own toast.
 */
export type SceneCommandFailure = 'readOnly' | 'unsupported' | 'invalid' | 'locked' | 'missing' | 'duplicate' | 'lightLimit' | 'lookPartLimit'
  | 'poseBoneLimit' | SpaceRefusalReason;
export type SceneCommandResult = { ok: true; ids: readonly string[] } | { ok: false; reason: SceneCommandFailure };

export interface SceneDocumentSnapshot {
  status: 'loading' | 'ready' | 'unsupported';
  version: unknown;
  objects: readonly SceneObject[];
  invalidObjects: readonly { id: string; error: string }[];
  environment: SceneEnvironmentValues;
}

interface SceneWrite { id: string; field: SceneEditableField; value: unknown }
interface SceneUnset { id: string; field: SceneEditableField }
interface SceneCreation { id: string; values: SceneObjectValues }
/** One flat `pose.` or `look.` key on a record: written with a value, deleted without one. */
interface SceneKeyWrite { id: string; key: string; value?: unknown }
/** One key on the `scene` root. */
interface SceneRootWrite { key: keyof SceneEnvironmentValues; value: unknown }
/** `unsets` delete a key whose absence reads as its default (an unlock deletes `locked`). */
type ScenePlan = { ok: true; ids: readonly string[]; creates: SceneCreation[]; writes: SceneWrite[]; unsets: SceneUnset[]; deletes: string[];
  keyWrites: SceneKeyWrite[]; rootWrites: SceneRootWrite[] }
  | { ok: false; reason: SceneCommandFailure };

/**
 * Whether a refusal is the Space's size, which its own toast reported.
 * @param reason - The refusal.
 * @returns True for `full`, `over_ceiling` and `resyncing`.
 */
export function isSceneSizeRefusal(reason: SceneCommandFailure): reason is SpaceRefusalReason {
  return reason === 'full' || reason === 'over_ceiling' || reason === 'resyncing';
}

/**
 * Read the ambient light; a missing or malformed key reads as its default.
 * @param scene - The `scene` root.
 * @returns The ambient colour and intensity.
 */
function readEnvironment(scene: Y.Map<unknown>): SceneEnvironmentValues {
  const color = SceneEnvironmentSchema.shape.ambientColor.safeParse(scene.get('ambientColor'));
  const intensity = SceneEnvironmentSchema.shape.ambientIntensity.safeParse(scene.get('ambientIntensity'));
  return { ambientColor: color.success ? color.data : ENVIRONMENT_DEFAULTS.ambientColor,
    ambientIntensity: intensity.success ? intensity.data : ENVIRONMENT_DEFAULTS.ambientIntensity };
}

/**
 * Read one record of current values without mutating stored JSON.
 * @param id - Stable scene object identity.
 * @param value - Stored scene value to validate.
 * @returns Validated plain object.
 * @throws {Error} When the record is not a shared map, or stores a whole look or pose under one key.
 * @throws {z.ZodError} When the model or a stored value does not match the scene format.
 */
function readRecord(id: string, value: unknown): SceneObject {
  if (!(value instanceof Y.Map)) throw new Error('Object must be a shared map');
  return readSceneRecord(id, Object.fromEntries(value.entries()));
}

/**
 * Project independently readable objects, keeping invalid records available for diagnosis.
 * @param doc - Live collaborative scene document.
 * @returns Format status, visible valid objects and isolated object errors.
 */
export function readSceneDocument(doc: Y.Doc): SceneDocumentSnapshot {
  let version: unknown;
  let records: Y.Map<unknown>;
  let root: Y.Map<unknown>;
  try {
    root = getSceneRootMap(doc, 'scene');
    version = root.get('formatVersion');
    records = getSceneRootMap(doc, 'objects');
  } catch (error) {
    return { status: 'unsupported', version, objects: [], invalidObjects: [
      { id: 'scene', error: String(error) },
    ], environment: ENVIRONMENT_DEFAULTS };
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
  return { status, version, objects, invalidObjects, environment: readEnvironment(root) };
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
 * Bind personal command history to the objects and scene roots; only this client's command origin is tracked.
 * @param doc - Live collaborative scene document.
 * @param origin - Origin tracked only by this local command history.
 * @returns Personal undo manager over local record creations, field overwrites, deletions and ambient changes.
 */
export function createSceneHistory(doc: Y.Doc, origin: symbol): Y.UndoManager {
  // A decoded root must first acquire its Map constructor. An already typed
  // incompatible root stays intact for inspection by the format validator.
  const scope = (['objects', 'scene'] as const).map((name) => {
    const root = doc.share.get(name);
    return root && root.constructor !== Y.AbstractType ? root : doc.getMap(name);
  });
  return withDestroyListenerCleanup(doc, () => new Y.UndoManager(scope, {
    trackedOrigins: new Set([origin]), captureTimeout: 0,
  }));
}

/**
 * Count the valid lights a projection holds.
 * @param objects - Valid records.
 * @returns How many are lights.
 */
function lightCount(objects: readonly { model: SceneModel }[]): number {
  return objects.filter((object) => object.model.kind === 'light').length;
}

/**
 * Plan one command from current committed content and the caller's current permission.
 * @param doc - Live collaborative scene document.
 * @param _name - Its canonical document name; the size is judged when the plan is written.
 * @param command - User operation to validate against current committed scene data.
 * @param canEdit - Current write permission derived from role and connection facts.
 * @param limits - What the command is checked against; without them no light can be added.
 * @returns Record creations, field overwrites and deletions, or the typed refusal.
 */
export function planSceneCommand(doc: Y.Doc, _name: string, command: SceneCommand, canEdit: boolean, limits: SceneCommandLimits = NO_LIGHTS): ScenePlan {
  if (!canEdit) return { ok: false, reason: 'readOnly' };
  const scene = readSceneDocument(doc);
  if (scene.status !== 'ready') return { ok: false, reason: 'unsupported' };
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const invalidIds = new Set(scene.invalidObjects.map((object) => object.id));
  const plan: Extract<ScenePlan, { ok: true }> = { ok: true, ids: [], creates: [], writes: [], unsets: [], deletes: [], keyWrites: [], rootWrites: [] };

  if (command.type === 'environment') {
    const parsed = SceneEnvironmentSchema.partial().safeParse(command.set);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    for (const key of ['ambientColor', 'ambientIntensity'] as const) {
      const value = parsed.data[key];
      if (value !== undefined && value !== scene.environment[key]) plan.rootWrites.push({ key, value });
    }
    return plan;
  }

  if (command.type === 'create' || command.type === 'duplicate') {
    const requested = command.type === 'create' ? command.objects.map((object) => object.id) : command.copies.map((copy) => copy.id);
    if (new Set(requested).size !== requested.length || requested.some((id) => doc.getMap('objects').has(id))) {
      return { ok: false, reason: 'duplicate' };
    }
    const creations: unknown[] = [];
    if (command.type === 'create') creations.push(...command.objects);
    else {
      // Copies of a camera or a light take the next numbers of their kind, one after another.
      const next = { camera: nextDirectorNumber(scene.objects, 'camera'), light: nextDirectorNumber(scene.objects, 'light') };
      for (const copy of command.copies) {
        const source = byId.get(copy.sourceId);
        if (!source) return { ok: false, reason: invalidIds.has(copy.sourceId) ? 'invalid' : 'missing' };
        const name = SceneObjectValuesSchema.shape.name.safeParse(`${source.name} copy`);
        creations.push({ ...source, id: copy.id, name: name.success ? name.data : source.name,
          position: [source.position[0] + 1, source.position[1], source.position[2] + 1], locked: false,
          ...(isSceneModelFile(source.model) ? {} : { number: next[source.model.kind]++ }) });
      }
    }
    for (const creation of creations) {
      const parsed = SceneObjectSchema.safeParse(creation);
      if (!parsed.success || parsed.data.locked) return { ok: false, reason: 'invalid' };
      // A copy keeps what its source holds; a new object comes within the caps a command writes to.
      if (command.type === 'create' && (Object.keys(parsed.data.pose ?? {}).length > SCENE_POSE_MAX_KEYS
        || Object.keys(parsed.data.look ?? {}).length > SCENE_LOOK_MAX_PARTS)) return { ok: false, reason: 'invalid' };
      const { id, ...values } = parsed.data;
      plan.creates.push({ id, values });
    }
    const added = lightCount(plan.creates.map((creation) => creation.values));
    if (added > 0 && lightCount(scene.objects) + added > limits.maxLights) return { ok: false, reason: 'lightLimit' };
    plan.ids = requested;
    return plan;
  }

  if (command.type === 'pose') {
    const object = byId.get(command.id);
    if (!object) return { ok: false, reason: invalidIds.has(command.id) ? 'invalid' : 'missing' };
    if (object.locked) return { ok: false, reason: 'locked' };
    if (!isSceneModelFile(object.model)) return { ok: false, reason: 'invalid' };
    const set = ScenePoseSchema.safeParse(command.set);
    if (!set.success) return { ok: false, reason: 'invalid' };
    const current: ScenePose = object.pose ?? {};
    const cleared = command.replace ? Object.keys(current).filter((key) => !(key in set.data)) : [];
    const next = command.replace ? set.data : { ...current, ...set.data };
    if (!ScenePoseSchema.safeParse(next).success) return { ok: false, reason: 'invalid' };
    if (grows(current, next, SCENE_POSE_MAX_KEYS)) return { ok: false, reason: 'poseBoneLimit' };
    for (const [key, value] of Object.entries(set.data)) {
      if (JSON.stringify(current[key]) !== JSON.stringify(value)) plan.keyWrites.push({ id: command.id, key: `${SCENE_POSE_KEY_PREFIX}${key}`, value });
    }
    cleared.forEach((key) => plan.keyWrites.push({ id: command.id, key: `${SCENE_POSE_KEY_PREFIX}${key}` }));
    plan.ids = [command.id];
    return plan;
  }

  if (command.type === 'look') {
    const object = byId.get(command.id);
    if (!object) return { ok: false, reason: invalidIds.has(command.id) ? 'invalid' : 'missing' };
    if (object.locked) return { ok: false, reason: 'locked' };
    if (!isSceneModelFile(object.model)) return { ok: false, reason: 'invalid' };
    const writes = lookWrites(object.look ?? {}, command.part, command.set);
    if (writes === 'partLimit') return { ok: false, reason: 'lookPartLimit' };
    if (writes === null) return { ok: false, reason: 'invalid' };
    plan.keyWrites.push(...writes.map((write) => ({ ...write, id: command.id })));
    plan.ids = [command.id];
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
      const object = byId.get(patch.id) as SceneObject;
      const { model } = object;
      if (model.kind === 'light' && model.type === 'point' && parsed.data.rotation !== undefined) return { ok: false, reason: 'invalid' };
      if (!SceneObjectSchema.safeParse({ ...object, ...parsed.data }).success) return { ok: false, reason: 'invalid' };
      for (const field of PATCH_FIELDS) {
        if (parsed.data[field] !== undefined) plan.writes.push({ id: patch.id, field, value: parsed.data[field] });
      }
    }
  } else if (command.type === 'lock') {
    if (typeof command.locked !== 'boolean') return { ok: false, reason: 'invalid' };
    ids.forEach((id) => plan.writes.push({ id, field: 'locked', value: command.locked }));
  } else plan.deletes.push(...ids);
  plan.ids = ids;
  plan.writes = plan.writes.filter((write) => JSON.stringify(byId.get(write.id)?.[write.field]) !== JSON.stringify(write.value));
  // Unlocked is the default a missing key reads as, so an unlock deletes the key: a whole map entry (inner#1790).
  plan.unsets = plan.writes.filter((write) => write.field === 'locked' && write.value === false).map(({ id, field }) => ({ id, field }));
  plan.writes = plan.writes.filter((write) => !(write.field === 'locked' && write.value === false));
  return plan;
}

/**
 * The record key one part field is stored under.
 * @param part - The part.
 * @param field - The field.
 * @returns `look.<part>.<field>`.
 */
function lookKey(part: string, field: string): string {
  return `${SCENE_LOOK_KEY_PREFIX}${part}.${field}`;
}

/**
 * Whether a write would take a record past a cap on how many entries it holds. A record already past it, after two
 * members' concurrent additions merged, can still change the entries it has.
 * @param current - The entries before the write.
 * @param next - The entries after it.
 * @param cap - The most entries a command may leave.
 * @returns True when the write adds entries beyond the cap.
 */
function grows(current: object, next: object, cap: number): boolean {
  const count = Object.keys(next).length;
  return count > cap && count > Object.keys(current).length;
}

/**
 * The flat keys a look command writes: changed values set, null fields deleted, or with a null part every key deleted.
 * @param current - The object's current look.
 * @param part - The part to write, or null to reset every part.
 * @param set - Fields to write; a null field is deleted.
 * @returns The key writes without an id, 'partLimit' when the look would gain a part past the cap, or null when the
 * command or the resulting look is invalid.
 */
function lookWrites(current: SceneLook, part: string | null, set: SceneLookSet): Omit<SceneKeyWrite, 'id'>[] | 'partLimit' | null {
  if (part === null) {
    if (typeof set !== 'object' || set === null || Object.keys(set).length > 0) return null;
    return Object.entries(current).flatMap(([at, fields]) => Object.keys(fields).map((field) => ({ key: lookKey(at, field) })));
  }
  if (typeof part !== 'string' || typeof set !== 'object' || set === null) return null;
  const entries = Object.entries(set);
  if (entries.some(([field]) => !(SCENE_LOOK_FIELDS as readonly string[]).includes(field))) return null;
  const values = Object.fromEntries(entries.filter(([, value]) => value !== null));
  // Own keys from Object.fromEntries, so a `__proto__` part is judged like any other key.
  if (!SceneLookSchema.safeParse(Object.fromEntries([[part, values]])).success) return null;
  const before: SceneLookPart = Object.prototype.hasOwnProperty.call(current, part) ? current[part] ?? {} : {};
  const after = Object.fromEntries(Object.entries({ ...before, ...values }).filter(([field]) => set[field as SceneLookField] !== null));
  const others = Object.entries(current).filter(([at]) => at !== part);
  const next = Object.fromEntries(Object.keys(after).length > 0 ? [...others, [part, after]] : others);
  if (!SceneLookSchema.safeParse(next).success) return null;
  if (grows(current, next, SCENE_LOOK_MAX_PARTS)) return 'partLimit';
  const record = before as Record<string, unknown>;
  return entries.flatMap(([field, value]) => {
    if (value === null) return field in record ? [{ key: lookKey(part, field) }] : [];
    return JSON.stringify(record[field]) === JSON.stringify(value) ? [] : [{ key: lookKey(part, field), value }];
  });
}

/**
 * What a plan writes in Yjs: new records `add`, field values `edit`, deleted keys and records `remove`.
 * @param plan - The accepted plan.
 * @returns The strongest of them.
 */
function planKind(plan: Extract<ScenePlan, { ok: true }>): SpaceWriteKind {
  const edits = plan.writes.length > 0 || plan.rootWrites.length > 0 || plan.keyWrites.some((write) => write.value !== undefined);
  return strongestKind(...(plan.creates.length > 0 ? ['add' as const] : []), ...(edits ? ['edit' as const] : []));
}

/**
 * Apply a validated command in one local transaction, which is one personal undo item, if the Space's size allows
 * what it writes; a size refusal shows its toast once.
 * @param doc - Live collaborative scene document.
 * @param command - User operation to validate against current committed scene data.
 * @param origin - Origin tracked only by this local command history.
 * @param canEdit - Current write permission derived from role and connection facts.
 * @param name - Its canonical document name, whose size gates the write.
 * @param limits - What the command is checked against; without them no light can be added.
 * @returns Affected object identities or the command refusal.
 */
export function applySceneCommand(doc: Y.Doc, command: SceneCommand, origin: symbol, canEdit: boolean, name: string,
  limits: SceneCommandLimits = NO_LIGHTS): SceneCommandResult {
  const plan = planSceneCommand(doc, name, command, canEdit, limits);
  if (!plan.ok) return plan;
  // A command that changes nothing leaves no transaction, so no empty undo item.
  if (plan.creates.length + plan.writes.length + plan.unsets.length + plan.deletes.length + plan.keyWrites.length + plan.rootWrites.length === 0) {
    return { ok: true, ids: plan.ids };
  }
  const objects = doc.getMap<unknown>('objects');
  const root = doc.getMap<unknown>('scene');
  const written = writeSpaceDoc(name, { kind: planKind(plan) }, () => doc.transact(() => {
    for (const creation of plan.creates) {
      const { pose, look, ...values } = creation.values;
      objects.set(creation.id, new Y.Map<unknown>(Object.entries({ ...values, ...expandScenePose(pose ?? {}), ...expandSceneLook(look ?? {}) })));
    }
    for (const write of plan.writes) (objects.get(write.id) as Y.Map<unknown>).set(write.field, write.value);
    for (const unset of plan.unsets) (objects.get(unset.id) as Y.Map<unknown>).delete(unset.field);
    for (const write of plan.keyWrites) {
      const record = objects.get(write.id) as Y.Map<unknown>;
      if (write.value === undefined) record.delete(write.key);
      else record.set(write.key, write.value);
    }
    for (const id of plan.deletes) objects.delete(id);
    for (const write of plan.rootWrites) root.set(write.key, write.value);
  }, origin));
  return written.ok ? { ok: true, ids: plan.ids } : written;
}
