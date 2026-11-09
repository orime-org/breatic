// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ParamToggleRow } from '@web/spaces/canvas/generate/ParamToggleRow';

describe('ParamToggleRow (inner#1691)', () => {
  it('throws the switch only from the switch itself, never from its name or state word', () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<ParamToggleRow id='row' label='Texture' checked onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByText('Texture'));
    fireEvent.click(screen.getByText('On'));
    fireEvent.click(container.firstElementChild!);
    expect(onCheckedChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('switch', { name: 'Texture' }));
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('says why a held switch does not move only when the switch itself is pressed', () => {
    const onLocked = vi.fn();
    render(<ParamToggleRow id='row' label='PBR' checked={false} onCheckedChange={() => {}} onLocked={onLocked} />);

    fireEvent.click(screen.getByText('PBR'));
    expect(onLocked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: 'PBR' }));
    expect(onLocked).toHaveBeenCalledTimes(1);
  });
});
