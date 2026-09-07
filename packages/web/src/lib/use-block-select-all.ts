// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { isEditableTarget } from '@web/lib/is-editable-target';

/**
 * Swallows select-all everywhere a caret cannot land (user 2026-08-26).
 *
 * Left to the browser, Ctrl/Cmd+A on the page selects the whole document —
 * every label, every button caption, the chat and the canvas chrome at once —
 * and nothing here acts on such a selection. A field selects its own content,
 * and the document space runs its own two-tier select-all and marks the event
 * handled before this sees it; both are let through. Everything else is
 * swallowed, overlays included: not answering there is the same as letting the
 * browser select the entire page.
 *
 * The gate is not about which region is active — it answers "can a caret land
 * here", which is true or false regardless.
 *
 * Mounted by the project page, so it comes off with it: select-all on the
 * studio routes and the login page is untouched.
 */
export function useBlockSelectAll(): void {
  React.useEffect(() => {
    /**
     * Swallows a select-all press that has nowhere sensible to act.
     * @param event - A keydown, caught while it bubbles to the document.
     */
    const swallow = (event: KeyboardEvent): void => {
      // The browser runs select-all off the key's position, so a layout that
      // sends another letter from the A key — Russian sends 'ф' — reaches it
      // too. `code` names the position.
      if (event.key.toLowerCase() !== 'a' && event.code !== 'KeyA') return;
      if (!event.metaKey && !event.ctrlKey) return;
      // Cmd+Shift+A and Option+Cmd+A are other shortcuts, not this one.
      if (event.shiftKey || event.altKey) return;
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target instanceof Element ? event.target : null)) {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener('keydown', swallow);
    return () => document.removeEventListener('keydown', swallow);
  }, []);
}
