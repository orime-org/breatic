/**
 * spaces/_shell — chrome around the active Space (Tab Bar +
 * NewSpaceDialog + dispatch to canvas/document/timeline).
 *
 * Only `SpaceShell` is meant to be imported by the page layer.
 * The smaller components are exposed too so a future Drawer or
 * keyboard-shortcut handler can compose them, but most callers
 * should stop at SpaceShell.
 */

export { default as SpaceShell } from './SpaceShell';
export type { SpaceShellProps } from './SpaceShell';

// Sub-components — exposed for composition by future shell features.
export { default as TabBar } from './TabBar';
export type { TabBarProps } from './TabBar';
export { default as CanvasTab } from './CanvasTab';
export type { CanvasTabProps } from './CanvasTab';
export { default as NewSpaceDialog } from './NewSpaceDialog';
export type { NewSpaceDialogProps } from './NewSpaceDialog';
export { default as PlaceholderSpace } from './PlaceholderSpace';
export type { PlaceholderSpaceProps } from './PlaceholderSpace';
