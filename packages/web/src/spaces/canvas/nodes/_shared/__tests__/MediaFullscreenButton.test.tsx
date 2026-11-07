// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MediaFullscreenButton } from '@web/spaces/canvas/nodes/_shared/MediaFullscreenButton';
import { renderWithTooltips } from '@web/test-utils/render-with-tooltips';

describe('MediaFullscreenButton', () => {
  // inner#1844 visual review: a canvas node and a hover card both clip their
  // children, so a tooltip drawn inside them is cut down to a strip.
  it('draws its tooltip outside the clipping host', async () => {
    const user = userEvent.setup();
    renderWithTooltips(
      <div data-testid='host' className='overflow-hidden'>
        <MediaFullscreenButton onOpen={() => {}} />
      </div>,
    );
    await user.hover(screen.getByTestId('media-fullscreen-button'));
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    expect(within(screen.getByTestId('host')).queryByText('View full screen')).toBeNull();
  });
});
