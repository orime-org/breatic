// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GenerateToolbar } from '@web/spaces/canvas/generate/GenerateToolbar';

describe('GenerateToolbar — Reference is live; Style / Mark / Focus are disabled placeholders (slice 1, 岔路二 B)', () => {
  it('renders all four tool buttons', () => {
    render(<GenerateToolbar onReference={() => {}} />);
    expect(screen.getByTestId('generate-tool-style')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-mark')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-focus')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-reference')).toBeInTheDocument();
  });

  it('disables Style / Mark / Focus (unbuilt slices) and enables Reference', () => {
    render(<GenerateToolbar onReference={() => {}} />);
    expect(screen.getByTestId('generate-tool-style')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-mark')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-focus')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('fires onReference when Reference is clicked', () => {
    const onReference = vi.fn();
    render(<GenerateToolbar onReference={onReference} />);
    fireEvent.click(screen.getByTestId('generate-tool-reference'));
    expect(onReference).toHaveBeenCalledTimes(1);
  });
});
