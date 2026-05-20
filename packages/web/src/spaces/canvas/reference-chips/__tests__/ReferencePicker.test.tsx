import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReferencePicker, type ReferenceCandidate } from '@/spaces/canvas/reference-chips/ReferencePicker';

const CANDIDATES: ReferenceCandidate[] = [
  { id: 'n1', modality: 'image', label: 'cover.jpg' },
  { id: 'n2', modality: 'text', label: 'plot outline' },
];

describe('ReferencePicker', () => {
  it('renders the trigger child', () => {
    render(
      <ReferencePicker candidates={CANDIDATES} onPick={() => {}}>
        <button data-testid='picker-trigger'>@</button>
      </ReferencePicker>,
    );
    expect(screen.getByTestId('picker-trigger')).toBeInTheDocument();
  });

  it('opens the popover and lists candidates', async () => {
    const user = userEvent.setup();
    render(
      <ReferencePicker candidates={CANDIDATES} onPick={() => {}}>
        <button data-testid='picker-trigger'>@</button>
      </ReferencePicker>,
    );
    await user.click(screen.getByTestId('picker-trigger'));
    expect(
      await screen.findByTestId('reference-candidate-n1'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('reference-candidate-n2')).toBeInTheDocument();
  });

  it('selecting a candidate fires onPick with the candidate', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <ReferencePicker candidates={CANDIDATES} onPick={onPick}>
        <button data-testid='picker-trigger'>@</button>
      </ReferencePicker>,
    );
    await user.click(screen.getByTestId('picker-trigger'));
    await user.click(await screen.findByTestId('reference-candidate-n1'));
    expect(onPick).toHaveBeenCalledWith(CANDIDATES[0]);
  });
});
