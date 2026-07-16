// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry } from '@breatic/shared';

import { GeneratePanel } from '@web/spaces/canvas/generate/GeneratePanel';

const MODEL: ModelEntry = {
  name: 'nano_banana_pro',
  display_name: 'Nano Banana Pro',
  modality: 'image',
  mode: 'text-to-image',
  description: '',
  guide: '',
  tier: 'recommended',
  cost_per_call: 7,
  generation_time: 30,
  params: {
    aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '1:1' },
    resolution: { description: '', values: ['1K', '2K'], default: '1K' },
  },
  providers: [],
  sourcesByMode: {},
};

/**
 * Renders the panel with sensible defaults, overridable per test.
 * @param overrides - Props overriding the defaults.
 * @returns The render result.
 */
function setup(
  overrides: Partial<React.ComponentProps<typeof GeneratePanel>> = {},
): ReturnType<typeof render> {
  return render(
    <GeneratePanel
      models={[MODEL]}
      model='nano_banana_pro'
      mode='t2i'
      catalogEmpty={false}
      params={{ aspect_ratio: '16:9', resolution: '2K' }}
      references={[]}
      creditEstimate={7}
      canExecute
      promptSlot={<div data-testid='prompt-slot'>prompt</div>}
      onExit={() => {}}
      onInsertReference={() => {}}
      onSelectModel={() => {}}
      onToggleMode={() => {}}
      onChangeParams={() => {}}
      onAddReference={() => {}}
      referencePicking={false}
      onRemoveReference={() => {}}
      onStyle={() => {}}
      stylePicking={false}
      onClearStyle={() => {}}
      styleSupported
      onFocus={() => {}}
      focusPicking={false}
      onExecute={() => {}}
      {...overrides}
    />,
  );
}

describe('GeneratePanel — the collaborative image-node Generate panel shell (slice 1)', () => {
  it('is 600px wide with squeeze-proof footer icons (batch-2 item 8)', () => {
    // At 560px the fixed-size footer icons were squeezed by long picker
    // labels (no flex-wrap by design); 600px + shrink-0 keeps them intact.
    const { container } = setup();
    expect(
      (container.firstChild as HTMLElement).className,
    ).toContain('w-[min(600px,92vw)]');
    expect(screen.getByTestId('generate-presets').className).toContain(
      'shrink-0',
    );
    expect(screen.getByTestId('generate-execute').className).toContain(
      'shrink-0',
    );
  });

  it('renders the exit button, prompt slot, model picker and credit estimate', () => {
    setup();
    expect(screen.getByTestId('generate-exit')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-slot')).toBeInTheDocument();
    expect(screen.getByTestId('generate-model-trigger')).toHaveTextContent(
      'Nano Banana Pro',
    );
    expect(screen.getByTestId('generate-credit')).toHaveTextContent('7');
  });

  it('renders the unbuilt footer controls as disabled placeholders (岔路二 B)', () => {
    setup();
    expect(screen.getByTestId('generate-presets')).toBeDisabled();
    expect(screen.getByTestId('generate-camera')).toBeDisabled();
    expect(screen.getByTestId('generate-online')).toBeDisabled();
    expect(screen.getByTestId('generate-translate')).toBeDisabled();
  });

  it('fires onExit when the exit button is clicked', () => {
    const onExit = vi.fn();
    setup({ onExit });
    fireEvent.click(screen.getByTestId('generate-exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('disables the execute button when canExecute is false', () => {
    setup({ canExecute: false });
    expect(screen.getByTestId('generate-execute')).toBeDisabled();
  });

  it('fires onExecute when execute is clicked and enabled', () => {
    const onExecute = vi.fn();
    setup({ canExecute: true, onExecute });
    fireEvent.click(screen.getByTestId('generate-execute'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('does not render a count control (count is fixed to 1)', () => {
    setup();
    expect(screen.queryByTestId('generate-count')).toBeNull();
  });

  it('renders the mode toggle and fires onToggleMode when switching to i2i', () => {
    const onToggleMode = vi.fn();
    setup({ mode: 't2i', onToggleMode });
    expect(screen.getByTestId('generate-mode-trigger')).toHaveTextContent(
      'Text to Image',
    );
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    fireEvent.click(screen.getByTestId('generate-mode-i2i'));
    expect(onToggleMode).toHaveBeenCalledWith('i2i');
  });

  it('disables the reference add-button in t2i (§2.5)', () => {
    setup({ mode: 't2i' });
    expect(screen.getByTestId('generate-tool-reference')).toBeDisabled();
  });

  it('enables the reference add-button in i2i', () => {
    setup({ mode: 'i2i' });
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('gates Focus with the mode exactly like Reference (#1782 — same i2i pool)', () => {
    setup({ mode: 't2i' });
    expect(screen.getByTestId('generate-tool-focus')).toBeDisabled();
  });

  it('enables Focus in i2i (#1782)', () => {
    setup({ mode: 'i2i' });
    expect(screen.getByTestId('generate-tool-focus')).not.toBeDisabled();
  });

  it('disables the mode toggle while the GLOBAL catalog is empty (loading/failed) — guards the data-clobber', () => {
    // Adversarial round 1 (2026-07-09): toggling before the catalog resolves
    // would clobber the node's stored model/params. The toggle is inert while
    // the whole generatable catalog is empty (loading / failed / none configured).
    setup({ catalogEmpty: true, models: [] });
    expect(screen.getByTestId('generate-mode-trigger')).toBeDisabled();
  });

  it('keeps the mode toggle ENABLED when the current mode is empty but the catalog is not (escape hatch)', () => {
    // Adversarial round 2 (2026-07-09): the round-1 fix wrongly gated on the
    // CURRENT-mode-filtered model count, so a node stuck in a mode with zero
    // models (e.g. i2i on a t2i-only deployment) had BOTH buttons disabled and
    // no way back. The disable must gate on GLOBAL catalog emptiness so the user
    // can always toggle to the populated mode.
    setup({ mode: 'i2i', models: [], catalogEmpty: false });
    expect(screen.getByTestId('generate-mode-trigger')).not.toBeDisabled();
  });

  it('dims only the IMAGE reference rows in t2i (text rows stay insertable)', () => {
    // Round-3 R3-4, user ruled A (2026-07-11): t2i ignores source images but
    // text references still feed the prompt via @-chips — the panel must pass
    // the scoped flag so image rows go inert while text rows stay live.
    setup({
      mode: 't2i',
      references: [
        {
          refId: 'e1',
          sourceNodeId: 's1',
          sourceNodeType: 'image',
          sourceNodeName: 'Src',
        },
        {
          refId: 'e2',
          sourceNodeId: 's2',
          sourceNodeType: 'text',
          sourceNodeName: 'Notes',
        },
      ],
    });
    expect(screen.getByTestId('generate-ref-insert-e1')).toBeDisabled();
    expect(screen.getByTestId('generate-ref-insert-e2')).not.toBeDisabled();
  });
});
