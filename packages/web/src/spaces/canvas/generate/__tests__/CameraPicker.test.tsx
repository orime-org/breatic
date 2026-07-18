// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import type * as React from 'react';

// Pass the tooltip primitives through: real Radix Tooltip throws without the
// app-level TooltipProvider (App.tsx mounts it) and the trigger nests inside
// the Popover. The tooltip's on/off copy is also mirrored in the popover header
// span, so state is asserted there — not via the (mocked-away) tooltip content.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { CameraPicker } from '@web/spaces/canvas/generate/CameraPicker';

/**
 * Builds an image model with the given camera-cluster params.
 * @param params - The model's param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'image',
    mode: 'text-to-image',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 7,
    generation_time: 30,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

// focal_length values are NUMBERS in the catalog — the coercion trap under test.
const FULL = model({
  camera: {
    description: '',
    values: ['Canon EOS R5', 'Sony A7'],
    default: 'Canon EOS R5',
  },
  lens: { description: '', values: ['Zeiss', 'Leica'], default: 'Zeiss' },
  focal_length: { description: '', values: [35, 50, 85], default: 50 },
  aperture: { description: '', values: ['f/1.4', 'f/2.8'], default: 'f/2.8' },
});

describe('CameraPicker — model-capability-gated camera cluster control (#1788)', () => {
  // Capability gating is the panel's job: when the model omits the cluster the
  // panel does not render CameraPicker at all (unsupported → hidden, not
  // greyed-out). CameraPicker itself is a pure control that assumes it is shown.

  it('opens a four-wheel popover with the master toggle when supported', () => {
    render(
      <CameraPicker
        model={FULL}
        value={{ enable_camera: false }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-camera'));
    // One chevron pair per column — camera / lens / focal / aperture.
    expect(screen.getByLabelText('Camera ▼')).toBeInTheDocument();
    expect(screen.getByLabelText('Lens ▼')).toBeInTheDocument();
    expect(screen.getByLabelText('Focal length ▼')).toBeInTheDocument();
    expect(screen.getByLabelText('Aperture ▼')).toBeInTheDocument();
    expect(screen.getByTestId('generate-camera-toggle')).toBeInTheDocument();
  });

  it('picking a string param (camera body) fires onChange with the next value', () => {
    const onChange = vi.fn();
    render(
      <CameraPicker
        model={FULL}
        value={{ camera: 'Canon EOS R5' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-camera'));
    fireEvent.click(screen.getByLabelText('Camera ▼'));
    expect(onChange).toHaveBeenCalledWith({ camera: 'Sony A7' });
  });

  it('coerces focal_length back to a NUMBER (guards the validateParams silent-reset trap)', () => {
    // The catalog focal_length values are numeric; a string would fail the
    // worker's `spec.values.includes()` check and be silently reset to default.
    const onChange = vi.fn();
    render(
      <CameraPicker
        model={FULL}
        value={{ focal_length: 50 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-camera'));
    fireEvent.click(screen.getByLabelText('Focal length ▼'));
    expect(onChange).toHaveBeenCalledWith({ focal_length: 85 });
    const arg = onChange.mock.calls[0]![0] as { focal_length: unknown };
    expect(typeof arg.focal_length).toBe('number');
  });

  it('clamps at the first value — the up chevron is disabled at the start', () => {
    render(
      <CameraPicker
        model={FULL}
        value={{ focal_length: 35 }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-camera'));
    expect(screen.getByLabelText('Focal length ▲')).toBeDisabled();
    expect(screen.getByLabelText('Focal length ▼')).not.toBeDisabled();
  });

  it('the master switch fires onChange with enable_camera (opt-in gate, replaces a × close)', () => {
    const onChange = vi.fn();
    render(
      <CameraPicker
        model={FULL}
        value={{ enable_camera: false }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-camera'));
    fireEvent.click(screen.getByTestId('generate-camera-toggle'));
    expect(onChange).toHaveBeenCalledWith({ enable_camera: true });
  });

  it('reflects the on/off state in the popover header copy', () => {
    const { rerender } = render(
      <CameraPicker
        model={FULL}
        value={{ enable_camera: true }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-camera'));
    expect(screen.getByText('On')).toBeInTheDocument();
    rerender(
      <CameraPicker
        model={FULL}
        value={{ enable_camera: false }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Off')).toBeInTheDocument();
  });
});
