// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A template's text node (inner#1824, CAP-3): words the user keeps and edits,
 * a script or lyrics, wired out into the pool or the lyrics box of a generate
 * node. Run on fixture templates whose locale strings are injected here.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { templateNodeWords, type GenerationTemplate } from '@shared/canvas/generation-templates.js';
import { expandTemplate, templateNodeDefaults, templateSkeleton, type TemplateExpansionInput } from '@shared/canvas/template-expansion.js';
import { resetLocales, setLocale, setLocaleMessages } from '@shared/i18n/index.js';
import { markedSegments, type ProposalNode } from '@shared/types/canvas-proposal.js';

const SCRIPTED_ID = 'fixture-scripted';
const SUNG_ID = 'fixture-sung';

/** A script wired into the pool of two scenes, the first the anchor and the second downstream of it. */
const SCRIPTED: GenerationTemplate = {
  id: SCRIPTED_ID,
  anchor: 'result',
  nodes: [
    { key: 'script', role: 'written', type: 'text' },
    { key: 'result', role: 'generate', type: 'video', mode: 't2v', model: 'fixture-video', params: { duration: 15 } },
    { key: 'scene-2', role: 'generate', type: 'video', mode: 't2v', model: 'fixture-video', params: { duration: 15 } },
  ],
  edges: [
    { from: 'script', to: 'result', into: 'pool' },
    { from: 'script', to: 'scene-2', into: 'pool' },
    { from: 'result', to: 'scene-2', into: 'pool' },
  ],
  inputs: [],
  steps: [],
  agentNote: 'a fixture two-scene episode from one script',
  goal: 'cinematic',
  triggers: { asks: ['a fixture'], offerWhen: ['a fixture is wanted'] },
};

/** Lyrics wired into a song model's lyrics box. */
const SUNG: GenerationTemplate = {
  id: SUNG_ID,
  anchor: 'result',
  nodes: [
    { key: 'words', role: 'written', type: 'text' },
    { key: 'result', role: 'generate', type: 'audio', mode: 't2m', model: 'fixture-song', params: {} },
  ],
  edges: [{ from: 'words', to: 'result', into: 'lyrics' }],
  inputs: [],
  steps: [],
  agentNote: 'a fixture song from lyrics',
  goal: 'sound',
  triggers: { asks: ['a fixture'], offerWhen: ['a fixture is wanted'] },
};

const SCRIPT_TEXT = 'Who: {✏️ the lead, e.g. a tired nurse}\nScene 1: {✏️ what happens first}\nScene 2: {✏️ what happens next}';
const LYRICS_TEXT = '[Verse]\n{✏️ the first verse}';

beforeEach(() => {
  setLocaleMessages('en', {
    canvas: {
      template: {
        [SCRIPTED_ID]: {
          name: 'Scene 1',
          prompt: 'Play only scene 1 of [📎 Script].',
          node: {
            script: { name: 'Script', text: SCRIPT_TEXT },
            'scene-2': { name: 'Scene 2', prompt: '(💡 Generate Scene 1 first)Play only scene 2 of [📎 Script], going on from [📎 Scene 1].' },
          },
        },
        [SUNG_ID]: {
          name: 'Song',
          prompt: 'A slow piano ballad.',
          node: { words: { name: 'Lyrics', text: LYRICS_TEXT } },
        },
      },
    },
  });
  setLocale('en');
});

afterAll(() => {
  resetLocales();
});

/** Fresh expansion around an anchor at 0: nothing on the canvas yet. */
const FRESH: TemplateExpansionInput = { anchorAt: 0, base: 1, inputs: new Map(), wired: [], reuse: new Map(), guide: false };

describe('a template text node (inner#1824, CAP-3)', () => {
  it('keeps its words under node.<key>.text, which every reader takes from templateNodeWords', () => {
    expect(templateNodeWords(SCRIPTED, 'script')).toEqual({ prompt: 'node.script.text' });
    expect(templateNodeWords(SCRIPTED, 'scene-2')).toEqual({ prompt: 'node.scene-2.prompt' });
  });

  it('stands in the skeleton as a written text node', () => {
    expect(templateSkeleton(SCRIPTED).nodes.get('script')).toEqual({ role: 'written', type: 'text' });
  });

  it('takes no mode, model or params from the template', () => {
    const sent: ProposalNode = { role: 'written', type: 'text', name: 'Script', prompt: [{ text: 'Who: a nurse' }] };
    expect(templateNodeDefaults(SCRIPTED, 'script', sent)).toEqual(sent);
  });

  it('is placed holding its words, the blanks as fill-in segments, tagged, and wired into the pool of each scene that @s it', () => {
    const result = expandTemplate(SCRIPTED, FRESH);
    const at = result.appended.findIndex((node) => node.templateNode?.key === 'script');
    expect(result.appended[at]).toEqual({
      role: 'written',
      type: 'text',
      name: 'Script',
      prompt: markedSegments(SCRIPT_TEXT),
      templateNode: { template: SCRIPTED_ID, key: 'script' },
    });
    const script = FRESH.base + at;
    const scene = FRESH.base + result.appended.findIndex((node) => node.templateNode?.key === 'scene-2');
    expect(result.edges).toEqual([
      { fromIndex: script, toIndex: 0, into: 'pool' },
      { fromIndex: script, toIndex: scene, into: 'pool' },
      { fromIndex: 0, toIndex: scene, into: 'pool' },
    ]);
    expect(result.rewritten.get(0)?.prompt).toEqual([{ text: 'Play only scene 1 of ' }, { ref: script }, { text: '.' }]);
    // The anchor wired into a downstream pool is @'d by the anchor's own name.
    expect(result.appended[scene - FRESH.base]?.prompt).toEqual([
      { slot: { kind: 'note', label: 'Generate Scene 1 first' } },
      { text: 'Play only scene 2 of ' },
      { ref: script },
      { text: ', going on from ' },
      { ref: 0 },
      { text: '.' },
    ]);
  });

  it('keeps what the user wrote in a text node it reuses, and wires it as the template does', () => {
    // 0 the anchor, 1 the user's script.
    const result = expandTemplate(SCRIPTED, { ...FRESH, base: 2, reuse: new Map([['script', 1]]) });
    expect(result.rewritten.has(1)).toBe(false);
    expect(result.appended.some((node) => node.templateNode?.key === 'script')).toBe(false);
    expect(result.edges).toContainEqual({ fromIndex: 1, toIndex: 0, into: 'pool' });
    expect(result.rewritten.get(0)?.prompt).toEqual([{ text: 'Play only scene 1 of ' }, { ref: 1 }, { text: '.' }]);
  });

  it('goes into a song model\'s lyrics box by its edge, with no mention in the prompt', () => {
    const result = expandTemplate(SUNG, FRESH);
    expect(result.appended).toEqual([
      { role: 'written', type: 'text', name: 'Lyrics', prompt: markedSegments(LYRICS_TEXT), templateNode: { template: SUNG_ID, key: 'words' } },
    ]);
    expect(result.edges).toEqual([{ fromIndex: 1, toIndex: 0, into: 'lyrics' }]);
    expect(result.rewritten.get(0)?.prompt).toEqual([{ text: 'A slow piano ballad.' }]);
  });
});
