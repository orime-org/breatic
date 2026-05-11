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
 *   - adjust  (this PR — brightness / contrast / saturation)
 *   - filter  (next — preset enum + intensity)
 *   - bg-blur (next — radius slider + preserveSubject toggle)
 *   - crop    (next — corner-handle rect + rotate)
 *
 * Public API:
 */
export { MiniToolProvider, useMiniTool } from './MiniToolContext';
export { BottomToolbar } from './BottomToolbar';
export { NodeFloatMenu } from './NodeFloatMenu';
export { IMAGE_TOOLS, findToolSchema, defaultValues } from './tool-schemas';
export type { ToolSchema, ToolCategory, ParamConfig } from './types';
export { runCategoryAOp, applyAdjust, applyAdjustInPlace } from './image-ops';
export type { AdjustParams } from './image-ops';
