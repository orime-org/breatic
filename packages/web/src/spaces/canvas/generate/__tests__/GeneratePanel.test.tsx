// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry } from '@breatic/shared';
import type * as React from 'react';

// Pass through the tooltip primitives: real Radix Tooltip throws without the
// app-level TooltipProvider (App.tsx mounts it); tooltip behavior is pinned
// in GenerateToolbar.test — not this file's concern.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { IMAGE_MODE_OPTIONS } from '@web/spaces/canvas/generate/image-mode-selection';
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
  takes_prompt: true,
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
      promptRequired
      modeOptions={IMAGE_MODE_OPTIONS}
      params={{ aspect_ratio: '16:9', resolution: '2K' }}
      references={[]}
      creditEstimate={7}
      executeRefusal={null}
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
      cameraSupported={false}
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
    expect(screen.getByTestId('generate-online')).toBeDisabled();
    expect(screen.getByTestId('generate-translate')).toBeDisabled();
  });

  it('hides the Camera control when the model omits the cluster (#1788 — unsupported → hidden, not greyed)', () => {
    setup({ cameraSupported: false });
    expect(screen.queryByTestId('generate-camera')).toBeNull();
  });

  it('renders the Camera control when the model declares the cluster (#1788)', () => {
    setup({ cameraSupported: true });
    expect(screen.getByTestId('generate-camera')).toBeInTheDocument();
  });

  it('fires onExit when the exit button is clicked', () => {
    const onExit = vi.fn();
    setup({ onExit });
    fireEvent.click(screen.getByTestId('generate-exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('disables the execute button for a refusal the user cannot act on', () => {
    setup({ executeRefusal: 'no-model' as const });
    expect(screen.getByTestId('generate-execute')).toBeDisabled();
  });

  it('fires onExecute when execute is clicked and enabled', () => {
    const onExecute = vi.fn();
    setup({ executeRefusal: null, onExecute });
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

  it('keeps the reference add-button ENABLED in t2i — the pick is scoped to text, not disabled (#1788 batch-3 #1)', () => {
    setup({ mode: 't2i' });
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('enables the reference add-button in i2i', () => {
    setup({ mode: 'i2i' });
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('keeps Focus ENABLED in t2i — collecting a crop is never refused at the entry (#1986)', () => {
    // Same shape as the reference button above, and for the same reason: what
    // a mode cannot use is refused on the ROW, which dims and explains itself
    // (#1952). This one was turned off in t2i by #1782 itself, the slice that
    // added focus — leaving a button that swallowed the click and said
    // nothing. User 2026-08-19 ruled both panels behave alike, and the video
    // one has been live in every mode since #1978.
    setup({ mode: 't2i' });
    expect(screen.getByTestId('generate-tool-focus')).not.toBeDisabled();
  });

  it('enables Focus in i2i (#1782)', () => {
    setup({ mode: 'i2i' });
    expect(screen.getByTestId('generate-tool-focus')).not.toBeDisabled();
  });

  it('模式选择器只列出这个部署能服务的档 (#1951)', () => {
    // 「目录整个为空」这个状态在面板里不存在了：CatalogGatedFrame 会把面板
    // 挡在外面（generate-panel-frame.test.tsx 钉）。面板要做的只有一件事 ——
    // 把拿到的档如实列出来。
    setup({ modeOptions: IMAGE_MODE_OPTIONS.filter((o) => o.value === 't2i') });
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    expect(screen.getByTestId('generate-mode-t2i')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-mode-i2i')).not.toBeInTheDocument();
  });

  it('refuses insert on the image row in t2i, text row stays insertable', () => {
    // Round-3 R3-4, user ruled A (2026-07-11): t2i ignores source images but
    // text references still feed the prompt via @-chips. What this asserts is
    // the INSERT verdict; the dim itself is pinned in
    // ReferenceRail-states.test.tsx, and since #1945 it reads on reference
    // material rather than on image rows specifically.
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
    // #1945: the refusal is aria-disabled, not the HTML attribute — a disabled
    // element could neither explain itself on click nor open its hover preview.
    expect(screen.getByTestId('generate-ref-insert-e1')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByTestId('generate-ref-insert-e2')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
