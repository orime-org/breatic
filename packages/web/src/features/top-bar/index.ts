/**
 * Top bar feature — full-width header chrome on the project page.
 *
 * Composes the legacy `ProjectHeader` (logo + project title +
 * import/export menu) with the v10 collaboration widgets
 * (`MembersPopover` from `features/members`, `CreditsPill` from
 * `features/credits`, the `UserCenter` account dropdown).
 *
 * Replaces the temporary PR4-A overlay (absolute-positioned right-top
 * pills above the canvas) and the in-chat-panel-header placement of
 * ProjectHeader.
 */

export { default as TopBar } from './components/TopBar';
export type { TopBarProps } from './components/TopBar';
