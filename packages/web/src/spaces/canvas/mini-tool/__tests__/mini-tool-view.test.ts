// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { type ModelEntry, type ParamDescriptor } from '@breatic/shared';
import { miniToolById, miniToolRequestSchema } from '@breatic/shared/mini-tools';
import { EMPTY_MARK } from '@web/stores/mark-draft';

import {
  BLOCKING_REFUSALS,
  aspectRatioOf,
  creditMode,
  expandCapOf,
  exportsBeforeRun,
  miniToolRefusal,
  promptRequired,
  readsShownSize,
  rectForAspect,
  resolvedParams,
  setRectSide,
  slotLengthCap,
  slotOptional,
  sourceLimitOf,
} from '@web/spaces/canvas/mini-tool/mini-tool-view';

/**
 * A catalog entry declaring the given params.
 * @param params - Its params.
 * @param takesPrompt - Whether a prompt is required.
 * @returns The entry.
 */
function entry(params: Record<string, ParamDescriptor>, takesPrompt = false): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'video',
    mode: ['v2v'],
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: takesPrompt,
    params,
    providers: [],
  } as ModelEntry;
}

const tool = (id: string) => {
  const spec = miniToolById(id);
  if (!spec) throw new Error(id);
  return spec;
};

describe('resolvedParams', () => {
  // §13: a model tool opened fresh runs with the catalog's defaults.
  it('starts a model tool on its pinned model defaults, the draft on top', () => {
    const pinned = entry({
      target_resolution: { description: '', default: '1080p', values: ['720p', '1080p'], fill: 'tool' },
    });
    expect(resolvedParams(tool('video.upscale'), pinned, {})).toEqual({ target_resolution: '1080p' });
    expect(resolvedParams(tool('video.upscale'), pinned, { target_resolution: '720p' })).toEqual({
      target_resolution: '720p',
    });
  });

  it('keeps only the keys a tool lists', () => {
    const pinned = entry({ target_resolution: { description: '', default: '1080p', fill: 'tool' } });
    expect(resolvedParams(tool('video.upscale'), pinned, { stray: 1 })).toEqual({ target_resolution: '1080p' });
  });

  it('hands a local tool its draft as is', () => {
    expect(resolvedParams(tool('video.speed'), undefined, { rate: 2 })).toEqual({ rate: 2 });
  });

  // The range shows the whole clip until it is dragged; that is what is sent.
  it('sends an untouched range as the whole clip', () => {
    const sent = resolvedParams(tool('video.cut'), undefined, { range: null }, { duration: 12 });
    expect(sent).toEqual({ range: { start: 0, end: 12 } });
    const parsed = miniToolRequestSchema.safeParse({
      tool: 'video.cut',
      project_id: '00000000-0000-4000-8000-000000000001',
      space_id: '00000000-0000-4000-8000-000000000002',
      node_ids: ['00000000-0000-4000-8000-000000000003'],
      source: { url: 'https://x/a.mp4', duration: 12 },
      params: sent,
      slots: {},
    });
    expect(parsed.success).toBe(true);
  });

  // The upscale tool picks an output size; the run is sent its megapixels.
  const upscaler = entry({
    target_megapixels: { description: '', default: 4, min: 1, max: 64, fill: 'tool' },
    creativity: { description: '', default: 0, min: -10, max: 10, fill: 'tool' },
  });

  it('sends the default size tier as the megapixels it comes to on the source', () => {
    expect(resolvedParams(tool('image.upscale'), upscaler, {}, { width: 1024, height: 1536 })).toEqual({
      target_megapixels: 11.19,
      creativity: 0,
    });
  });

  it('sends the size tier the reader picked', () => {
    expect(
      resolvedParams(tool('image.upscale'), upscaler, { target_megapixels: '8K' }, { width: 1024, height: 1536 }),
    ).toEqual({ target_megapixels: 44.74, creativity: 0 });
  });

  it('sends no size while the source size is unknown', () => {
    expect(resolvedParams(tool('image.upscale'), upscaler, {}, {})).toEqual({ creativity: 0 });
  });

  it('keeps a dragged range', () => {
    expect(resolvedParams(tool('video.cut'), undefined, { range: { start: 2, end: 5 } }, { duration: 12 })).toEqual({
      range: { start: 2, end: 5 },
    });
  });
});

describe('miniToolRefusal', () => {
  const motion = entry({ image: { description: '', default: null, fill: 'tool' } }, true);
  const base = { spec: tool('video.motion'), entry: motion, prompt: 'walk', slots: { character: { url: 'a.png' } } };

  it('lets a filled tool run', () => {
    expect(miniToolRefusal({ ...base, sourceShown: true, exporting: false })).toBeNull();
  });

  it('refuses while the source shows nothing', () => {
    expect(miniToolRefusal({ ...base, sourceShown: false, exporting: false })).toBe('sourceMissing');
  });

  it('refuses an empty required slot', () => {
    expect(miniToolRefusal({ ...base, slots: {}, sourceShown: true, exporting: false })).toBe('slotMissing');
  });

  it('lets an optional slot stay empty', () => {
    const edit = entry({
      reference_images: { description: '', default: null, fill: 'tool', optional: true },
      reference_audios: { description: '', default: null, fill: 'tool', optional: true },
    });
    expect(
      miniToolRefusal({ spec: tool('video.edit'), entry: edit, prompt: 'x', slots: {}, sourceShown: true, exporting: false }),
    ).toBeNull();
  });

  it('refuses an empty prompt the pinned model requires', () => {
    expect(miniToolRefusal({ ...base, prompt: '  ', sourceShown: true, exporting: false })).toBe('promptMissing');
  });

  it('refuses an upscale while the source size is unknown, or when no tier is usable', () => {
    const upscaler = entry({ target_megapixels: { description: '', default: 4, min: 1, max: 64, fill: 'tool' } });
    const up = { spec: tool('image.upscale'), entry: upscaler, prompt: '', slots: {}, sourceShown: true, exporting: false };
    expect(miniToolRefusal({ ...up, source: {} })).toBe('sourceMissing');
    expect(miniToolRefusal({ ...up, source: { width: 9000, height: 6000 } })).toBe('noUsableTier');
    // A strip too thin for the model's floor at every size, not one too large.
    expect(miniToolRefusal({ ...up, source: { width: 8000, height: 100 } })).toBe('noUsableTier');
    expect(miniToolRefusal({ ...up, source: { width: 1024, height: 1536 } })).toBeNull();
  });

  it('refuses a cut while the source length is unknown', () => {
    const cut = { spec: tool('video.cut'), entry: undefined, prompt: '', slots: {}, sourceShown: true, exporting: false };
    expect(miniToolRefusal({ ...cut, source: {} })).toBe('sourceMissing');
    expect(miniToolRefusal({ ...cut, source: { duration: 12 } })).toBeNull();
  });

  // §5: a `many` slot's `max_total_duration` is held in the browser.
  describe('a slot over its total length', () => {
    const edit = entry({
      reference_images: { description: '', default: null, fill: 'tool', optional: true },
      reference_audios: { description: '', default: null, fill: 'tool', optional: true, max_total_duration: 15 },
    });
    const run = (audios: { url: string; duration?: number }[]) =>
      miniToolRefusal({
        spec: tool('video.edit'),
        entry: edit,
        prompt: 'x',
        slots: { audios },
        sourceShown: true,
        exporting: false,
      });

    it('refuses picks that add up past the cap', () => {
      expect(run([{ url: 'a', duration: 10 }, { url: 'b', duration: 10 }])).toBe('slotTooLong');
      expect(slotLengthCap(tool('video.edit'), edit, { audios: [{ url: 'a', duration: 10 }, { url: 'b', duration: 10 }] })).toBe(15);
    });

    it('lets picks within the cap run', () => {
      expect(run([{ url: 'a', duration: 7 }, { url: 'b', duration: 8 }])).toBeNull();
    });
  });

  // inner#1305 §7.3: the pinned model's own ceilings on the source, said on the press.
  describe('a source past the model\'s ceilings', () => {
    const enhance = entry({
      audio: { description: '', default: null, fill: 'tool', accepts: 'audio', max_total_duration: 1800, max_bytes: 536_870_912 },
      strength: { description: '', default: 0.85, min: 0, max: 1, step: 0.05, fill: 'tool' },
    });
    const run = (source: { duration?: number; sizeBytes?: number }) =>
      miniToolRefusal({ spec: tool('audio.enhance'), entry: enhance, prompt: '', slots: {}, sourceShown: true, exporting: false, source });

    it('refuses a source longer or larger than the model takes, naming the ceiling', () => {
      expect(run({ duration: 1801, sizeBytes: 10 })).toBe('sourceTooLong');
      expect(run({ duration: 60, sizeBytes: 536_870_913 })).toBe('sourceTooLarge');
      expect(sourceLimitOf(tool('audio.enhance'), enhance, { duration: 1801 })).toEqual({ kind: 'duration', limit: 1800 });
      expect(sourceLimitOf(tool('audio.enhance'), enhance, { sizeBytes: 536_870_913 })).toEqual({ kind: 'bytes', limit: 536_870_912 });
    });

    it('lets a source at the ceilings, or of unknown length and size, run', () => {
      expect(run({ duration: 1800, sizeBytes: 536_870_912 })).toBeNull();
      expect(run({})).toBeNull();
    });

    it('leaves Execute pressable so the press can say why', () => {
      expect(BLOCKING_REFUSALS.has('sourceTooLong')).toBe(false);
      expect(BLOCKING_REFUSALS.has('sourceTooLarge')).toBe(false);
    });
  });

  it('refuses while a browser tool is exporting', () => {
    expect(
      miniToolRefusal({ spec: tool('image.rotate'), entry: undefined, prompt: '', slots: {}, sourceShown: true, exporting: true }),
    ).toBe('exporting');
  });

  // inner#1302 §6.3: nothing drawn holds Execute back, after the slots and
  // before the prompt.
  describe('a drawing tool', () => {
    const genfill = entry({ mask_image: { description: '', default: null, fill: 'tool' } }, true);
    const inpaint = { spec: tool('image.inpaint'), entry: genfill, slots: {}, sourceShown: true, exporting: false };

    it('refuses with nothing drawn', () => {
      expect(miniToolRefusal({ ...inpaint, prompt: 'a cat', inked: false })).toBe('drawingEmpty');
      expect(miniToolRefusal({ ...inpaint, prompt: 'a cat' })).toBe('drawingEmpty');
    });

    it('puts an empty drawing ahead of an empty prompt', () => {
      expect(miniToolRefusal({ ...inpaint, prompt: '', inked: false })).toBe('drawingEmpty');
      expect(miniToolRefusal({ ...inpaint, prompt: '', inked: true })).toBe('promptMissing');
    });

    it('runs once something is drawn', () => {
      expect(miniToolRefusal({ ...inpaint, prompt: 'a cat', inked: true })).toBeNull();
    });

    it('takes no ink into account for a tool without a drawing', () => {
      expect(miniToolRefusal({ ...base, sourceShown: true, exporting: false, inked: false })).toBeNull();
    });
  });
});

describe('a grid', () => {
  const grid = {
    spec: tool('image.grid'),
    entry: undefined,
    prompt: '',
    slots: {},
    sourceShown: true,
    source: { width: 400, height: 300 },
    exporting: false,
  };

  // The tiles are laid out in the source's pixels; a press before they are
  // known lays every row at the empty-node height.
  it('holds Run back while the source size is unknown', () => {
    expect(miniToolRefusal({ ...grid, source: {}, params: {} })).toBe('sourceMissing');
  });

  it('refuses one row by one column, which cuts nothing', () => {
    expect(miniToolRefusal({ ...grid, params: { rows: 1, cols: 1 } })).toBe('singleTile');
  });

  it.each([
    [1, 2],
    [2, 1],
  ])('runs at %i by %i', (rows, cols) => {
    expect(miniToolRefusal({ ...grid, params: { rows, cols } })).toBeNull();
  });

  it('runs at the default three by three', () => {
    expect(miniToolRefusal({ ...grid, params: {} })).toBeNull();
  });

  it('runs with a single tile of three by three picked', () => {
    expect(miniToolRefusal({ ...grid, params: { rows: 3, cols: 3, skip: [0, 1, 2, 3, 5, 6, 7, 8] } })).toBeNull();
  });

  it('holds Run back while no tile is picked', () => {
    expect(miniToolRefusal({ ...grid, params: { rows: 3, cols: 3, skip: [0, 1, 2, 3, 4, 5, 6, 7, 8] } })).toBe(
      'noTilePicked',
    );
  });

  it('still calls one by one a single tile, whatever is picked', () => {
    expect(miniToolRefusal({ ...grid, params: { rows: 1, cols: 1, skip: [0] } })).toBe('singleTile');
  });
});

describe.each(['image.adjust', 'video.adjust'])('%s', (id) => {
  const adjust = { spec: tool(id), entry: undefined, prompt: '', slots: {}, sourceShown: true, exporting: false };
  const source = { width: 1600, height: 1000, duration: 8 };

  it('holds Run back while every slider is at zero', () => {
    expect(miniToolRefusal({ ...adjust, source, params: {} })).toBe('adjustNeutral');
    expect(miniToolRefusal({ ...adjust, source, params: { value: { exposure: 0 } } })).toBe('adjustNeutral');
  });

  it('runs once any slider moves', () => {
    expect(miniToolRefusal({ ...adjust, source, params: { value: { grain: 3 } } })).toBeNull();
  });
});

describe('the expand tool', () => {
  const genfill = { ...entry({}, true), max_output_side: 12288 } as ModelEntry;
  const expand = { spec: tool('image.expand'), entry: genfill, prompt: '', slots: {}, sourceShown: true, exporting: false };
  const source = { width: 1600, height: 1000 };
  const grown = { x: -0.25, y: 0, width: 1.5, height: 1 };

  it('takes an empty prompt, since the tool has its own', () => {
    expect(promptRequired(tool('image.expand'), genfill)).toBe(false);
    expect(promptRequired(tool('image.inpaint'), genfill)).toBe(true);
  });

  it('exports the padded picture and its mask before the run', () => {
    expect(exportsBeforeRun(tool('image.expand'))).toBe(true);
  });

  it('holds Run back while the frame is the source itself', () => {
    expect(miniToolRefusal({ ...expand, source, expandFrame: { x: 0, y: 0, width: 1, height: 1 } })).toBe('frameNotExpanded');
    expect(miniToolRefusal({ ...expand, source, expandFrame: grown })).toBeNull();
  });

  it('holds Run back while the frame pads the source by less than a pixel', () => {
    const shot = { width: 1366, height: 768 };
    expect(
      miniToolRefusal({ ...expand, source: shot, expandFrame: { x: 0, y: -0.000244, width: 1, height: 1.000488 } }),
    ).toBe('frameNotExpanded');
  });

  it('says a source too large to grow before it says the frame is not grown', () => {
    expect(
      miniToolRefusal({ ...expand, source: { width: 13000, height: 900 }, expandFrame: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toBe('sourceTooLargeToExpand');
    expect(BLOCKING_REFUSALS.has('sourceTooLargeToExpand')).toBe(false);
  });

  it('stops the frame at the model\'s longest side, and nowhere for a model without one', () => {
    expect(expandCapOf(genfill)).toBe(12288);
    expect(expandCapOf(entry({}, true))).toBe(Infinity);
  });
});

describe('the markup tool', () => {
  const mark = { spec: tool('image.mark'), entry: undefined, prompt: '', slots: {}, sourceShown: true, exporting: false };
  const RECT = { id: 'a', kind: 'rect', color: '#FF3B30', size: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } as const;

  it('holds Run back while nothing is drawn', () => {
    expect(miniToolRefusal({ ...mark, mark: { ...EMPTY_MARK } })).toBe('markEmpty');
  });

  it('runs with one object, or with a text still being typed', () => {
    expect(miniToolRefusal({ ...mark, mark: { ...EMPTY_MARK, objects: [RECT] } })).toBeNull();
    expect(miniToolRefusal({ ...mark, mark: { ...EMPTY_MARK, editingText: 'note' } })).toBeNull();
  });
});

describe('BLOCKING_REFUSALS', () => {
  it('disables Execute for the reasons the reader fixes in the panel', () => {
    expect([...BLOCKING_REFUSALS].sort()).toEqual([
      'adjustNeutral',
      'drawingEmpty',
      'exporting',
      'frameNotExpanded',
      'markEmpty',
      'noTilePicked',
      'promptMissing',
      'singleTile',
      'slotMissing',
    ]);
  });
});

describe('exportsBeforeRun', () => {
  it('holds for a browser tool and a drawing tool, not for a plain server tool', () => {
    expect(exportsBeforeRun(tool('image.rotate'))).toBe(true);
    expect(exportsBeforeRun(tool('image.inpaint'))).toBe(true);
    expect(exportsBeforeRun(tool('image.sketch'))).toBe(true);
    expect(exportsBeforeRun(tool('image.upscale'))).toBe(false);
  });
});

describe('creditMode', () => {
  it('reads the run kind', () => {
    expect(creditMode(tool('image.crop'))).toBe('free');
    expect(creditMode(tool('video.cut'))).toBe('usage');
    expect(creditMode(tool('image.upscale'))).toBe('estimate');
  });
});

describe('crop rectangle', () => {
  const source = { width: 1600, height: 1000 };

  it('reads an aspect choice as a ratio', () => {
    expect(aspectRatioOf('free', source)).toBeNull();
    expect(aspectRatioOf('original', source)).toBe(1.6);
    expect(aspectRatioOf('16:9', source)).toBeCloseTo(16 / 9);
  });

  it('centres the largest rectangle of a ratio', () => {
    expect(rectForAspect(1, source)).toEqual({ x: 300, y: 0, w: 1000, h: 1000 });
  });

  // §13: typing a width with the ratio locked moves the height, and both stay
  // inside the source.
  it('moves the other side with a locked ratio', () => {
    expect(setRectSide({ x: 0, y: 0, w: 800, h: 800 }, 'w', 600, 1, source)).toEqual({ x: 0, y: 0, w: 600, h: 600 });
  });

  it('clamps to the source, keeping the ratio', () => {
    expect(setRectSide({ x: 400, y: 0, w: 800, h: 800 }, 'w', 5000, 1, source)).toEqual({
      x: 400,
      y: 0,
      w: 1000,
      h: 1000,
    });
  });

  it('clamps one side alone when free', () => {
    expect(setRectSide({ x: 100, y: 100, w: 500, h: 500 }, 'h', 2000, null, source)).toEqual({
      x: 100,
      y: 100,
      w: 500,
      h: 900,
    });
  });

  it('never goes under one pixel', () => {
    expect(setRectSide({ x: 0, y: 0, w: 500, h: 500 }, 'w', 0, null, source).w).toBe(1);
  });
});

// inner#1304: what the batch-four tools add to the panel's rules.
describe('batch-four tools', () => {
  const nb = entry(
    {
      images: { description: '', default: null, type: 'list', max_items: 1, accepts: 'image', fill: 'tool' },
      light_reference: { description: '', default: null, accepts: 'image', fill: 'canvas', optional: true },
      light_azimuth: { description: '', default: 315, min: 0, max: 315, step: 45, fill: 'tool', label: 'Light direction' },
      light_elevation: { description: '', default: 30, min: -30, max: 90, step: 30, fill: 'tool', label: 'Light height' },
      light_color: { description: '', default: 'auto', values: ['auto', 'warm'], fill: 'tool', label: 'Colour' },
      resolution: { description: '', default: '1k', values: ['0.5k', '1k', '2k', '4k'], fill: 'tool' },
    },
    true,
  );
  const gpt = entry(
    { style_images: { description: '', default: null, type: 'list', max_items: 3, accepts: 'image', fill: 'canvas', optional: true } },
    true,
  );

  it('runs on the tool\'s own default over the model\'s', () => {
    expect(resolvedParams(tool('image.relight'), nb, {}).resolution).toBe('2k');
    expect(resolvedParams(tool('image.relight'), nb, { resolution: '4k' }).resolution).toBe('4k');
  });

  it('sends no hidden setting once the slot that hides it is filled', () => {
    const draft = { light_azimuth: 90, light_elevation: 0 };
    const empty = resolvedParams(tool('image.relight'), nb, draft, {}, [], {});
    expect(empty).toMatchObject({ light_azimuth: 90, light_elevation: 0 });
    const filled = resolvedParams(tool('image.relight'), nb, draft, {}, [], {
      light_reference: { url: 'https://cdn.example.com/ref.png' },
    });
    expect(filled).not.toHaveProperty('light_azimuth');
    expect(filled).not.toHaveProperty('light_elevation');
    expect(filled.light_color).toBe('auto');
  });

  it('holds a slot the tool requires even where the model lets it stay empty', () => {
    const style = tool('image.restyle').slots[0]!;
    const reference = tool('image.relight').slots[0]!;
    expect(slotOptional(style, gpt)).toBe(false);
    expect(slotOptional(reference, nb)).toBe(true);
    const base = { entry: gpt, prompt: '', slots: {}, sourceShown: true, exporting: false };
    expect(miniToolRefusal({ ...base, spec: tool('image.restyle') })).toBe('slotMissing');
    expect(
      miniToolRefusal({ ...base, spec: tool('image.restyle'), slots: { style: [{ url: 'https://cdn.example.com/s.png' }] } }),
    ).toBeNull();
  });

  it('runs relight and multi-angle with no prompt, and holds quick edit until one is written', () => {
    const base = { entry: nb, prompt: '', slots: {}, sourceShown: true, exporting: false };
    expect(miniToolRefusal({ ...base, spec: tool('image.relight') })).toBeNull();
    expect(miniToolRefusal({ ...base, spec: tool('image.angle') })).toBeNull();
    expect(miniToolRefusal({ ...base, spec: tool('image.quickEdit') })).toBe('promptMissing');
    expect(miniToolRefusal({ ...base, spec: tool('image.quickEdit'), prompt: 'make it night' })).toBeNull();
  });

  it('reads the shown picture for a tool whose ratio the server takes from the source', () => {
    expect(readsShownSize(tool('image.relight'))).toBe(true);
    expect(readsShownSize(tool('image.quickEdit'))).toBe(false);
    expect(readsShownSize(tool('image.upscale'))).toBe(true);
    expect(readsShownSize(tool('image.remove-bg'))).toBe(false);
  });
});
