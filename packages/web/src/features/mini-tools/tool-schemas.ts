/**
 * Tool schemas — per-modality lists fed to {@link NodeFloatMenu}
 * and {@link BottomToolbar}. Mirrors the server-side discriminated
 * unions in `packages/server/src/routes/schemas.ts` so a frontend
 * row with no backing server tool produces a 4xx on Apply.
 *
 * F4-framework ships only the **Category B image tools** the server
 * already supports. Category A (instant, frontend) — crop / adjust /
 * filter — and the video/audio tool rosters land in F4-categoryA.
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
  {
    id: 'sharpen',
    modality: 'image',
    category: 'B',
    menuLabel: '锐化',
    title: 'Sharpen',
    params: [
      {
        id: 'sharpen_strength',
        type: 'number',
        ui: 'slider',
        min: 0,
        max: 100,
        default: 0,
        label: '锐化强度',
      },
      {
        id: 'denoise_strength',
        type: 'number',
        ui: 'slider',
        min: 0,
        max: 100,
        default: 0,
        label: '降噪强度',
      },
    ],
  },
  {
    id: 'denoise',
    modality: 'image',
    category: 'B',
    menuLabel: '降噪',
    title: 'Denoise',
    params: [
      {
        id: 'denoise',
        type: 'number',
        ui: 'slider',
        min: 0,
        max: 100,
        default: 0,
        label: '降噪',
      },
      {
        id: 'detail',
        type: 'number',
        ui: 'slider',
        min: 0,
        max: 100,
        default: 0,
        label: '细节保留',
      },
      {
        id: 'face_enhancement',
        type: 'boolean',
        ui: 'toggle',
        default: true,
        label: '面部增强',
      },
    ],
  },
  {
    id: 'restore',
    modality: 'image',
    category: 'B',
    menuLabel: '修复',
    title: 'Restore',
    params: [
      {
        id: 'restore_model',
        type: 'enum',
        ui: 'select',
        options: ['Dust-Scratch', 'CGI', 'Mosaic', 'Robust'],
        default: 'Dust-Scratch',
        label: '修复模式',
      },
    ],
  },
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
