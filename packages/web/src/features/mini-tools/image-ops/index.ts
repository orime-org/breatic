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
    // filter / bg-blur / crop land in follow-up PRs.
    default:
      throw new Error(`Category A op not implemented: ${toolId}`);
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export { applyAdjust, applyAdjustInPlace } from './adjust';
export type { AdjustParams } from './adjust';
