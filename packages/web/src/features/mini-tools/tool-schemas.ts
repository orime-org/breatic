/**
 * Tool schemas — per-modality lists fed to {@link NodeFloatMenu}
 * and {@link BottomToolbar}. Mirrors the server-side discriminated
 * unions in `packages/server/src/routes/schemas.ts` so a frontend
 * row with no backing server tool produces a 4xx on Apply.
 *
 * Category A (instant, frontend, no credits) — adjust / filter /
 * bg-blur / crop — ships in PR-A..PR-E (2026-05-11).
 * Video/audio tool rosters land in a later follow-up.
 *
 * Adding a new tool: add a row here. The framework picks it up; the
 * only UI work needed is when the tool wants a `category: 'special'`
 * custom widget (out of F4-framework scope).
 */
import type { ToolSchema } from './types';

/**
 * Image tools surfaced on `ImageNode`'s float menu in F4-framework.
 *
 * Field-by-field cross-reference to `imageToolSchema` rows in
 * `packages/server/src/routes/schemas.ts`. Default values match the
 * server defaults so an unmodified `Apply` results in the same task
 * params the server would have inferred.
 */
export const IMAGE_TOOLS: ReadonlyArray<ToolSchema> = [
  // ── Category A (frontend, instant — no backend round-trip) ───────────
  {
    id: 'adjust',
    modality: 'image',
    category: 'A',
    menuLabel: '调色',
    title: 'Adjust',
    params: [
      {
        id: 'brightness',
        type: 'number',
        ui: 'slider',
        min: -50,
        max: 50,
        default: 0,
        label: '亮度',
      },
      {
        id: 'contrast',
        type: 'number',
        ui: 'slider',
        min: -50,
        max: 50,
        default: 0,
        label: '对比度',
      },
      {
        id: 'saturation',
        type: 'number',
        ui: 'slider',
        min: -50,
        max: 50,
        default: 0,
        label: '饱和度',
      },
    ],
  },
  {
    id: 'filter',
    modality: 'image',
    category: 'A',
    menuLabel: '滤镜',
    title: 'Filter',
    params: [
      {
        id: 'preset',
        type: 'enum',
        ui: 'select',
        options: ['none', 'mono', 'sepia', 'film', 'cool', 'warm'],
        default: 'none',
        label: '风格',
      },
      {
        id: 'intensity',
        type: 'number',
        ui: 'slider',
        min: 0,
        max: 100,
        default: 50,
        label: '强度',
      },
    ],
  },
  {
    id: 'bg-blur',
    modality: 'image',
    category: 'A',
    menuLabel: '虚化',
    title: 'Background Blur',
    params: [
      {
        id: 'radius',
        type: 'number',
        ui: 'slider',
        min: 0,
        max: 100,
        default: 50,
        label: '强度',
      },
      {
        id: 'preserveSubject',
        type: 'boolean',
        ui: 'toggle',
        default: true,
        label: '保留主体',
      },
    ],
  },
  {
    // Crop's input doesn't fit slider/select/toggle — the user drags a
    // rect overlay on the source image. `category: 'special'` tells the
    // BottomToolbar to render a hint + Apply/Cancel only, and the
    // `CropOverlay` (mounted on the active source image node) publishes
    // the chosen rect to `MiniToolContext.specialValues` so Apply can
    // pick it up. The rect is normalized {x, y, width, height} in [0,1].
    id: 'crop',
    modality: 'image',
    category: 'special',
    menuLabel: '裁剪',
    title: 'Crop',
    params: [],
  },
  // ── Category B (backend AIGC — credits, ≥1 s) ────────────────────────
  {
    id: 'remove-bg',
    modality: 'image',
    category: 'B',
    menuLabel: '抠图',
    title: 'Remove Background',
    params: [],
  },
  {
    id: 'upscale',
    modality: 'image',
    category: 'B',
    menuLabel: '放大',
    title: 'Upscale',
    params: [
      {
        id: 'output_resolution',
        type: 'enum',
        ui: 'select',
        options: ['2k', '4k'],
        default: '2k',
        label: '分辨率',
      },
    ],
  },
  // Per `design/project/02-mini-tool-system.md` §2.2 V1 ships **3** Category B
  // image tools: remove-bg / upscale / inpaint. sharpen / denoise / restore
  // were stubbed during F4-framework when the schema was bigger; B5 removes
  // them to bring the menu in line with the spec. inpaint will land as a
  // future PR once its overlay-driven param UI is designed.
] as const;

/** Look up a tool by id across every modality. Returns null when unknown. */
export function findToolSchema(toolId: string): ToolSchema | null {
  // V1 ships image tools only — spec `02-mini-tool-system.md` §3.1 defers
  // video / audio mini-tools to V2. The schema's `modality` field still
  // exists so the framework is ready when V2 lands.
  return IMAGE_TOOLS.find((t) => t.id === toolId) ?? null;
}

/**
 * Build a default `values` map from a tool's params. Used as the
 * initial `MiniToolState.values` when the user picks a tool in the
 * float menu.
 */
export function defaultValues(schema: ToolSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of schema.params) {
    out[p.id] = p.default;
  }
  return out;
}
