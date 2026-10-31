// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { SceneRightPanel } from '@web/spaces/three-d/SceneRightPanel';
import { useUIStore } from '@web/stores/ui';

function PanelExample(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const stage = React.useRef<HTMLDivElement>(null);
  const opener = React.useRef<HTMLButtonElement>(null);
  const content = React.useRef<HTMLDivElement>(null);
  const automatic = React.useRef(false);
  return <TooltipProvider>
    <input aria-label='External field' autoComplete='off' />
    <div data-testid='outside-surface'>Outside surface</div>
    <div ref={stage}>
      <canvas tabIndex={0} />
      <Button ref={opener} onClick={() => setOpen(true)}>Open inspector</Button>
      <SceneRightPanel open={open} onOpenChange={setOpen} title='Inspector' automatic={automatic} stage={stage}
        returnTarget={opener} contentRef={content} cancelGesture={() => false}>
        <input aria-label='Object name' autoComplete='off' />
      </SceneRightPanel>
    </div>
  </TooltipProvider>;
}

afterEach(() => { cleanup(); useUIStore.getState().setActiveOverlayId(null); });

describe('scene panel focus handoff (inner#1705)', () => {
  it('keeps the outside field focused when a pointer dismisses the inspector', async () => {
    const user = userEvent.setup(); render(<PanelExample />);
    await user.click(screen.getByRole('button', { name: 'Open inspector' }));
    await screen.findByTestId('scene-right-panel');
    await user.click(screen.getByRole('textbox', { name: 'External field' }));
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'External field' })).toHaveFocus());
  });

  it('keeps outside keyboard focus when focus leaves the inspector', async () => {
    const user = userEvent.setup(); render(<PanelExample />);
    await user.click(screen.getByRole('button', { name: 'Open inspector' }));
    await screen.findByTestId('scene-right-panel');
    screen.getByRole('textbox', { name: 'External field' }).focus();
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'External field' })).toHaveFocus());
  });

  it.each(['close', 'Escape'])('returns to the opener after explicit %s', async (action) => {
    const user = userEvent.setup(); render(<PanelExample />);
    const opener = screen.getByRole('button', { name: 'Open inspector' });
    await user.click(opener); await screen.findByTestId('scene-right-panel');
    if (action === 'close') await user.click(screen.getByRole('button', { name: t('spaces.threeD.closePanel') }));
    else await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('returns to the opener when an outside surface leaves no focus target', async () => {
    const user = userEvent.setup(); render(<PanelExample />);
    const opener = screen.getByRole('button', { name: 'Open inspector' });
    await user.click(opener); await screen.findByTestId('scene-right-panel');
    await user.click(screen.getByTestId('outside-surface'));
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('restores the opener after reopening a panel previously dismissed outside', async () => {
    const user = userEvent.setup(); render(<PanelExample />);
    const opener = screen.getByRole('button', { name: 'Open inspector' });
    await user.click(opener); await screen.findByTestId('scene-right-panel');
    await user.click(screen.getByRole('textbox', { name: 'External field' }));
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    await user.click(opener); await screen.findByTestId('scene-right-panel');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
