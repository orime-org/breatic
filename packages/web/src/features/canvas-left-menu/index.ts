/**
 * `features/canvas-left-menu` — the LeftFloatingMenu (6 items) +
 * NodesLibraryPanel surface from spec/02 §4.3 v13.
 *
 * Public API:
 *   - {@link LeftFloatingMenu} — top-level menu (mounted by the
 *     project canvas; visibility gated outside on the user's role)
 *   - {@link NodesLibraryPanel} — exported separately so a future
 *     command palette / ⌘K search could open the same panel from
 *     a different anchor without the menu shell
 *   - {@link GenerativeOutputType} — convenience re-export for callers
 *     that need to type the `onCreateGenerative` callback
 */
export { LeftFloatingMenu } from './LeftFloatingMenu';
export { NodesLibraryPanel, type GenerativeOutputType } from './NodesLibraryPanel';
