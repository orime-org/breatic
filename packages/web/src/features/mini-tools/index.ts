/**
 * `features/mini-tools` — schema-driven NodeFloatMenu + BottomToolbar
 * for asset-node mini-tools (spec mockup
 * `2026-04-27-visual-language/05-canvas-native-tailwind.html`).
 *
 * F4-framework ships:
 *   - The state context + hook
 *   - The two UI surfaces (float menu + bottom toolbar)
 *   - The image-tool schemas matching server `imageToolSchema`
 *
 * F4-categoryA will land:
 *   - Category A (frontend) implementations (crop / adjust / filter)
 *   - Video + audio tool rosters
 *   - The `category: 'special'` widget for inpaint
 *
 * Public API:
 */
export { MiniToolProvider, useMiniTool } from './MiniToolContext';
export { BottomToolbar } from './BottomToolbar';
export { NodeFloatMenu } from './NodeFloatMenu';
export { IMAGE_TOOLS, findToolSchema, defaultValues } from './tool-schemas';
export type { ToolSchema, ToolCategory, ParamConfig } from './types';
