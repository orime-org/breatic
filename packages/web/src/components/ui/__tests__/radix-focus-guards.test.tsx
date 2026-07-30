// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

// Radix puts a focus guard at each end of the document while an overlay is
// open, so Tab from the last element inside wraps back in rather than
// escaping to the browser chrome. Those guards carry tabindex="0" — they
// have to, that is how they catch the focus.
//
// Opening an overlay also hides everything else from assistive technology,
// which is correct, except that it swept the guards up with everything
// else. A focusable element marked aria-hidden is a WCAG 2.1.1 Level A
// violation: a keyboard user lands on it and a screen reader says nothing.
//
// Upstream has the fix — radix-ui/primitives#3822, still unmerged — and we
// carry it as a patch (see patches/). These tests are what tells us the
// patch is still doing its job: bump Radix and have the patch silently
// stop applying, and they go red here instead of shipping a regression.
// When the fix is released upstream, the patch goes away and these stay.

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@web/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';

/**
 * Asserts every focus guard in the document is reachable by assistive tech.
 *
 * A guard is focusable by design, so it must not also be hidden — the two
 * together are the violation.
 */
function expectGuardsNotHidden(): void {
  const guards = document.querySelectorAll('[data-radix-focus-guard]');
  expect(guards.length).toBeGreaterThan(0);
  guards.forEach((guard) => {
    expect(guard).not.toHaveAttribute('aria-hidden', 'true');
  });
}

describe('Radix focus guards stay visible to assistive technology', () => {
  it('a dialog does not hide them', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByText('Title')).toBeInTheDocument());
    expectGuardsNotHidden();
  });

  it('a popover does not hide them', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByText('Body')).toBeInTheDocument());
    expectGuardsNotHidden();
  });

  it('a dropdown menu does not hide them', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByText('Item')).toBeInTheDocument());
    expectGuardsNotHidden();
  });
});
