// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { VideoGeneratePanel } from '@web/spaces/canvas/generate/VideoGeneratePanel';

/**
 * Builds a video model for the panel tests.
 * @param name - Model id.
 * @param cost - Credits per call.
 * @returns A model entry.
 */
function model(name: string, cost = 88): ModelEntry {
  return {
    name,
    display_name: name.toUpperCase(),
    modality: 'video',
    mode: 't2v',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: cost,
    generation_time: 120,
    params: {
      aspect_ratio: { description: '', values: ['16:9', '9:16'], default: '16:9' },
      duration: { description: '', values: [4, 8], default: 8 },
    },
    providers: [],
    sourcesByMode: { t2v: [] },
  };
}

const MODELS = [model('veo-3.1'), model('veo-3.1-lite', 21)];

/**
 * Renders the panel with defaults, overridable per case.
 * @param over - Prop overrides.
 * @returns The render result plus the spies the case may assert on.
 */
function renderPanel(over: Partial<React.ComponentProps<typeof VideoGeneratePanel>> = {}): {
  onExecute: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
} {
  const onExecute = vi.fn();
  const onExit = vi.fn();
  // The tool row's tips need the provider App.tsx mounts once for the whole
  // app (single-provider mandate) — standing in for it is what a test does.
  render(
    <TooltipProvider>
      <VideoGeneratePanel
        models={MODELS}
        model='veo-3.1'
        params={{ aspect_ratio: '16:9', duration: 8 }}
        creditEstimate={88}
        mode='t2v'
        onToggleMode={() => {}}
        catalogEmpty={false}
        references={[]}
        onAddReference={() => {}}
        referencePicking={false}
        onRemoveReference={() => {}}
        onInsertReference={() => {}}
        slots={[]}
        slotUrls={{}}
        slotThumbnails={{}}
        onPickSlot={() => {}}
        onClearSlot={() => {}}
        canExecute
        promptSlot={<div data-testid='prompt-slot' />}
        onExit={onExit}
        onSelectModel={() => {}}
        onChangeParams={() => {}}
        onExecute={onExecute}
        {...over}
      />
    </TooltipProvider>,
  );
  return { onExecute, onExit };
}

describe('VideoGeneratePanel', () => {
  it('renders the prompt the container injects', () => {
    renderPanel();
    expect(screen.getByTestId('prompt-slot')).toBeInTheDocument();
  });

  it('shows the credit estimate — video costs several times an image', () => {
    renderPanel({ creditEstimate: 56 });
    expect(screen.getByTestId('generate-video-credit')).toHaveTextContent('56');
  });

  it('submits through an up-arrow button, not a labelled one', () => {
    // The same control the image panel ends with (user 2026-08-08: do not
    // invent a second submit affordance).
    const { onExecute } = renderPanel();
    const execute = screen.getByTestId('generate-video-execute');
    expect(execute).not.toHaveTextContent(/[a-z]/i);
    fireEvent.click(execute);
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('refuses to submit when the container says it cannot', () => {
    const { onExecute } = renderPanel({ canExecute: false });
    const execute = screen.getByTestId('generate-video-execute');
    expect(execute).toBeDisabled();
    fireEvent.click(execute);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('closes without generating', () => {
    const { onExit, onExecute } = renderPanel();
    fireEvent.click(screen.getByTestId('generate-video-exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('offers the model picker and the params picker', () => {
    renderPanel();
    expect(screen.getByTestId('generate-model-trigger')).toBeVisible();
    expect(screen.getByTestId('generate-video-params-trigger')).toBeVisible();
  });

  it('drops the params picker when no model resolved', () => {
    // An empty catalog leaves nothing to read param options off; the panel
    // still renders so the user sees why they cannot generate.
    renderPanel({ models: [], model: '', creditEstimate: 0 });
    expect(screen.queryByTestId('generate-video-params-trigger')).toBeNull();
    expect(screen.getByTestId('prompt-slot')).toBeInTheDocument();
  });

  it('names the active mode and offers the other one', () => {
    renderPanel({ mode: 'i2v' });
    const trigger = screen.getByTestId('generate-video-mode-trigger');
    expect(trigger).toHaveTextContent('Image to Video');
    fireEvent.click(trigger);
    expect(screen.getByTestId('generate-video-mode-t2v')).toBeInTheDocument();
  });

  it('cannot switch mode while no mode has a model to switch to', () => {
    // A switch then resolves nothing and would clobber the node's stored
    // model and params, which do not self-heal.
    renderPanel({ catalogEmpty: true });
    expect(screen.getByTestId('generate-video-mode-trigger')).toBeDisabled();
  });

  it('always offers the reference tool, in every mode', () => {
    // Reference is the one source every video mode has (design §3.4): a
    // connected node feeds the prompt's `@` mentions whatever is generated.
    renderPanel({ mode: 't2v' });
    expect(screen.getByTestId('generate-video-tool-reference')).toBeInTheDocument();
  });

  it('shows one slot control per slot the mode collects, and none otherwise', () => {
    renderPanel({ slots: [] });
    expect(screen.queryByTestId('generate-video-tool-first-frame')).toBeNull();
    expect(screen.queryByTestId('generate-video-tool-end-frame')).toBeNull();
    cleanup();

    renderPanel({ slots: ['firstFrame'] });
    expect(screen.getByTestId('generate-video-tool-first-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-video-tool-end-frame')).toBeNull();
    cleanup();

    renderPanel({ slots: ['firstFrame', 'endFrame'] });
    expect(screen.getByTestId('generate-video-tool-first-frame')).toBeInTheDocument();
    expect(screen.getByTestId('generate-video-tool-end-frame')).toBeInTheDocument();
  });

  it('offers to clear a slot that is filled but has no picture to show (#1918)', () => {
    // A driving video whose node has no poster yet. The slot IS filled — it
    // holds the video and the payload will carry it — but there is nothing an
    // `<img>` can paint, so the control covers itself with the video node's
    // icon (#1946). What must not follow is losing the ✕: a pick the user
    // cannot take back is a dead end, and the only way out would be picking a
    // different video.
    renderPanel({
      slots: ['drivingVideo'],
      slotUrls: { drivingVideo: 'https://cdn/driving.mp4' },
      slotThumbnails: {},
    });
    expect(
      screen.queryByTestId('generate-video-driving-video-thumbnail'),
    ).toBeNull();
    expect(
      screen.getByTestId('generate-video-driving-video-clear'),
    ).toBeInTheDocument();
  });

  it('fills each slot control from its own URL', () => {
    // The two frames are separate values on separate node fields; a shared
    // read would show the same picture in both.
    //
    // What a slot SHOWS comes from `slotThumbnails`, not from the picked URL:
    // for an image slot the view model puts the same URL in both, but a slot
    // holding a video shows a poster instead, because an `<img>` cannot paint
    // an mp4 (#1918). The panel is the dumb end of that — it renders what it
    // is handed and does not fall back from one to the other.
    renderPanel({
      slots: ['firstFrame', 'endFrame'],
      slotUrls: { firstFrame: 'https://cdn/f.png', endFrame: 'https://cdn/l.png' },
      slotThumbnails: {
        firstFrame: 'https://cdn/f.png',
        endFrame: 'https://cdn/l.png',
      },
    });
    expect(
      screen.getByTestId('generate-video-first-frame-thumbnail'),
    ).toHaveAttribute('src', 'https://cdn/f.png');
    expect(
      screen.getByTestId('generate-video-end-frame-thumbnail'),
    ).toHaveAttribute('src', 'https://cdn/l.png');
  });

  it('renders the reference rail rows the container derives', () => {
    renderPanel({
      references: [
        {
          refId: 'e1',
          sourceNodeId: 'src',
          sourceNodeType: 'image',
          sourceNodeName: 'A still',
          thumbnail: 'https://cdn/a.png',
        },
      ],
    });
    expect(screen.getByTestId('generate-ref-e1')).toBeInTheDocument();
  });
});
