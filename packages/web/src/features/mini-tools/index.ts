/**
 * `features/mini-tools` — schema-driven NodeFloatMenu + BottomToolbar
 * for asset-node mini-tools (spec mockup
 * `2026-04-27-visual-language/05-canvas-native-tailwind.html`).
 *
 * F4-framework shipped:
 *   - The state context + hook
 *   - The two UI surfaces (float menu + bottom toolbar)
 *   - The image-tool schemas matching server `imageToolSchema`
 *
 * F4-categoryA is landing incrementally — V1 ships image tools only
 * (spec `02-mini-tool-system.md` §3.1 defers video / audio mini-tools
 * to V2). One Category A tool per PR:
 *   - adjust  (brightness / contrast / saturation)
 *   - filter  (preset enum + intensity)
 *   - bg-blur (radius slider + preserveSubject toggle)
 *   - crop    (interactive rect overlay — category: 'special')
 *
 * Public API:
 */
export { MiniToolProvider, useMiniTool } from './MiniToolContext';
export { BottomToolbar } from './BottomToolbar';
export { NodeFloatMenu } from './NodeFloatMenu';
export { IMAGE_TOOLS, findToolSchema, defaultValues } from './tool-schemas';
export type { ToolSchema, ToolCategory, ParamConfig } from './types';
export {
  runCategoryAOp,
  applyAdjust,
  applyAdjustInPlace,
  applyFilter,
  applyFilterInPlace,
  applyBgBlur,
  applyBgBlurInPlace,
  applyCrop,
  resolveSourceRect,
} from './image-ops';
export type {
  AdjustParams,
  FilterParams,
  FilterPreset,
  BgBlurParams,
  CropParams,
} from './image-ops';
export { CropOverlay } from './crop-overlay';
