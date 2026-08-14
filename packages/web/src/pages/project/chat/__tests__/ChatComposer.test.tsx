// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onAbort = vi.fn();
  render(
    <ChatComposer
      draft=''
      onChange={onChange}
      onSubmit={onSubmit}
      onAbort={onAbort}
      {...props}
    />,
  );
  return { onChange, onSubmit, onAbort };
}

describe('ChatComposer', () => {
  it('renders textarea + send button when not streaming', () => {
    setup();
    expect(screen.getByTestId('chat-composer-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer-send')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    setup();
    await expectNoA11yViolations(document.body);
  });

  it('renders the abort button while streaming', () => {
    setup({ turnPhase: 'running' });
    expect(screen.getByTestId('chat-composer-abort')).toBeInTheDocument();
  });

  it('offers nothing to press between the send and the server answering', () => {
    setup({ draft: 'hello', turnPhase: 'sending' });

    // Neither button belongs here. Send would ask the same thing twice, and
    // stop would claim to stop something nobody has confirmed is running --
    // and there is nothing on screen yet for stopping it to undo.
    expect(screen.queryByTestId('chat-composer-send')).toBeNull();
    expect(screen.queryByTestId('chat-composer-abort')).toBeNull();
    // Something has to be there in their place, or the press reads as having
    // done nothing at all.
    expect(screen.getByTestId('chat-composer-sending')).toBeInTheDocument();
  });

  it('hands the keyboard to the box when the press is made', () => {
    // Whoever sent this with the keyboard is standing on the send button, and
    // that button is about to be a stop button: same slot, same element, a
    // different thing to press. Leaving them there means their next keypress
    // stops the answer they just asked for. Letting the element go instead
    // drops them on the body, and their next Tab starts from the top of the
    // page. So the press hands the keyboard somewhere that is neither -- the
    // box they were typing in, which is where they act next anyway and which
    // does not change meaning underneath them.
    const props = {
      draft: 'hello',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onAbort: vi.fn(),
    };
    const { rerender } = render(<ChatComposer {...props} turnPhase='idle' />);
    const send = screen.getByTestId('chat-composer-send');
    send.focus();

    fireEvent.click(send);
    rerender(<ChatComposer {...props} turnPhase='sending' />);

    expect(document.activeElement).toBe(screen.getByTestId('chat-composer-textarea'));
  });

  it('does not leave the keyboard on the button that becomes stop', () => {
    const onAbort = vi.fn();
    const props = { draft: 'hello', onChange: vi.fn(), onSubmit: vi.fn(), onAbort };
    const { rerender } = render(<ChatComposer {...props} turnPhase='idle' />);
    const send = screen.getByTestId('chat-composer-send');
    send.focus();
    fireEvent.click(send);

    rerender(<ChatComposer {...props} turnPhase='sending' />);
    rerender(<ChatComposer {...props} turnPhase='running' />);

    // Pressing the key again -- a double click, or Enter held down -- must not
    // reach stop, because nobody aimed at stop.
    expect(document.activeElement).not.toBe(screen.getByTestId('chat-composer-abort'));
  });

  it('still has the keyboard somewhere once the turn is over', () => {
    // The turn ends, the box is empty, and the send button goes back to being
    // disabled -- which takes it out of the tab order, so a browser blurs it.
    // That is the same loss one step later, and it happens on every send.
    const props = { draft: 'hello', onChange: vi.fn(), onSubmit: vi.fn(), onAbort: vi.fn() };
    const { rerender } = render(<ChatComposer {...props} turnPhase='idle' />);
    const send = screen.getByTestId('chat-composer-send');
    send.focus();
    fireEvent.click(send);

    rerender(<ChatComposer {...props} draft='' turnPhase='running' />);
    rerender(<ChatComposer {...props} draft='' turnPhase='idle' />);

    expect(document.activeElement).toBe(screen.getByTestId('chat-composer-textarea'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the wait out of the tab order, because there is nothing to do with it', () => {
    // The slot the indicator stands in becomes the stop button a moment
    // later. Anything focusable there can be tabbed to and then changes into
    // something else underneath the reader. It is not a control -- there is
    // nothing to press -- so it does not belong in the tab order at all, and
    // what it has to say is said by the live region instead.
    render(
      <ChatComposer
        draft='hello'
        turnPhase='sending'
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onAbort={vi.fn()}
      />,
    );
    const waiting = screen.getByTestId('chat-composer-sending');

    expect(waiting.tagName).not.toBe('BUTTON');
    waiting.focus();
    expect(document.activeElement).not.toBe(waiting);
  });

  it('says what the wait is about, for a reader who cannot see it spin', async () => {
    // Said by the live region rather than by the spinner. A region that is
    // already on the page when its text arrives is one screen readers
    // announce; one that appears holding its text is one many of them never
    // do. The spinner itself is hidden -- it would otherwise say the same
    // thing a second time, in a place nobody can reach.
    setup({ draft: 'hello', turnPhase: 'sending' });
    await expectNoA11yViolations(document.body);
    expect(screen.getByRole('status')).toHaveTextContent('Sending');
    expect(screen.getByTestId('chat-composer-sending')).toHaveAttribute('aria-hidden', 'true');
  });

  it('has nothing to announce when nothing is being waited for', () => {
    setup({ draft: 'hello', turnPhase: 'idle' });
    // The region stays, so that it is here before it has anything to say.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('send is disabled while the draft is empty', () => {
    setup();
    expect(
      (screen.getByTestId('chat-composer-send') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('Enter without Shift submits', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ draft: 'hello' });
    const ta = screen.getByTestId('chat-composer-textarea');
    ta.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('the Enter that picks an IME candidate does NOT submit', () => {
    const { onSubmit } = setup({ draft: 'nihao' });
    const ta = screen.getByTestId('chat-composer-textarea');
    // Typing Chinese, Japanese or Korean means pressing Enter to accept what
    // the IME is offering — several times per sentence. The browser marks
    // that keystroke as part of the composition, and it is the only thing
    // separating it from the Enter that means "send". Without the check, the
    // first message a CJK reader ever sends is their raw keystrokes.
    fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Shift+Enter does NOT submit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ draft: 'hello' });
    const ta = screen.getByTestId('chat-composer-textarea');
    ta.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clicking abort fires onAbort while streaming', async () => {
    const user = userEvent.setup();
    const { onAbort } = setup({ turnPhase: 'running' });
    await user.click(screen.getByTestId('chat-composer-abort'));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
