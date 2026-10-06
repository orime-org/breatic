// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { SpaceReadOnlyNotice } from '@web/pages/project/SpaceReadOnlyNotice';
import type { ProjectRole, SpaceType } from '@breatic/shared';

import { useFocusReturn, type FocusReturn } from '@web/lib/use-focus-return';
import { SPACE_TYPES } from '@web/spaces';

interface SpaceOutletProps {
  projectId: string;
  spaceId: string;
  type: SpaceType;
  /**
   * Read-only mode for the current user (viewer role). Goes to BOTH the body,
   * which gates editing on it, and the notice, which stays quiet on it.
   */
  readOnly?: boolean;
  /**
   * The current user's role on the project. Goes to the body only: the notice
   * asks whether this person may write at all, which `readOnly` answers.
   */
  myRole?: ProjectRole;
}

/**
 * Renders one Space: its registered body, plus the read-only notice that
 * belongs to every Space type alike.
 *
 * The body comes from the `SPACE_TYPES` registry; the notice reads the
 * connection `OpenSpace` holds, which a type needs a `DOC_NAME_BUILDERS`
 * entry to have.
 * @param root0 - The component props.
 * @param root0.projectId - The id of the project the Space belongs to.
 * @param root0.spaceId - The id of the Space to render.
 * @param root0.type - The Space type used to resolve the body component.
 * @param root0.readOnly - Read-only mode for the current user; goes to the body and the notice.
 * @param root0.myRole - The current user's role on the project; goes to the body.
 * @returns The Space body and its notice, or an error message for an unknown type.
 */
export function SpaceOutlet({
  projectId,
  spaceId,
  type,
  readOnly,
  myRole,
}: SpaceOutletProps): React.JSX.Element {
  // Hidden by a switch of Space and shown again, the caret goes back into the
  // last element focused in this Space if it was still there on hide
  // (inner#1235 A19). React's focus events pass through portals, so a box in
  // a popover is recorded too.
  // The focus does not scroll: the reader may have scrolled the element out of
  // view before leaving, and comes back to the page where it was left.
  const lastFocused = React.useRef<HTMLElement | null>(null);
  const [focusReturn] = React.useState<FocusReturn>(() => ({
    hadFocus: false,
    returning: false,
  }));
  useFocusReturn(
    focusReturn,
    () => lastFocused.current !== null && document.activeElement === lastFocused.current,
    () => lastFocused.current?.focus({ preventScroll: true }),
  );
  // Hidden, the Space lets go of words left selected in it: the page has one
  // selection, and its copy and paste would keep reading words the reader can
  // no longer see (inner#1235 A5). A passive cleanup runs once the Space is
  // display:none, after the layout cleanups above have read the caret; an
  // editor shown again puts its own selection back when it takes focus.
  React.useEffect(
    () => () => {
      const selection = document.getSelection();
      const anchor = selection?.anchorNode ?? null;
      const at = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
      if (at !== null && !(at.checkVisibility?.() ?? true)) selection?.removeAllRanges();
    },
    [],
  );
  const def = SPACE_TYPES[type];
  if (!def) {
    return (
      <div
        data-testid='space-outlet-unknown'
        className='flex h-full w-full items-center justify-center text-sm text-status-error-foreground'
      >
        Unknown space type: {type}
      </div>
    );
  }
  const Body = def.bodyComponent;
  // The read-only notice is anchored INSIDE the Space, so the wrapper owns the
  // positioning context. It sits here rather than in each Space body because
  // whether a connection may write is decided per document and every type has
  // to answer for its own — one place, and each type's body stays out of it.
  //
  // `readOnly` goes to BOTH: the body uses it to gate editing, and the notice
  // uses it to stay quiet for a viewer, whose read-only is their role rather
  // than something the server took away.
  return (
    <div
      className='relative h-full w-full'
      data-space-outlet={spaceId}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) lastFocused.current = event.target;
      }}
    >
      <SpaceReadOnlyNotice readOnly={readOnly} />
      <Body
        projectId={projectId}
        spaceId={spaceId}
        readOnly={readOnly}
        myRole={myRole}
      />
    </div>
  );
}
