// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parse } from 'yaml';

import { GENERATION_NODE_BUCKETS } from '@breatic/shared';

import { ModelIcon, MODEL_ICON_NAMES } from '@web/spaces/canvas/generate/ModelIcon';

describe('ModelIcon — per-vendor brand marks for the model picker', () => {
  it('renders a distinct mark for every generatable-model icon name', () => {
    // The generate picker only shows generation models (t2i / i2i). Every one
    // of their config `icon` names MUST resolve to a real self-drawn mark —
    // there is no "unknown model" fallback (user 2026-07-09).
    for (const name of MODEL_ICON_NAMES) {
      const { unmount } = render(<ModelIcon name={name} />);
      expect(screen.getByTestId(`model-icon-${name}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('covers every picker vendor, image and audio alike', () => {
    // Exact rather than containing: a name dropped from the registry while a
    // model's yaml still declares it draws nothing at all, and nothing else
    // would say so.
    expect([...MODEL_ICON_NAMES].sort()).toEqual([
      'alibaba',
      'bria',
      'clarity',
      'elevenlabs',
      'flux',
      'gemini',
      'hunyuan',
      'infinitetalk',
      'inworld',
      'kling',
      'ltx',
      'meta',
      'midjourney',
      'minimax',
      'mirelo',
      'mureka',
      'nano-banana',
      'omnivoice',
      'openai',
      'qwen',
      'recraft',
      'reve',
      'rife',
      'seedream',
      'sonilo',
      'sourceful',
      'sync',
      'vocal-isolator',
      'xai',
    ]);
  });

  // Read as written: the catalog projection drops a model whose provider key
  // is unset, so under CI it would have nothing to walk. The files are the
  // ones the loader reads, in the buckets a picker offers.
  const root = resolve(process.cwd(), '../../config/models');
  const declared = [...new Set(Object.values(GENERATION_NODE_BUCKETS).flat())]
    .map((bucket) => resolve(root, bucket))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => extname(file) === '.yaml' && file !== 'providers.yaml')
        .map((file) => resolve(dir, file)),
    )
    .flatMap((file) => {
      const doc: unknown = parse(readFileSync(file, 'utf8'));
      const list = Array.isArray(doc) ? doc : ((doc as { models?: unknown[] } | null)?.models ?? []);
      return list as Array<{ name?: string; icon?: string }>;
    });

  it('draws a mark for every model a picker offers', () => {
    const unmarked = declared
      .filter((model) => model.icon === undefined || !MODEL_ICON_NAMES.includes(model.icon))
      .map((model) => `${model.name ?? '?'} (${model.icon ?? 'no icon'})`);
    expect(declared.length).toBeGreaterThan(0);
    expect(unmarked).toEqual([]);
  });

  it('keeps no mark that no model declares', () => {
    const used = new Set(declared.map((model) => model.icon));
    expect(MODEL_ICON_NAMES.filter((name) => !used.has(name))).toEqual([]);
  });

  it('renders nothing for an absent icon name (undefined) rather than a fallback', () => {
    const { container } = render(<ModelIcon name={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('forwards a className onto the svg so the picker can size it', () => {
    render(<ModelIcon name='midjourney' className='h-4 w-4' />);
    const svg = screen.getByTestId('model-icon-midjourney');
    expect(svg).toHaveClass('h-4', 'w-4');
  });
});
