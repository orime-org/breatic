// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { NodeHeader } from '@web/spaces/canvas/nodes/_shared/NodeHeader';

describe('NodeHeader', () => {
  it('shows the name', () => {
    render(<NodeHeader modality='image' name='Hero shot' onRename={() => {}} />);
    expect(screen.getByTestId('node-header')).toHaveTextContent('Hero shot');
  });

  it('falls back to the modality label when the name is blank', () => {
    render(<NodeHeader modality='audio' name='' onRename={() => {}} />);
    expect(screen.getByTestId('node-header')).toHaveTextContent('Audio');
  });

  it('double-click enters edit and Enter commits the new name', () => {
    const onRename = vi.fn();
    render(<NodeHeader modality='image' name='Old' onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('New name');
  });

  it('Escape cancels without committing', () => {
    const onRename = vi.fn();
    render(<NodeHeader modality='image' name='Old' onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('does not commit a blank rename', () => {
    const onRename = vi.fn();
    render(<NodeHeader modality='image' name='Old' onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('read-only: double-click does not enter edit', () => {
    render(<NodeHeader modality='image' name='Old' readOnly onRename={() => {}} />);
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    expect(screen.queryByTestId('node-header-input')).toBeNull();
  });
});
