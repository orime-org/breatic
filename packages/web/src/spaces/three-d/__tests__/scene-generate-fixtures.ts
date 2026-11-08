// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D catalog as `GET /models` answers it (inner#1691 design 2.1 to 2.4),
 * in its wire shape so the dialog reads it through `sanitizeModelCatalog`.
 * Prices are the design's table at one credit per US cent.
 */

const PROJECT = 'project-1';
const SPACE = 'space-1';

/** A switch the panel draws. */
const toggle = (label: string, value: boolean, when?: Record<string, unknown>): Record<string, unknown> => ({
  description: label, fill: 'panel', label, values: [true, false], default: value, ...(when === undefined ? {} : { when }),
});

/** A row of options the panel draws. */
const choice = (label: string, values: string[], value: string, valueLabels: Record<string, string>, when?: Record<string, unknown>): Record<string, unknown> => ({
  description: label, fill: 'panel', label, values, default: value, value_labels: valueLabels, ...(when === undefined ? {} : { when }),
});

/** A whole number the user may leave blank. */
const integer = (label: string, min: number, max: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  description: label, fill: 'panel', label, type: 'integer', min, max, default: null, ...extra,
});

const TEXTURED = { flag_on: 'texture' };

/** What all three entries declare (design 2.3, the dialog's top section). */
const COMMON: Record<string, Record<string, unknown>> = {
  texture: toggle('Texture', true),
  pbr: toggle('PBR', true),
  texture_quality: choice('Texture quality', ['standard', 'fast', 'detailed'], 'standard',
    { standard: 'Standard', fast: 'Fast', detailed: 'Detailed' }, TEXTURED),
  texture_version: choice('Texture version', ['v3.0', 'v3.5'], 'v3.0', { 'v3.0': 'v3.0', 'v3.5': 'v3.5' }, TEXTURED),
  delight: toggle('Remove lighting', true, { flag_on: 'texture', equals: { texture_version: 'v3.5' } }),
  geometry_quality: choice('Geometry quality', ['standard', 'detailed'], 'standard', { standard: 'Standard', detailed: 'Detailed' }),
  smart_low_poly: toggle('Smart low-poly', false),
  generate_parts: toggle('Separate parts', false),
  face_limit: integer('Face limit', 1, 1_500_000, {
    bounds: [{ when: { flag_on: 'smart_low_poly' }, min: 500, max: 20_000 }, { when: { equals: { geometry_quality: 'detailed' } }, max: 2_000_000 }],
  }),
  auto_size: toggle('Auto size', false, TEXTURED),
  export_uv: toggle('Export UV', true),
  model_seed: integer('Model seed', 0, 2_147_483_647),
  texture_seed: integer('Texture seed', 0, 2_147_483_647),
};

/** What only the image entries declare (design 2.3, the dialog's middle section). */
const IMAGE_ONLY: Record<string, Record<string, unknown>> = {
  texture_alignment: choice('Texture alignment', ['original_image', 'geometry'], 'original_image', { original_image: 'Original image', geometry: 'Geometry' }),
  orientation: choice('Orientation', ['default', 'align_image'], 'default', { default: 'Default', align_image: 'Align image' }, TEXTURED),
  enable_image_autofix: toggle('Image autofix', false),
};

/** The three forced values, in their declared order (design 2.3). */
const FORCES = [
  { id: 'parts_geometry_only', when: { flag_on: 'generate_parts' }, set: { texture: false, pbr: false }, lock: true },
  { id: 'pbr_needs_texture', when: { flag_on: 'pbr' }, set: { texture: true }, lock: true },
  { id: 'fast_uses_v35', when: { flag_on: 'texture', equals: { texture_quality: 'fast' } }, set: { texture_version: 'v3.5' }, lock: true },
];

/**
 * A price formula following the design 2.4 table, in millionths of a US dollar.
 * @param geometry - The geometry-only base.
 * @param standard - The Standard or Fast texture base.
 * @param detailed - The Detailed texture base.
 * @param extreme - The Extreme texture base.
 * @returns The JSONata formula.
 */
function formula(geometry: number, standard: number, detailed: number, extreme: number): string {
  return `{"total_price": ((generate_parts or texture = false) ? ${geometry} : (texture_quality = "detailed" ? ${detailed} : (texture_quality = "extreme" ? ${extreme} : ${standard})))`
    + ' + (geometry_quality = "detailed" ? 240000 : 0) + (smart_low_poly ? 120000 : 0) + (generate_parts ? 240000 : 0)}';
}

/**
 * One entry as the server sends it.
 * @param over - What differs per entry.
 * @returns The raw entry.
 */
function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    display_name: 'Tripo H3.1', modality: 'three_d', description: '', guide: '', tier: 'recommended', generation_time: 120,
    providers: [{ name: 'wavespeed', model_id: 'x', priority: 1, available: true }], forces: FORCES, ...over,
  };
}

export const T23D = 'tripo-h3.1-t23d';
export const I23D = 'tripo-h3.1-i23d';
export const MULTIVIEW = 'tripo-h3.1-multiview';

/** `GET /models` with only the 3D bucket filled. */
export const RAW_CATALOG = {
  image: [], video: [], audio: [], tts: [], total: 3, credit_multiplier: 1,
  three_d: [
    entry({
      name: T23D, mode: 't23d', takes_prompt: true, prompt_max_length: 1024,
      params: { ...COMMON, negative_prompt: { description: 'Negative prompt', fill: 'panel', label: 'Negative prompt', type: 'text', max_length: 255, default: '' } },
      pricing: { base_price: 240_000, formula: formula(120_000, 240_000, 360_000, 480_000), discount_rate: 100 },
    }),
    entry({
      name: I23D, variant: 'Single image', mode: 'i23d', takes_prompt: false,
      params: { ...COMMON, ...IMAGE_ONLY, image: { description: 'Front view', fill: 'canvas', accepts: 'image', default: null } },
      pricing: { base_price: 360_000, formula: formula(240_000, 360_000, 480_000, 600_000), discount_rate: 100 },
    }),
    entry({
      name: MULTIVIEW, variant: 'Multi-view', mode: 'i23d', takes_prompt: false,
      params: { ...COMMON, ...IMAGE_ONLY, images: { description: 'Views', fill: 'canvas', accepts: 'image', type: 'list', min_items: 2, max_items: 4, default: [] } },
      pricing: { base_price: 360_000, formula: formula(240_000, 360_000, 480_000, 600_000), discount_rate: 100 },
    }),
  ],
};

/** One Project image as `GET /projects/:projectId/assets?kind=image` lists it. */
export interface ProjectImage {
  assetId: string;
  projectReferenceId: string;
  displayName: string | null;
  kind: 'image';
  fileUrl: string;
  coverUrl: string | null;
  width: number;
  height: number;
  durationSeconds: null;
  mimeType: string;
  sizeBytes: number;
}

/**
 * A registered Project image.
 * @param assetId - Its asset id.
 * @param displayName - Its name in the Project.
 * @returns The listed image.
 */
export function projectImage(assetId: string, displayName: string | null = `${assetId}.png`): ProjectImage {
  return {
    assetId, projectReferenceId: `ref-${assetId}`, displayName, kind: 'image', fileUrl: `https://cdn.test/${assetId}.png`,
    coverUrl: null, width: 512, height: 512, durationSeconds: null, mimeType: 'image/png', sizeBytes: 1024,
  };
}

export { PROJECT, SPACE };

/**
 * The name a choice's value shows under, as the image entry declares it.
 * @param param - The setting.
 * @param value - The value.
 * @returns Its name on screen.
 */
export function valueLabel(param: string, value: string): string {
  const declared = (RAW_CATALOG.three_d[1]!.params as Record<string, { value_labels?: Record<string, string> }>)[param];
  const label = declared?.value_labels?.[value];
  if (label === undefined) throw new Error(`no label for ${param}=${value}`);
  return label;
}

/** The footer pill's name for each way to generate. */
export const MODE_LABEL = { t23d: 'Text to 3D', i23d: 'Image to 3D' } as const;
