/**
 * Category A image-op dispatcher.
 *
 * Each Category A tool exports one async transform — given a source
 * `Blob` + a `values` record matching its schema params, return a new
 * `Blob` to upload as the sibling node's `content`. This module
 * routes by `toolId` so the canvas-side `handleMiniToolApply` can
 * stay agnostic to which specific tool is running.
 */
import { applyAdjust, type AdjustParams } from './adjust';
import { applyFilter, type FilterParams, type FilterPreset } from './filter';
import { applyBgBlur, type BgBlurParams } from './bg-blur';

const FILTER_PRESETS: ReadonlySet<FilterPreset> = new Set([
  'none',
  'mono',
  'sepia',
  'film',
  'cool',
  'warm',
]);

/**
 * Run the Category A op matching `toolId`. Throws when `toolId` isn't
 * a known Category A tool — the caller should have already filtered
 * to Category A via `schema.category === 'A'`, so reaching the default
 * arm is a developer bug, not a runtime user error.
 *
 * @param toolId - Matches a row in `IMAGE_TOOLS` with `category: 'A'`.
 * @param source - Source image blob (fetched from node `data.content`).
 * @param values - Slider / select / toggle values from BottomToolbar.
 * @returns A new image blob — same modality as the source. The caller
 *   uploads it through `uploadOne` and writes the URL to the sibling
 *   node's `data.content`.
 */
export async function runCategoryAOp(
  toolId: string,
  source: Blob,
  values: Record<string, unknown>,
): Promise<Blob> {
  switch (toolId) {
    case 'adjust': {
      const params: AdjustParams = {
        brightness: numberOr(values.brightness, 0),
        contrast: numberOr(values.contrast, 0),
        saturation: numberOr(values.saturation, 0),
      };
      return applyAdjust(source, params);
    }
    case 'filter': {
      const params: FilterParams = {
        preset: presetOr(values.preset, 'none'),
        intensity: numberOr(values.intensity, 50),
      };
      return applyFilter(source, params);
    }
    case 'bg-blur': {
      const params: BgBlurParams = {
        radius: numberOr(values.radius, 50),
        preserveSubject: booleanOr(values.preserveSubject, true),
      };
      return applyBgBlur(source, params);
    }
    // crop lands in follow-up PR.
    default:
      throw new Error(`Category A op not implemented: ${toolId}`);
  }
}

function booleanOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Coerce an unknown to a known `FilterPreset`; fall back if invalid. */
function presetOr(v: unknown, fallback: FilterPreset): FilterPreset {
  return typeof v === 'string' && FILTER_PRESETS.has(v as FilterPreset)
    ? (v as FilterPreset)
    : fallback;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export { applyAdjust, applyAdjustInPlace } from './adjust';
export type { AdjustParams } from './adjust';
export { applyFilter, applyFilterInPlace } from './filter';
export type { FilterParams, FilterPreset } from './filter';
export { applyBgBlur, applyBgBlurInPlace } from './bg-blur';
export type { BgBlurParams } from './bg-blur';
