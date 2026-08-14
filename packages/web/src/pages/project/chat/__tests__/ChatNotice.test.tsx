// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ChatNotice } from '@web/pages/project/chat/ChatNotice';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

describe('ChatNotice', () => {
  it('says nothing when there is nothing to say', () => {
    const { container } = render(<ChatNotice message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows what happened', () => {
    render(<ChatNotice message='That did not go out' />);
    expect(screen.getByTestId('chat-notice')).toHaveTextContent('That did not go out');
  });

  it('announces itself, because for some readers it is the only channel', () => {
    // Everything else about a failed send is visual: a bubble that does not
    // appear, a stop button that turns back into send. This line is the only
    // thing that says what happened, so it has to be spoken.
    render(<ChatNotice message='That did not go out' />);
    expect(screen.getByTestId('chat-notice')).toHaveAttribute('role', 'alert');
  });

  it('has no a11y violations', async () => {
    const { container } = render(<ChatNotice message='That did not go out' />);
    await expectNoA11yViolations(container);
  });
});
