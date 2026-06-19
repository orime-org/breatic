// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure studio access rules (DD §5.2 / §5.3) — the source of truth for the two
 * critical-path frontend invariants (spec §4): which item cards a viewer may
 * see (visibility filter) and which governance actions they may take. Kept
 * free of React so they can be exhaustively matrix-tested.
 */

import type {
  ItemRole,
  ItemVisibility,
  StudioRole,
} from '@web/pages/studio/shared/studio-types';

/** The access-relevant facts about a project / collection card. */
export interface ItemAccess {
  visibility: ItemVisibility;
  /** The viewer's role on the item, or `null` for studio baseline-only access. */
  myRole: ItemRole | null;
}

/**
 * Whether a project / collection card should render for the viewer
 * (spec §4 invariant 1). Studio-visible items are baseline-visible to every
 * studio member; private items render only for studio Admins or for members
 * who actually have a role on them (owner / invited). A plain Guest never
 * sees a private item they are not part of, and a non-member (`null` studio
 * role —
 * a non-member viewing the public shell, decision A) sees only studio-visible
 * items.
 * @param studioRole the viewer's studio-level role, or `null` for a non-member.
 * @param item the item's visibility + the viewer's role on it.
 * @returns whether the card should be rendered.
 */
export function canRenderItemCard(
  studioRole: StudioRole | null,
  item: ItemAccess,
): boolean {
  if (item.visibility === 'studio') {
    return true;
  }
  return studioRole === 'admin' || item.myRole !== null;
}

/**
 * Whether the viewer may run governance actions (delete / transfer / change
 * visibility) on an item (spec §4 invariant 2). Only the item Owner or a
 * studio Admin may; a non-owner Guest and a non-member (`null` studio role) never
 * see governance controls.
 * @param studioRole the viewer's studio-level role, or `null` for a non-member.
 * @param isOwner whether the viewer owns the item.
 * @returns whether governance controls should be shown.
 */
export function canManageItem(
  studioRole: StudioRole | null,
  isOwner: boolean,
): boolean {
  return isOwner || studioRole === 'admin';
}

/**
 * Whether the viewer may create projects in a studio (spec §0.2 / §8.2): only
 * an `admin` or `maintainer` may — a plain `guest` role and a non-member
 * (`null` studio role) may not, because studio credits are shared and creating a project can
 * spend them. Gates the create entry in the rail (§4.1) and the Projects tab
 * (§7.1); the server re-checks the same rule on create (`requireStudioCreate
 * Access`), so this is a UX gate, not the security boundary.
 * @param studioRole the viewer's studio-level role, or `null` for a non-member.
 * @returns whether the viewer may create in the studio.
 */
export function canCreateInStudio(studioRole: StudioRole | null): boolean {
  return studioRole === 'admin' || studioRole === 'maintainer';
}

/**
 * The viewer's effective role on an item — their explicit role, or the studio
 * baseline viewer role when they only have baseline access (DD §5.3).
 * @param myRole the viewer's explicit role, or `null` for baseline access.
 * @returns the effective role to display.
 */
export function effectiveItemRole(myRole: ItemRole | null): ItemRole {
  return myRole ?? 'viewer';
}
