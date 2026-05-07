/**
 * Members feature — top-bar avatar stack + management panel.
 *
 * Single entry point. Other features import the popover / panel from
 * here, never reaching into `./components/*`.
 */
export { default as MembersPopover } from './components/MembersPopover';
export type { MembersPopoverProps } from './components/MembersPopover';
export { default as MembersPanel } from './components/MembersPanel';
export type { MembersPanelProps } from './components/MembersPanel';
