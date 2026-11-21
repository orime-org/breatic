// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** A complete position or camera coordinate in metres, using Y-up. */
export const SceneVectorSchema = z.tuple([
  z.number().finite(), z.number().finite(), z.number().finite(),
]);

/** A complete, normalized XYZW rotation; tolerance covers float round-off. */
export const SceneRotationSchema = z.tuple([
  z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
]).refine((value) => Math.abs(Math.hypot(...value) - 1) <= 0.0001,
  'Rotation must be normalized');

/** Positive per-axis scales; reflected and degenerate transforms are unsupported. */
export const SceneScaleSchema = z.tuple([
  z.number().finite().positive(), z.number().finite().positive(), z.number().finite().positive(),
]);

/** The three light types a scene can hold. */
export const SCENE_LIGHT_TYPES = ['directional', 'point', 'spot'] as const;
export type SceneLightType = (typeof SCENE_LIGHT_TYPES)[number];

/**
 * Stable model identity; storage addresses are resolved from registered assets.
 * Cameras and lights are records of their own kinds that carry no model file.
 */
export const SceneModelSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), id: z.enum(['figure', 'box']) }).strict(),
  z.object({ kind: z.literal('asset'), assetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('camera') }).strict(),
  z.object({ kind: z.literal('light'), type: z.enum(SCENE_LIGHT_TYPES) }).strict(),
]);

/** Frame ratios a viewfinder or a camera can hold, `Free` first. */
export const VIEWFINDER_RATIOS = ['Free', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'] as const;
export type ViewfinderRatio = (typeof VIEWFINDER_RATIOS)[number];
export const DEFAULT_VIEWFINDER_RATIO: ViewfinderRatio = '16:9';

/** Width over height bounds of a free frame, shared by the schema and the viewfinder geometry. */
export const SCENE_FREE_RATIO_MIN = 0.2;
export const SCENE_FREE_RATIO_MAX = 5;

/** Camera lens bounds in millimetres on a 36 mm film gauge, and the lens a record without one reads as. */
export const SCENE_FOCAL_LENGTH_MIN = 8;
export const SCENE_FOCAL_LENGTH_MAX = 300;
export const SCENE_FOCAL_LENGTH_DEFAULT = 35;

/** Spotlight cone half-angle bounds in degrees, and the angle a spotlight without one reads as. */
export const SCENE_SPOT_ANGLE_MIN = 5;
export const SCENE_SPOT_ANGLE_MAX = 80;
export const SCENE_SPOT_ANGLE_DEFAULT = 30;

/** Each light type's intensity a new light gets and the most it may hold. */
export const SCENE_LIGHT_INTENSITY: Readonly<Record<SceneLightType, { initial: number; max: number }>> = {
  directional: { initial: 3, max: 20 },
  point: { initial: 40, max: 400 },
  spot: { initial: 40, max: 400 },
};

/** The colour a light without one reads as. */
export const SCENE_LIGHT_COLOR_DEFAULT = '#ffffff';

/** The ambient light a scene without its own setting reads as, and the strongest it may be. */
export const SCENE_AMBIENT_COLOR_DEFAULT = '#ffffff';
export const SCENE_AMBIENT_INTENSITY_DEFAULT = 2.7;
export const SCENE_AMBIENT_INTENSITY_MAX = 10;

/** A colour stored as lowercase `#rrggbb`. */
export const SceneColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

/** The longest name a scene object holds. */
export const SCENE_OBJECT_NAME_MAX = 256;

/** Every pose entry is its own key on the object record, behind this prefix (inner#1692). */
export const SCENE_POSE_KEY_PREFIX = 'pose.';

/**
 * The most bones a command may give one object's pose. A record is judged by its entries alone, since two members'
 * concurrent writes merge into the union of their keys.
 */
export const SCENE_POSE_MAX_KEYS = 256;

/** The longest pose key, counted without {@link SCENE_POSE_KEY_PREFIX}. */
export const SCENE_POSE_KEY_MAX_LENGTH = 128;

/** The hips translation key; the only pose entry that is a vector. */
export const SCENE_POSE_HIPS_KEY = 't:hips';

/** A humanoid bone (`h:`) or a node of another rig (`n:`), each carrying a rotation. */
const ROTATION_KEY = /^[hn]:.+$/su;

/**
 * Bones changed from rest, keyed `h:<VRM bone>` or `n:<node name>` to a normalized
 * rotation, plus `t:hips` to the hips translation in hip heights.
 */
export type ScenePose = Readonly<Record<string, readonly number[]>>;

/**
 * Check one pose entry against the shape its key names.
 * @param key - The pose key without the record prefix.
 * @param value - The stored value.
 * @returns Whether the entry is well formed.
 */
function isPoseEntry(key: string, value: unknown): boolean {
  if (key === SCENE_POSE_HIPS_KEY) return SceneVectorSchema.safeParse(value).success;
  return key.length <= SCENE_POSE_KEY_MAX_LENGTH && ROTATION_KEY.test(key) && SceneRotationSchema.safeParse(value).success;
}

/**
 * Check a whole pose; own keys are read as given, so `__proto__` is judged like any other key.
 * @param value - The candidate pose.
 * @returns Whether every entry is well formed.
 */
function isScenePose(value: unknown): value is ScenePose {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) => isPoseEntry(key, entry));
}

/** A pose as one value: the projection and commands carry it, the record stores it flat. */
export const ScenePoseSchema = z.custom<ScenePose>(isScenePose, 'Invalid scene pose');

/**
 * Collect a record's flat pose keys into one `pose` value.
 * @param record - A stored object record's plain values.
 * @returns A copy without the flat keys, carrying `pose` only when the record had any.
 */
export function gatherScenePose(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Object.fromEntries defines own keys, so a stored `pose.__proto__` is validated like any other key.
  const entries = Object.entries(record);
  const pose = entries.filter(([key]) => key.startsWith(SCENE_POSE_KEY_PREFIX))
    .map(([key, value]) => [key.slice(SCENE_POSE_KEY_PREFIX.length), value]);
  const values = Object.fromEntries(entries.filter(([key]) => !key.startsWith(SCENE_POSE_KEY_PREFIX)));
  return pose.length > 0 ? { ...values, pose: Object.fromEntries(pose) } : values;
}

/**
 * Spread a pose into the flat record keys it is stored under.
 * @param pose - The pose to store.
 * @returns One prefixed key per entry.
 */
export function expandScenePose(pose: ScenePose): Record<string, unknown> {
  return Object.fromEntries(Object.entries(pose).map(([key, value]) => [`${SCENE_POSE_KEY_PREFIX}${key}`, value]));
}

/** Every changed field of a part's look is its own key on the object record: `look.<part>.<field>` (inner#1693). */
export const SCENE_LOOK_KEY_PREFIX = 'look.';

/** The most parts a command may give one object's look; a record is judged by its parts alone, as for the pose. */
export const SCENE_LOOK_MAX_PARTS = 256;

/** The colour a part shows a user picture at while no colour is stored, so the picture keeps its own colours. */
export const SCENE_LOOK_PICTURE_COLOR = '#ffffff';

/** The glow colour of a part whose model gives none. */
export const SCENE_LOOK_EMISSIVE_DEFAULT = '#000000';

/** The part that holds primitives without a material. */
export const SCENE_LOOK_DEFAULT_PART = 'd';

/** A part is a glTF material index from 0 to 9999 without leading zeros, or the default part. */
const LOOK_PART_KEY = /^(?:0|[1-9]\d{0,3}|d)$/u;

/**
 * Whether a part can carry a look: a material index past the stored key format cannot.
 * @param part - The part key.
 * @returns True for a material index from 0 to 9999 or the default part.
 */
export function isSceneLookPartKey(part: string): boolean {
  return LOOK_PART_KEY.test(part);
}

const unit = z.number().finite().min(0).max(1);

/** The smallest tiling count a part takes either way; Blender, Unity, Godot and Babylon set no bound, this one only keeps the value finite. */
export const SCENE_LOOK_REPEAT_MIN = 0.0001;

/** The largest tiling count a part takes either way. */
export const SCENE_LOOK_REPEAT_MAX = 10000;

/** One tiling count: a negative count mirrors the picture, as glTF's KHR_texture_transform allows. */
const LOOK_REPEAT = z.number().finite().refine((value) => Math.abs(value) >= SCENE_LOOK_REPEAT_MIN && Math.abs(value) <= SCENE_LOOK_REPEAT_MAX);

/** The largest offset a part takes either way, in picture widths. */
export const SCENE_LOOK_OFFSET_MAX = 100;

/** The largest rotation a part takes either way, in degrees. */
export const SCENE_LOOK_ROTATION_MAX = 180;

/** One offset, in picture widths. */
const LOOK_OFFSET = z.number().finite().min(-SCENE_LOOK_OFFSET_MAX).max(SCENE_LOOK_OFFSET_MAX);

/** A part's picture: an asset id, or `'none'` to turn the model's own picture off. */
export const SceneLookMapSchema = z.union([z.string().uuid(), z.literal('none')]);

/** The fields one part may change; each is optional and absent means the model's own value, except that an absent colour on a part showing a user picture reads as {@link SCENE_LOOK_PICTURE_COLOR}. */
const SceneLookPartSchema = z.object({
  color: SceneColorSchema,
  roughness: unit,
  metalness: unit,
  opacity: unit,
  transmission: unit,
  emissive: SceneColorSchema,
  emissiveIntensity: z.number().finite().min(0).max(10),
  map: SceneLookMapSchema,
  mapRepeat: z.tuple([LOOK_REPEAT, LOOK_REPEAT]),
  mapOffset: z.tuple([LOOK_OFFSET, LOOK_OFFSET]),
  mapRotation: z.number().finite().min(-SCENE_LOOK_ROTATION_MAX).max(SCENE_LOOK_ROTATION_MAX),
}).partial().strict();

export type SceneLookPart = z.infer<typeof SceneLookPartSchema>;
export type SceneLookField = keyof SceneLookPart;
/** Changed parts keyed by part. */
export type SceneLook = Readonly<Record<string, SceneLookPart>>;

/** Every look field, in panel order. */
export const SCENE_LOOK_FIELDS = Object.keys(SceneLookPartSchema.shape) as readonly SceneLookField[];

/**
 * Check a whole look; own keys are read as given, so `__proto__` is judged like any other key.
 * @param value - The candidate look.
 * @returns Whether every part is well formed.
 */
function isSceneLook(value: unknown): value is SceneLook {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([part, fields]) => LOOK_PART_KEY.test(part) && SceneLookPartSchema.safeParse(fields).success);
}

/** A look as one value: the projection and commands carry it, the record stores it flat. */
export const SceneLookSchema = z.custom<SceneLook>(isSceneLook, 'Invalid scene look');

/**
 * Collect a record's flat look keys into one `look` value; a `look.` key without exactly a part and a field stays as it is and is refused by the strict schema.
 * @param record - A stored object record's plain values.
 * @returns A copy without the gathered keys, carrying `look` only when the record had any.
 */
export function gatherSceneLook(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const values: [string, unknown][] = [];
  const parts = new Map<string, [string, unknown][]>();
  for (const [key, value] of Object.entries(record)) {
    const path = key.startsWith(SCENE_LOOK_KEY_PREFIX) ? key.slice(SCENE_LOOK_KEY_PREFIX.length).split('.') : [];
    const [part, field] = path;
    if (path.length !== 2 || !part || !field) {
      values.push([key, value]);
      continue;
    }
    const fields = parts.get(part) ?? [];
    fields.push([field, value]);
    parts.set(part, fields);
  }
  // Object.fromEntries defines own keys, so a stored `look.__proto__.x` is validated like any other part.
  const gathered = Object.fromEntries(values);
  if (parts.size === 0) return gathered;
  return { ...gathered, look: Object.fromEntries([...parts].map(([part, fields]) => [part, Object.fromEntries(fields)])) };
}

/**
 * Spread a look into the flat record keys it is stored under.
 * @param look - The look to store.
 * @returns One prefixed key per part field.
 */
export function expandSceneLook(look: SceneLook): Record<string, unknown> {
  return Object.fromEntries(Object.entries(look).flatMap(([part, fields]) =>
    Object.entries(fields).map(([field, value]) => [`${SCENE_LOOK_KEY_PREFIX}${part}.${field}`, value])));
}

/**
 * Plain scene values shared by the collaboration projection and renderer, each checked on its own;
 * which keys a kind may or must carry is checked by {@link SceneObjectSchema}.
 */
export const SceneObjectValuesSchema = z.object({
  name: z.string().trim().min(1).max(SCENE_OBJECT_NAME_MAX),
  model: SceneModelSchema,
  position: SceneVectorSchema,
  rotation: SceneRotationSchema,
  scale: SceneScaleSchema,
  locked: z.boolean(),
  pose: ScenePoseSchema.optional(),
  look: SceneLookSchema.optional(),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  focalLength: z.number().finite().min(SCENE_FOCAL_LENGTH_MIN).max(SCENE_FOCAL_LENGTH_MAX).optional(),
  frame: z.enum(VIEWFINDER_RATIOS).optional(),
  freeRatio: z.number().finite().min(SCENE_FREE_RATIO_MIN).max(SCENE_FREE_RATIO_MAX).optional(),
  color: SceneColorSchema.optional(),
  intensity: z.number().finite().min(0).optional(),
  castShadow: z.boolean().optional(),
  angle: z.number().finite().min(SCENE_SPOT_ANGLE_MIN).max(SCENE_SPOT_ANGLE_MAX).optional(),
}).strict();

/** Keys only a camera carries. */
export const SCENE_CAMERA_KEYS = ['focalLength', 'frame', 'freeRatio'] as const;
/** Keys only a light carries; `angle` only on a spotlight. */
export const SCENE_LIGHT_KEYS = ['color', 'intensity', 'castShadow', 'angle'] as const;

/**
 * Find what breaks the keys a record's kind may and must carry.
 * @param values - Values that passed the field checks.
 * @returns The first broken rule, or null.
 */
function kindKeysIssue(values: z.infer<typeof SceneObjectValuesSchema>): string | null {
  const has = (values as Record<string, unknown>);
  const { model } = values;
  if (model.kind === 'builtin' || model.kind === 'asset') {
    return ['number', ...SCENE_CAMERA_KEYS, ...SCENE_LIGHT_KEYS].some((key) => has[key] !== undefined) ? 'A model carries no camera or light keys' : null;
  }
  if (values.number === undefined) return 'A camera or light needs a number';
  if (values.pose !== undefined) return 'A camera or light has no pose';
  if (values.look !== undefined) return 'A camera or light has no look';
  if (values.scale.some((axis) => axis !== 1)) return 'A camera or light keeps a unit scale';
  if (model.kind === 'camera') return SCENE_LIGHT_KEYS.some((key) => has[key] !== undefined) ? 'A camera carries no light keys' : null;
  if (SCENE_CAMERA_KEYS.some((key) => has[key] !== undefined)) return 'A light carries no camera keys';
  if (model.type !== 'spot' && values.angle !== undefined) return 'Only a spotlight has an angle';
  if (values.intensity !== undefined && values.intensity > SCENE_LIGHT_INTENSITY[model.type].max) return 'Intensity is above the light type maximum';
  return null;
}

/** A projected object combines its stable document key with plain values its kind allows. */
export const SceneObjectSchema = SceneObjectValuesSchema.extend({ id: z.string().uuid() }).superRefine((values, context) => {
  const message = kindKeysIssue(values);
  if (message !== null) context.addIssue({ code: z.ZodIssueCode.custom, message });
});

export type SceneVector = z.infer<typeof SceneVectorSchema>;
export type SceneRotation = z.infer<typeof SceneRotationSchema>;
export type SceneModel = z.infer<typeof SceneModelSchema>;
/** The kinds that load a model file: only these are fetched, cached and reported as loading or failed. */
export type SceneModelFile = Extract<SceneModel, { kind: 'builtin' | 'asset' }>;

/**
 * Whether a model loads a model file.
 * @param model - A record's model.
 * @returns True for a builtin or a registered asset.
 */
export function isSceneModelFile(model: SceneModel): model is SceneModelFile {
  return model.kind === 'builtin' || model.kind === 'asset';
}
export type SceneObjectValues = z.infer<typeof SceneObjectValuesSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;

/** A camera record as read, with every camera key filled in. */
export type SceneCameraObject = SceneObject & { model: { kind: 'camera' }; number: number; focalLength: number; frame: ViewfinderRatio; freeRatio: number };
/** A light record as read, with every light key of its type filled in. */
export type SceneLightObject = SceneObject & { model: { kind: 'light'; type: SceneLightType }; number: number; color: string; intensity: number; castShadow: boolean };

/**
 * Whether a read record is a camera.
 * @param object - A record from the scene projection.
 * @returns True for a camera.
 */
export function isSceneCamera(object: SceneObject): object is SceneCameraObject {
  return object.model.kind === 'camera';
}

/**
 * Whether a read record is a light.
 * @param object - A record from the scene projection.
 * @returns True for a light.
 */
export function isSceneLight(object: SceneObject): object is SceneLightObject {
  return object.model.kind === 'light';
}

/**
 * The one order of cameras and lights: by number, then by id.
 * @param a - One record.
 * @param a.number - Its number.
 * @param a.id - Its id.
 * @param b - The other.
 * @param b.number - Its number.
 * @param b.id - Its id.
 * @returns Negative, zero or positive as for `Array.prototype.sort`.
 */
export function compareDirectorRecords(a: { number: number; id: string }, b: { number: number; id: string }): number {
  return a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The number a new camera or light takes: one above the highest of its kind, 1 when there is none.
 * @param objects - The scene's records.
 * @param kind - Camera or light.
 * @returns The next number.
 */
export function nextDirectorNumber(objects: readonly SceneObject[], kind: 'camera' | 'light'): number {
  return Math.max(0, ...objects.map((object) => (object.model.kind === kind ? object.number ?? 0 : 0))) + 1;
}

/** Record keys that commands overwrite after creation; `model` is fixed at creation, and a pose and a look are stored as flat `pose.` and `look.` keys. */
export type SceneEditableField = Exclude<keyof SceneObjectValues, 'model' | 'pose' | 'look'>;

/** Configured import budgets carried by the readable Project API. */
export interface SceneImportLimits {
  maxInputBytes: number;
  maxExpandedBytes: number;
  maxArtifactBytes: number;
  maxFiles: number;
  maxEntryJsonBytes: number;
  decoderWorkerLimit: number;
  maxTextureEdge: number;
  maxTextureBytes: number;
  /** Most bytes read to learn a part picture's size from its header. */
  maxPictureHeaderBytes: number;
}

/** Configured scene controls and import budgets, served through the readable Project API. */
export interface SceneControlsConfig {
  scaleSensitivity: number;
  import: SceneImportLimits;
  /** Shortest gap between two upload-progress updates shared with the Space's members. */
  progressPublishMs: number;
  capture: SceneCaptureConfig;
  director: SceneDirectorConfig;
}

/** The director console's parameters. */
export interface SceneDirectorConfig {
  /** Shortest gap between two redraws of a monitor card, in milliseconds. */
  monitorRefreshMs: number;
  /** Most lights a scene renders and accepts. */
  maxLights: number;
  /** Pause after the last wheel step before a camera dolly is written, in milliseconds. */
  wheelCommitMs: number;
  /** Shadow map edge for directional lights and spotlights, in pixels. */
  shadowMapPx: number;
  /** Shadow map edge for point lights, in pixels. */
  pointShadowMapPx: number;
  /** How far a directional shadow may reach along the ground, in multiples of the casters' box diagonal. */
  shadowGroundReach: number;
  /** Depth and normal offsets of directional and spotlight shadows, against shadow acne. */
  shadowBias: number;
  shadowNormalBias: number;
  /** The same offsets for point light shadows. */
  pointShadowBias: number;
  pointShadowNormalBias: number;
}

/** The viewfinder's capture parameters. */
export interface SceneCaptureConfig {
  /** Long edge of a captured still, in pixels. */
  longEdgePx: number;
  /** Shortest edge the viewfinder can be dragged down to, in screen pixels. */
  minFramePx: number;
  /** How long a closed canvas may take to sync before nothing is written. */
  canvasSyncTimeoutMs: number;
}

/**
 * Identify the registered containers that carry a complete scene model.
 * @param value - A reduced MIME essence from an upload or the asset ledger.
 * @returns Whether the container is a GLB or a versioned model ZIP.
 * @throws {never} Never.
 */
export function isSceneModelMediaType(value: string): boolean {
  return value === 'model/gltf-binary' || value === 'application/zip';
}

/** Picture types a part look may use (inner#1693). */
const SCENE_LOOK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Whether a registered asset's media type is a picture a part look may use.
 * @param value - A reduced MIME essence from an upload or the asset ledger.
 * @returns Whether it is PNG, JPEG or WebP.
 * @throws {never} Never.
 */
export function isSceneLookImageMediaType(value: string): boolean {
  return (SCENE_LOOK_IMAGE_TYPES as readonly string[]).includes(value);
}

/**
 * Values read for an editable key that has no live value. Two members writing
 * the same key at once, followed by the winner's undo, leaves the key empty;
 * the object stays visible and editable, as canvas nodes do.
 * @param model - The record's model, which names the fallback.
 * @returns Defaults for every editable key.
 */
function editableDefaults(model: SceneModel): Omit<SceneObjectValues, 'model'> {
  const transform = { position: [0, 0, 0] as SceneVector, rotation: [0, 0, 0, 1] as SceneRotation, scale: [1, 1, 1] as SceneVector, locked: false };
  if (model.kind === 'camera') {
    return { ...transform, name: 'Camera', focalLength: SCENE_FOCAL_LENGTH_DEFAULT, frame: DEFAULT_VIEWFINDER_RATIO, freeRatio: 16 / 9 };
  }
  if (model.kind === 'light') {
    return { ...transform, name: 'Light', color: SCENE_LIGHT_COLOR_DEFAULT, intensity: SCENE_LIGHT_INTENSITY[model.type].initial, castShadow: true,
      ...(model.type === 'spot' ? { angle: SCENE_SPOT_ANGLE_DEFAULT } : {}) };
  }
  return { ...transform, name: model.kind === 'builtin' ? model.id : 'Model' };
}

/**
 * Read one stored object record, given as its plain flat keys, the way the editor and collab both read it.
 * @param id - Stable scene object identity.
 * @param stored - The record's keys and values.
 * @returns The validated object.
 * @throws {Error} When a look or a pose is stored whole under one key; both are stored only as flat keys.
 * @throws {z.ZodError} When the model or a stored value does not match the scene format.
 */
export function readSceneRecord(id: string, stored: Readonly<Record<string, unknown>>): SceneObject {
  if (Object.hasOwn(stored, 'look') || Object.hasOwn(stored, 'pose')) throw new Error('Look and pose are stored as flat keys');
  const model = SceneObjectValuesSchema.shape.model.parse(stored.model);
  return SceneObjectSchema.parse({ ...editableDefaults(model), ...gatherSceneLook(gatherScenePose(stored)), model, id });
}

/** What happens to a picture uploaded for a part (inner#1693 design 6.3). */
export type SceneLookPictureOutcome = 'write' | 'done' | 'objectGone' | 'partChanged' | 'partLimit';

/** Why an uploaded picture was not put on its part. */
export type SceneLookPictureRefusal = Exclude<SceneLookPictureOutcome, 'write' | 'done'>;

/** How collab settles an uploaded picture: put on its part (or already there), or why not. */
export const SCENE_LOOK_PICTURE_SETTLEMENTS = ['written', 'objectGone', 'partChanged', 'partLimit'] as const satisfies readonly ('written' | SceneLookPictureRefusal)[];

/** How collab settled an uploaded picture: put on its part (or already there), or why not. */
export type SceneLookPictureSettlement = (typeof SCENE_LOOK_PICTURE_SETTLEMENTS)[number];

/**
 * Whether an uploaded picture goes on the part the upload started from. The part may still hold the picture it held at
 * the start, or none at all (it was reset meanwhile); another picture or `'none'` there means someone chose otherwise.
 * @param input - The object as it is now, the part, its picture at the start and the uploaded picture.
 * @param input.object - The object, or undefined when the scene no longer holds a readable one.
 * @param input.part - The part key.
 * @param input.startMap - The part's `map` when the upload started, or null for none.
 * @param input.picture - The uploaded picture's asset id.
 * @returns `write`, `done` when the part already holds the picture, or why it is not written.
 */
export function judgeSceneLookPicture(input: {
  object: SceneObject | undefined; part: string; startMap: string | null; picture: string;
}): SceneLookPictureOutcome {
  const { object, part } = input;
  if (!object || object.locked || !isSceneModelFile(object.model)) return 'objectGone';
  const look = object.look ?? {};
  const held = Object.prototype.hasOwnProperty.call(look, part);
  const now = held ? look[part]?.map : undefined;
  if (now === input.picture) return 'done';
  if (now !== undefined && now !== input.startMap) return 'partChanged';
  if (!held && Object.keys(look).length >= SCENE_LOOK_MAX_PARTS) return 'partLimit';
  return 'write';
}
