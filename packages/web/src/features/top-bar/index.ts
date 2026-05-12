/**
 * Top bar feature — full-width header chrome on the project page.
 *
 * Layout matches `design/project/mocks/05-canvas-native-tailwind.html`
 * @1083-1115. The bar composes:
 *
 *   Left cluster
 *   ────────────
 *   - `Logo`                — breatic v4 mark
 *   - `BackToWorkspaceLink` — `< Workspace`
 *   - `/` separator
 *   - `ProjectTitle`        — editable, surfaces autosave time
 *   - `RoleBadge`           — owner / edit / view pill
 *
 *   Right cluster
 *   ─────────────
 *   - `MembersPopover` (features/members)
 *   - `LangPicker`
 *   - `ThemePicker`
 *   - `CreditsPill` (features/credits)
 *   - `ExportPicker`        — workflow import / export
 *   - `SharePopover`        — share / invite (V1 shell; copies URL)
 *   - `NotificationsBell`   — visual placeholder for PR-Y3 (#134)
 *   - `UserCenter`          — account dropdown
 *
 * Each piece lives in its own file so a swap-out (e.g. PR-Y3 wires
 * `NotificationsBell` to `meta.systemMessages`) touches one component.
 */

export { default as TopBar } from './components/TopBar';
export type { TopBarProps } from './components/TopBar';
