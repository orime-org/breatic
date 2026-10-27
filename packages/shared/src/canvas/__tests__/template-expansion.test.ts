// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a generation template becomes nodes (inner#1345): the skeleton, one
 * node's defaults, which nodes on a graph belong to one applied instance, the
 * guide text node and the panel's expansion. Run on a fixture template whose
 * locale strings are injected here, so the registry's own templates stay out.
 */

import fc from 'fast-check';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { GenerationTemplate, TemplateNodeKey } from '@shared/canvas/generation-templates.js';
import {
  TEMPLATE_GUIDE_KEY,
  expandTemplate,
  matchTemplateInstance,
  templateGuideNode,
  templateNodeDefaults,
  templateMarkTargets,
  templateSkeleton,
  type TemplateExpansionInput,
  type TemplateExpansionResult,
  type TemplateGraph,
  type TemplateGraphNode,
  type TemplateSkeleton,
} from '@shared/canvas/template-expansion.js';
import { resetLocales, setLocale, setLocaleMessages } from '@shared/i18n/index.js';
import {
  promptPlainText,
  type ProposalNode,
  type ProposalNodeType,
  type PromptSegment,
} from '@shared/types/canvas-proposal.js';
import type { GenerationNodeType } from '@shared/types/model-catalog.js';

const ID = 'fixture-flow';

/**
 * The multi-node fixture of the design's 6.9: an upstream generate node
 * feeding the anchor through a slot edge, a resource wired only into the
 * upstream node, an input feeding only the upstream node, two same-type
 * inputs feeding the anchor, one input feeding both, and two steps.
 */
const FIXTURE: GenerationTemplate = {
  id: ID,
  anchor: 'final',
  nodes: [
    { key: 'final', role: 'generate', type: 'image', mode: 'i2i', model: 'fixture-image', params: { aspect_ratio: '16:9' } },
    { key: 'sheet', role: 'generate', type: 'image', mode: 'i2i', model: 'fixture-image', params: { aspect_ratio: '1:1' } },
    { key: 'style', role: 'source', type: 'image', resource: `templates/${ID}/style.png` },
  ],
  edges: [
    { from: 'style', to: 'sheet', into: 'pool' },
    { from: 'sheet', to: 'final', into: 'reference_image' },
  ],
  inputs: [
    { key: 'pose', type: 'image', feeds: ['sheet'] },
    { key: 'hero', type: 'image' },
    { key: 'place', type: 'image' },
    { key: 'palette', type: 'image', feeds: ['sheet', 'final'] },
  ],
  steps: ['split', 'animate'],
  agentNote: 'a fixture flow',
};

/** The fixture's strings; input names equal their keys so an appended input node names itself. */
function fixtureMessages(suffix: string): Record<string, unknown> {
  return {
    canvas: {
      template: {
        [ID]: {
          name: `Fixture flow${suffix}`,
          prompt: 'Light [📎 hero] in [📎 place] with [📎 palette]. {✏️ the mood}',
          node: {
            sheet: { name: 'Hero sheet', prompt: 'Draw [📎 pose] in [📎 house style] with [📎 palette].' },
            style: { name: 'house style' },
          },
          input: {
            pose: { name: 'pose', note: 'Drop a pose photo first' },
            hero: { name: 'hero', note: 'Drop the hero first' },
            place: { name: 'place', note: 'Drop the place first' },
            palette: { name: 'palette', note: 'Drop a palette first' },
          },
          step: { split: `Split the grid into nine${suffix}`, animate: `Animate each panel${suffix}` },
        },
      },
    },
  };
}

/** The fixture's skeleton, written out by hand so the match tests do not lean on `templateSkeleton`. */
const SKELETON: TemplateSkeleton = {
  id: ID,
  anchor: 'final',
  nodes: new Map([
    ['final', { role: 'generate', type: 'image' }],
    ['sheet', { role: 'generate', type: 'image' }],
    ['style', { role: 'source', type: 'image', resource: `templates/${ID}/style.png` }],
  ]),
  edges: [
    { from: 'style', to: 'sheet', into: 'pool' },
    { from: 'sheet', to: 'final', into: 'reference_image' },
  ],
  inputs: [
    { key: 'pose', type: 'image', feeds: ['sheet'] },
    { key: 'hero', type: 'image', feeds: ['final'] },
    { key: 'place', type: 'image', feeds: ['final'] },
    { key: 'palette', type: 'image', feeds: ['sheet', 'final'] },
  ],
  steps: ['split', 'animate'],
};

beforeEach(() => {
  setLocaleMessages('en', fixtureMessages(''));
  setLocaleMessages('zh-CN', fixtureMessages(' (zh)'));
  setLocale('en');
});

afterAll(() => {
  resetLocales();
});

const note = (label: string): PromptSegment => ({ slot: { kind: 'note', label } });
const tweak = (label: string): PromptSegment => ({ slot: { kind: 'tweak', label, note: label } });

describe('templateSkeleton', () => {
  it('gives every node, edge, input with its fed nodes, resource and step by key', () => {
    expect(templateSkeleton(FIXTURE)).toEqual(SKELETON);
  });
});

describe('templateNodeDefaults', () => {
  const sent: ProposalNode = { role: 'generate', type: 'image', name: 'Mine', prompt: [{ text: 'my words' }] };

  it('fills the anchor with the template mode, model and params and keeps what was sent', () => {
    expect(templateNodeDefaults(FIXTURE, undefined, sent)).toEqual({
      ...sent,
      mode: 'i2i',
      model: 'fixture-image',
      params: { aspect_ratio: '16:9' },
    });
  });

  it('fills a non-anchor generate node from its own key', () => {
    expect(templateNodeDefaults(FIXTURE, 'sheet', sent)).toEqual({
      ...sent,
      mode: 'i2i',
      model: 'fixture-image',
      params: { aspect_ratio: '1:1' },
    });
  });

  it('lets written params win over the template params while the mode and model are kept', () => {
    const node = templateNodeDefaults(FIXTURE, undefined, { ...sent, mode: 'i2i', params: { aspect_ratio: '4:3', seed: 7 } });
    expect(node.params).toEqual({ aspect_ratio: '4:3', seed: 7 });
  });

  it('drops the template params once the model is changed', () => {
    const node = templateNodeDefaults(FIXTURE, undefined, { ...sent, model: 'another-model', params: { seed: 7 } });
    expect(node).toEqual({ ...sent, mode: 'i2i', model: 'another-model', params: { seed: 7 } });
    const bare = templateNodeDefaults(FIXTURE, undefined, { ...sent, mode: 't2i' });
    expect(bare).toEqual({ ...sent, mode: 't2i', model: 'fixture-image' });
  });

  it('fills a resource node with its storage path', () => {
    const source: ProposalNode = { role: 'source', type: 'image', name: 'house style' };
    expect(templateNodeDefaults(FIXTURE, 'style', source)).toEqual({ ...source, resource: `templates/${ID}/style.png` });
  });

  it('never writes templateNode', () => {
    expect('templateNode' in templateNodeDefaults(FIXTURE, 'sheet', sent)).toBe(false);
    expect('templateNode' in templateNodeDefaults(FIXTURE, undefined, sent)).toBe(false);
  });
});

// ── matchTemplateInstance ────────────────────────────────────────────────

/** A node with no tag, kept on the template's settings. */
const plain = (id: string, type: ProposalNodeType = 'image'): TemplateGraphNode => ({ id, type, keeps: true });

/** A node tagged as one template key. */
const tagged = (id: string, key: TemplateNodeKey, type: ProposalNodeType = 'image', template = ID): TemplateGraphNode => ({
  id,
  type,
  tag: { template, key },
  keeps: true,
});

type GraphEdge = readonly [from: string, to: string, into?: string];

/**
 * A graph from nodes and edges, each node's incoming edges in the order given.
 * @param nodes - The nodes.
 * @param edges - The edges, in order.
 * @returns The graph a match reads.
 */
function graphOf(nodes: readonly TemplateGraphNode[], edges: readonly GraphEdge[]): TemplateGraph {
  const incoming = new Map<string, Array<{ from: string; into?: string }>>();
  for (const [from, to, into] of edges) {
    const list = incoming.get(to) ?? [];
    list.push(into === undefined ? { from } : { from, into });
    incoming.set(to, list);
  }
  return { nodes: new Map(nodes.map((node) => [node.id, node])), incoming };
}

/**
 * One complete instance of the fixture, every id ending in `suffix`.
 * @param suffix - Appended to every id.
 * @returns Its nodes and edges.
 */
function instance(suffix: string): { nodes: TemplateGraphNode[]; edges: GraphEdge[] } {
  const id = (name: string): string => `${name}${suffix}`;
  return {
    nodes: [
      plain(id('A')),
      tagged(id('S'), 'sheet'),
      tagged(id('R'), 'style'),
      plain(id('P')),
      plain(id('H')),
      plain(id('L')),
      plain(id('C')),
    ],
    edges: [
      [id('R'), id('S'), 'pool'],
      [id('P'), id('S'), 'pool'],
      [id('C'), id('S'), 'pool'],
      [id('S'), id('A'), 'reference_image'],
      [id('H'), id('A'), 'pool'],
      [id('L'), id('A'), 'pool'],
      [id('C'), id('A'), 'pool'],
    ],
  };
}

const FULL = instance('');

const byFrom = <T extends { from: string; to?: string }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => a.from.localeCompare(b.from) || (a.to ?? '').localeCompare(b.to ?? ''));
const byInputAndFed = <T extends { input: string; fed: string }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => `${a.input}/${a.fed}`.localeCompare(`${b.input}/${b.fed}`));

describe('matchTemplateInstance', () => {
  it('matches a complete instance: every key, the walked edges, every input and nothing missing', () => {
    const match = matchTemplateInstance(SKELETON, graphOf(FULL.nodes, FULL.edges), 'A');
    expect(match.keys).toEqual(
      new Map([
        ['sheet', { kind: 'one', node: 'S' }],
        ['style', { kind: 'one', node: 'R' }],
      ]),
    );
    expect(match.inputs).toEqual(
      new Map([
        ['pose', new Map([['sheet', 'P']])],
        ['hero', new Map([['final', 'H']])],
        ['place', new Map([['final', 'L']])],
        ['palette', new Map([['sheet', 'C'], ['final', 'C']])],
      ]),
    );
    expect(match.unassigned).toEqual([]);
    expect(match.candidates).toEqual(new Map());
  });

  it('carries each walked template edge with its own into', () => {
    const match = matchTemplateInstance(SKELETON, graphOf(FULL.nodes, FULL.edges), 'A');
    expect(byFrom(match.walked)).toEqual([
      { from: 'sheet', to: 'final', into: 'reference_image' },
      { from: 'style', to: 'sheet', into: 'pool' },
    ]);
  });

  it('assigns an input that feeds only the upstream node among that node’s incoming edges', () => {
    const match = matchTemplateInstance(SKELETON, graphOf(FULL.nodes, FULL.edges), 'A');
    expect(match.inputs.get('pose')).toEqual(new Map([['sheet', 'P']]));
  });

  it('assigns one input feeding two nodes the same node on both', () => {
    const match = matchTemplateInstance(SKELETON, graphOf(FULL.nodes, FULL.edges), 'A');
    expect(match.inputs.get('palette')).toEqual(new Map([['sheet', 'C'], ['final', 'C']]));
  });

  it('does not take the earlier instance’s nodes when two instances are chained', () => {
    const first = instance('1');
    const second = instance('2');
    // The first anchor stands where the second instance's hero input stood.
    const nodes = [...first.nodes, ...second.nodes.filter((node) => node.id !== 'H2')];
    const edges: GraphEdge[] = [
      ...first.edges,
      ...second.edges.map((edge): GraphEdge => (edge[0] === 'H2' ? ['A1', 'A2', 'pool'] : edge)),
    ];
    const graph = graphOf(nodes, edges);
    const later = matchTemplateInstance(SKELETON, graph, 'A2');
    expect(later.keys).toEqual(
      new Map([
        ['sheet', { kind: 'one', node: 'S2' }],
        ['style', { kind: 'one', node: 'R2' }],
      ]),
    );
    expect(later.inputs.get('hero')).toEqual(new Map([['final', 'A1']]));
    const earlier = matchTemplateInstance(SKELETON, graph, 'A1');
    expect(earlier.keys).toEqual(
      new Map([
        ['sheet', { kind: 'one', node: 'S1' }],
        ['style', { kind: 'one', node: 'R1' }],
      ]),
    );
  });

  it('does not recognise a copied tagged node that is not wired in', () => {
    const graph = graphOf([...FULL.nodes, tagged('S-copy', 'sheet'), tagged('R-copy', 'style')], FULL.edges);
    const match = matchTemplateInstance(SKELETON, graph, 'A');
    expect(match.keys).toEqual(
      new Map([
        ['sheet', { kind: 'one', node: 'S' }],
        ['style', { kind: 'one', node: 'R' }],
      ]),
    );
  });

  it('reports many candidates when one key has two', () => {
    const graph = graphOf(
      [...FULL.nodes, tagged('S-twin', 'sheet')],
      [...FULL.edges, ['S-twin', 'A', 'reference_image']],
    );
    const match = matchTemplateInstance(SKELETON, graph, 'A');
    expect(match.keys.get('sheet')).toEqual({ kind: 'many', nodes: ['S', 'S-twin'] });
  });

  it('assigns two same-type inputs one node each in declaration order and leaves the second without one when only one node is there', () => {
    const nodes = [plain('A'), tagged('S', 'sheet'), tagged('R', 'style'), plain('P'), plain('H')];
    const edges: GraphEdge[] = [
      ['R', 'S', 'pool'],
      ['P', 'S', 'pool'],
      ['S', 'A', 'reference_image'],
      ['H', 'A', 'pool'],
    ];
    const match = matchTemplateInstance(SKELETON, graphOf(nodes, edges), 'A');
    expect(match.inputs.get('hero')).toEqual(new Map([['final', 'H']]));
    expect(match.inputs.get('place')?.get('final')).toBe(undefined);
    expect(byInputAndFed(match.unassigned)).toEqual([
      { input: 'palette', fed: 'final' },
      { input: 'palette', fed: 'sheet' },
      { input: 'place', fed: 'final' },
    ]);
  });

  it('gives a node tagged by another template to an input', () => {
    const nodes = FULL.nodes.map((node) => (node.id === 'H' ? tagged('H', 'sheet', 'image', 'other-template') : node));
    const match = matchTemplateInstance(SKELETON, graphOf(nodes, FULL.edges), 'A');
    expect(match.inputs.get('hero')).toEqual(new Map([['final', 'H']]));
  });

  it('puts a node tagged for an input ahead of the incoming order', () => {
    const forHero: TemplateGraphNode = { id: 'Y', type: 'image', inputTag: { template: ID, input: 'hero' }, keeps: true };
    const nodes = [plain('A'), forHero, plain('X'), ...FULL.nodes.filter((node) => !['A', 'H', 'L'].includes(node.id))];
    const edges: GraphEdge[] = [
      ['R', 'S', 'pool'],
      ['P', 'S', 'pool'],
      ['C', 'S', 'pool'],
      ['S', 'A', 'reference_image'],
      ['X', 'A', 'pool'],
      ['Y', 'A', 'pool'],
      ['C', 'A', 'pool'],
    ];
    const match = matchTemplateInstance(SKELETON, graphOf(nodes, edges), 'A');
    expect(match.inputs.get('hero')).toEqual(new Map([['final', 'Y']]));
    expect(match.inputs.get('place')).toEqual(new Map([['final', 'X']]));
  });

  it('treats a key behind a node that left the template settings as unreached, not missing', () => {
    const nodes = FULL.nodes.map((node) => (node.id === 'S' ? { ...node, keeps: false } : node));
    const edges = FULL.edges.filter(([from]) => from !== 'R');
    const match = matchTemplateInstance(SKELETON, graphOf(nodes, edges), 'A');
    expect(match.keys).toEqual(
      new Map([
        ['sheet', { kind: 'one', node: 'S' }],
        ['style', { kind: 'unreached' }],
      ]),
    );
    expect(match.walked).toEqual([{ from: 'sheet', to: 'final', into: 'reference_image' }]);
    expect(match.candidates).toEqual(new Map());
  });

  it('reaches no key when the anchor itself left the template settings', () => {
    const nodes = FULL.nodes.map((node) => (node.id === 'A' ? { ...node, keeps: false } : node));
    const match = matchTemplateInstance(SKELETON, graphOf(nodes, FULL.edges), 'A');
    expect(match.keys).toEqual(
      new Map([
        ['sheet', { kind: 'unreached' }],
        ['style', { kind: 'unreached' }],
      ]),
    );
    expect(match.walked).toEqual([]);
  });

  it('lists the one unwired tagged node as the candidate of a key whose edge is missing', () => {
    const edges = FULL.edges.filter(([from]) => from !== 'R');
    const match = matchTemplateInstance(SKELETON, graphOf(FULL.nodes, edges), 'A');
    expect(match.keys.get('style')).toEqual({ kind: 'missing' });
    expect(match.candidates).toEqual(new Map([['style', ['R']]]));
  });

  it('lists as candidates of a missing key only the same-type tagged nodes no instance claims', () => {
    const first = instance('1');
    const nodes = [
      ...first.nodes,
      plain('A2'),
      plain('L2'),
      tagged('S-loose', 'sheet'),
      tagged('S-video', 'sheet', 'video'),
    ];
    const edges: GraphEdge[] = [...first.edges, ['A1', 'A2', 'pool'], ['L2', 'A2', 'pool']];
    const match = matchTemplateInstance(SKELETON, graphOf(nodes, edges), 'A2');
    expect(match.keys.get('sheet')).toEqual({ kind: 'missing' });
    expect(match.candidates.get('sheet')).toEqual(['S-loose']);
  });
});

describe('matchTemplateInstance, round-1 review (inner#1345)', () => {
  it('gives an input fed into two nodes the node wired into both, ahead of inputs fed into one', () => {
    // The palette node sits first among the anchor's references, where the
    // hero input would take it if inputs were served in declaration order alone.
    const edges: GraphEdge[] = [
      ['R', 'S', 'pool'],
      ['P', 'S', 'pool'],
      ['C', 'S', 'pool'],
      ['S', 'A', 'reference_image'],
      ['C', 'A', 'pool'],
      ['H', 'A', 'pool'],
      ['L', 'A', 'pool'],
    ];
    const match = matchTemplateInstance(SKELETON, graphOf(FULL.nodes, edges), 'A');
    expect(match.inputs.get('palette')).toEqual(new Map([['sheet', 'C'], ['final', 'C']]));
    expect(match.inputs.get('hero')).toEqual(new Map([['final', 'H']]));
    expect(match.inputs.get('place')).toEqual(new Map([['final', 'L']]));
    expect(match.unassigned).toEqual([]);
  });

  it('walks every template edge out of a node that feeds two, and lists the one not wired', () => {
    const fan: TemplateSkeleton = {
      id: 'fan',
      anchor: 'a',
      nodes: new Map([
        ['a', { role: 'generate', type: 'image' }],
        ['u', { role: 'generate', type: 'image' }],
        ['x', { role: 'source', type: 'image', resource: 'templates/fan/x.png' }],
      ]),
      edges: [
        { from: 'x', to: 'u', into: 'pool' },
        { from: 'x', to: 'a', into: 'pool' },
        { from: 'u', to: 'a', into: 'pool' },
      ],
      inputs: [],
      steps: [],
    };
    const nodes: TemplateGraphNode[] = [plain('A'), tagged('U', 'u', 'image', 'fan'), tagged('X', 'x', 'image', 'fan')];
    const match = matchTemplateInstance(fan, graphOf(nodes, [['X', 'A', 'pool'], ['U', 'A', 'pool']]), 'A');
    expect(match.keys.get('x')).toEqual({ kind: 'one', node: 'X' });
    expect(byFrom(match.walked)).toEqual([
      { from: 'u', to: 'a', into: 'pool' },
      { from: 'x', to: 'a', into: 'pool' },
      { from: 'x', to: 'u', into: 'pool' },
    ]);
    expect(match.unwired).toEqual([{ from: 'x', to: 'u', into: 'pool' }]);
  });

  it('lists the edge into the anchor as not wired when the node is wired only further up', () => {
    const fan: TemplateSkeleton = {
      id: 'fan',
      anchor: 'a',
      nodes: new Map([
        ['a', { role: 'generate', type: 'image' }],
        ['u', { role: 'generate', type: 'image' }],
        ['x', { role: 'source', type: 'image', resource: 'templates/fan/x.png' }],
      ]),
      edges: [
        { from: 'x', to: 'u', into: 'pool' },
        { from: 'x', to: 'a', into: 'pool' },
        { from: 'u', to: 'a', into: 'pool' },
      ],
      inputs: [],
      steps: [],
    };
    const nodes: TemplateGraphNode[] = [plain('A'), tagged('U', 'u', 'image', 'fan'), tagged('X', 'x', 'image', 'fan')];
    const match = matchTemplateInstance(fan, graphOf(nodes, [['X', 'U', 'pool'], ['U', 'A', 'pool']]), 'A');
    expect(match.keys.get('x')).toEqual({ kind: 'one', node: 'X' });
    expect(match.unwired).toEqual([{ from: 'x', to: 'a', into: 'pool' }]);
  });

  it('ends on a template whose edges run in a circle', () => {
    const circle: TemplateSkeleton = {
      id: 'circle',
      anchor: 'a',
      nodes: new Map([
        ['a', { role: 'generate', type: 'image' }],
        ['u', { role: 'generate', type: 'image' }],
        ['v', { role: 'generate', type: 'image' }],
      ]),
      edges: [
        { from: 'u', to: 'a' },
        { from: 'v', to: 'u' },
        { from: 'u', to: 'v' },
      ],
      inputs: [],
      steps: [],
    };
    const match = matchTemplateInstance(circle, graphOf([plain('A')], []), 'A');
    expect(match.keys.get('u')).toEqual({ kind: 'unreached' });
    expect(match.keys.get('v')).toEqual({ kind: 'unreached' });
  });
});

describe('matchTemplateInstance, round-3 review (inner#1345)', () => {
  /**
   * A skeleton of image generate nodes, `a` the anchor.
   * @param keys - The non-anchor keys.
   * @param edges - The template edges, in order.
   * @returns The skeleton.
   */
  const chain = (keys: readonly string[], edges: ReadonlyArray<readonly [string, string]>): TemplateSkeleton => ({
    id: 'chain',
    anchor: 'a',
    nodes: new Map(['a', ...keys].map((key) => [key, { role: 'generate', type: 'image' }])),
    edges: edges.map(([from, to]) => ({ from, to })),
    inputs: [],
    steps: [],
  });

  it('settles a key behind a node that left the settings the same whatever order the template lists its edges', () => {
    // X is tagged but left the settings and is wired only into U; there is no Y.
    const nodes: TemplateGraphNode[] = [plain('A'), tagged('U', 'u', 'image', 'chain'), { ...tagged('X', 'x', 'image', 'chain'), keeps: false }];
    const graph = graphOf(nodes, [['U', 'A'], ['X', 'U']]);
    for (const order of [
      [['x', 'a'], ['u', 'a'], ['x', 'u'], ['y', 'x']],
      [['u', 'a'], ['x', 'a'], ['x', 'u'], ['y', 'x']],
    ] as const) {
      const match = matchTemplateInstance(chain(['u', 'x', 'y'], order), graph, 'A');
      expect(match.keys.get('x')).toEqual({ kind: 'one', node: 'X' });
      expect(match.keys.get('y')).toEqual({ kind: 'unreached' });
    }
  });

  it('settles every key the same whatever order the template lists its edges, one node per key', () => {
    const drawArb = fc
      .record({
        // Key k<i> is wired into earlier keys only, so the template has no circle.
        outs: fc.array(fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 4 }),
        present: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        keeps: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
        wires: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 8 }),
      })
      .chain((draw) => {
        const edges = [
          ...new Set(draw.outs.flatMap((outs, i) => outs.map((n) => `k${String(i + 1)}>${n % (i + 1) === 0 ? 'a' : `k${String(n % (i + 1))}`}`))),
        ].map((pair) => pair.split('>') as [string, string]);
        return fc.tuple(fc.constant(draw), fc.constant(edges), fc.shuffledSubarray(edges, { minLength: edges.length, maxLength: edges.length }));
      });
    fc.assert(
      fc.property(drawArb, ([draw, edges, shuffled]) => {
        const keys = draw.outs.map((_, i) => `k${String(i + 1)}`);
        const idOf = (i: number): string => (i === 0 ? 'A' : `N${String(i)}`);
        const nodes: TemplateGraphNode[] = [
          { ...plain('A'), keeps: draw.keeps[0] ?? true },
          ...keys.flatMap((key, i) =>
            draw.present[i] === false ? [] : [{ ...tagged(idOf(i + 1), key, 'image', 'chain'), keeps: draw.keeps[i + 1] ?? true }],
          ),
        ];
        const ids = new Set(nodes.map((node) => node.id));
        const wires: GraphEdge[] = [
          ...new Set(
            draw.wires
              .map(([from, to]) => [1 + (from % keys.length), to % (1 + (from % keys.length))] as const)
              .map(([from, to]) => `${idOf(from)}>${idOf(to)}`),
          ),
        ]
          .map((pair) => pair.split('>') as [string, string])
          .filter(([from, to]) => ids.has(from) && ids.has(to));
        const graph = graphOf(nodes, wires);
        const one = matchTemplateInstance(chain(keys, edges), graph, 'A');
        const other = matchTemplateInstance(chain(keys, shuffled), graph, 'A');
        expect(other.keys).toEqual(one.keys);
        expect(byFrom(other.unwired)).toEqual(byFrom(one.unwired));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('templateMarkTargets', () => {
  it('names the inputs a node is fed and the template nodes wired into its pool, an edge with no into among them', () => {
    const noInto: GenerationTemplate = { ...FIXTURE, edges: [{ from: 'style', to: 'sheet' }, { from: 'sheet', to: 'final', into: 'reference_image' }] };
    expect(templateMarkTargets(noInto, 'sheet')).toEqual(
      new Map([
        ['pose', { input: 'pose' }],
        ['palette', { input: 'palette' }],
        ['house style', { node: 'style' }],
      ]),
    );
    expect(templateMarkTargets(FIXTURE, 'final')).toEqual(
      new Map([
        ['hero', { input: 'hero' }],
        ['place', { input: 'place' }],
        ['palette', { input: 'palette' }],
      ]),
    );
  });
});

// ── templateGuideNode ────────────────────────────────────────────────────

describe('templateGuideNode', () => {
  it('gives a written text node named after the template with the numbered steps under the name', () => {
    const guide = templateGuideNode(FIXTURE, 3);
    expect(guide).toMatchObject({
      role: 'written',
      type: 'text',
      name: 'Fixture flow',
      templateNode: { template: ID, key: TEMPLATE_GUIDE_KEY, anchor: 3 },
    });
    expect(guide?.templateNode).toEqual({ template: ID, key: 'guide', anchor: 3 });
    expect(promptPlainText(guide?.prompt ?? [])).toBe('Fixture flow\n1. Split the grid into nine\n2. Animate each panel');
  });

  it('writes the guide in the reader’s language', () => {
    setLocale('zh-CN');
    const guide = templateGuideNode(FIXTURE, 0);
    expect(guide?.name).toBe('Fixture flow (zh)');
    expect(promptPlainText(guide?.prompt ?? [])).toBe(
      'Fixture flow (zh)\n1. Split the grid into nine (zh)\n2. Animate each panel (zh)',
    );
  });

  it('gives nothing for a template without steps', () => {
    expect(templateGuideNode({ ...FIXTURE, steps: [] }, 0)).toBe(undefined);
  });
});

// ── expandTemplate ───────────────────────────────────────────────────────

/** Fresh expansion around an anchor at 0: nothing on the canvas yet. */
const FRESH: TemplateExpansionInput = {
  anchorAt: 0,
  base: 1,
  inputs: new Map(),
  wired: [],
  reuse: new Map(),
  guide: true,
};

/**
 * Names each index of an expansion by what it stands for: a template key, an
 * input key (the fixture's input names equal their keys) or the guide.
 * @param result - The expansion.
 * @param base - Where appended nodes start.
 * @param known - The caller's own indices, by identity.
 * @returns The identity of an index.
 */
function identityIn(result: TemplateExpansionResult, base: number, known: Readonly<Record<number, string>>): (index: number) => string {
  return (index) => {
    const own = known[index];
    if (own !== undefined) return own;
    const node = result.appended[index - base];
    if (node === undefined) return `<no node at ${String(index)}>`;
    return node.templateNode?.key ?? node.name;
  };
}

/** Edges by identity. */
function edgesBy(result: TemplateExpansionResult, who: (index: number) => string): Array<{ from: string; to: string; into?: string }> {
  return result.edges.map((edge) => ({ from: who(edge.fromIndex), to: who(edge.toIndex), ...(edge.into === undefined ? {} : { into: edge.into }) }));
}

/** A prompt with each ref named by identity. */
function promptBy(node: ProposalNode | undefined, who: (index: number) => string): unknown[] {
  return (node?.prompt ?? []).map((segment) => (segment.ref === undefined ? segment : { ref: who(segment.ref) }));
}

/** The appended node standing for an identity. */
function appendedAs(result: TemplateExpansionResult, base: number, identity: string): ProposalNode | undefined {
  const who = identityIn(result, base, {});
  return result.appended.find((_, i) => who(base + i) === identity);
}

describe('expandTemplate', () => {
  it('appends every template node, an empty node per input and the guide, wired template edges first then inputs in declaration order', () => {
    const result = expandTemplate(FIXTURE, FRESH);
    const who = identityIn(result, 1, { 0: 'final' });
    expect(result.appended.map((_, i) => who(1 + i)).sort()).toEqual(
      ['guide', 'hero', 'palette', 'place', 'pose', 'sheet', 'style'],
    );
    expect(edgesBy(result, who)).toEqual([
      { from: 'style', to: 'sheet', into: 'pool' },
      { from: 'sheet', to: 'final', into: 'reference_image' },
      { from: 'pose', to: 'sheet', into: 'pool' },
      { from: 'hero', to: 'final', into: 'pool' },
      { from: 'place', to: 'final', into: 'pool' },
      { from: 'palette', to: 'sheet', into: 'pool' },
      { from: 'palette', to: 'final', into: 'pool' },
    ]);
  });

  it('fills the anchor from the template and binds its marks by name, the notes of its new inputs on top', () => {
    const result = expandTemplate(FIXTURE, FRESH);
    const anchor = result.rewritten.get(0);
    expect(anchor).toMatchObject({ mode: 'i2i', model: 'fixture-image', params: { aspect_ratio: '16:9' } });
    expect(promptBy(anchor, identityIn(result, 1, { 0: 'final' }))).toEqual([
      note('Drop the hero first'),
      note('Drop the place first'),
      note('Drop a palette first'),
      { text: 'Light ' },
      { ref: 'hero' },
      { text: ' in ' },
      { ref: 'place' },
      { text: ' with ' },
      { ref: 'palette' },
      { text: '. ' },
      tweak('the mood'),
    ]);
  });

  it('names and fills the upstream generate node from the locale and binds a mark to the resource wired into it', () => {
    const result = expandTemplate(FIXTURE, FRESH);
    const sheet = appendedAs(result, 1, 'sheet');
    expect(sheet).toMatchObject({
      role: 'generate',
      type: 'image',
      name: 'Hero sheet',
      mode: 'i2i',
      model: 'fixture-image',
      params: { aspect_ratio: '1:1' },
    });
    expect(promptBy(sheet, identityIn(result, 1, { 0: 'final' }))).toEqual([
      note('Drop a pose photo first'),
      note('Drop a palette first'),
      { text: 'Draw ' },
      { ref: 'pose' },
      { text: ' in ' },
      { ref: 'style' },
      { text: ' with ' },
      { ref: 'palette' },
      { text: '.' },
    ]);
  });

  it('writes templateNode on non-anchor template nodes only, never on the anchor or a new input node', () => {
    const result = expandTemplate(FIXTURE, FRESH);
    expect(result.rewritten.get(0)?.templateNode).toBe(undefined);
    expect(appendedAs(result, 1, 'sheet')?.templateNode).toEqual({ template: ID, key: 'sheet' });
    expect(appendedAs(result, 1, 'style')).toEqual({
      role: 'source',
      type: 'image',
      name: 'house style',
      resource: `templates/${ID}/style.png`,
      templateNode: { template: ID, key: 'style' },
    });
    for (const input of ['pose', 'hero', 'place', 'palette']) {
      expect(appendedAs(result, 1, input)).toEqual({ role: 'source', type: 'image', name: input });
    }
  });

  it('appends the guide node unwired, pointing at the anchor index', () => {
    const result = expandTemplate(FIXTURE, FRESH);
    const guideAt = result.appended.findIndex((node) => node.templateNode?.key === 'guide');
    const guide = result.appended[guideAt];
    expect(guide).toMatchObject({ role: 'written', type: 'text', name: 'Fixture flow', templateNode: { template: ID, key: 'guide', anchor: 0 } });
    expect(promptPlainText(guide?.prompt ?? [])).toBe('Fixture flow\n1. Split the grid into nine\n2. Animate each panel');
    expect(result.edges.filter((edge) => edge.fromIndex === 1 + guideAt || edge.toIndex === 1 + guideAt)).toEqual([]);
  });

  it('appends no guide node when guide is false', () => {
    const result = expandTemplate(FIXTURE, { ...FRESH, guide: false });
    expect(result.appended).toHaveLength(6);
    expect(result.appended.some((node) => node.templateNode?.key === 'guide')).toBe(false);
  });

  it('reuses the caller’s template nodes and inputs, appending and wiring only what is missing', () => {
    // 0 anchor, 1 the hero already wired in, 2 the pose on the sheet, 3 the
    // reused sheet, 4 the reused style resource.
    const known = { 0: 'final', 1: 'hero', 2: 'pose', 3: 'sheet', 4: 'style' };
    const result = expandTemplate(FIXTURE, {
      anchorAt: 0,
      base: 5,
      inputs: new Map([
        ['hero', new Map([['final', 1]])],
        ['pose', new Map([['sheet', 2]])],
      ]),
      wired: [
        { fromIndex: 1, toIndex: 0 },
        { fromIndex: 2, toIndex: 3 },
        { fromIndex: 4, toIndex: 3 },
        { fromIndex: 3, toIndex: 0 },
      ],
      reuse: new Map([
        ['sheet', 3],
        ['style', 4],
      ]),
      guide: false,
    });
    const who = identityIn(result, 5, known);
    expect(result.appended.map((_, i) => who(5 + i)).sort()).toEqual(['palette', 'place']);
    expect(edgesBy(result, who)).toEqual([
      { from: 'place', to: 'final', into: 'pool' },
      { from: 'palette', to: 'sheet', into: 'pool' },
      { from: 'palette', to: 'final', into: 'pool' },
    ]);
    expect(promptBy(result.rewritten.get(0), who)).toEqual([
      note('Drop the place first'),
      note('Drop a palette first'),
      { text: 'Light ' },
      { ref: 'hero' },
      { text: ' in ' },
      { ref: 'place' },
      { text: ' with ' },
      { ref: 'palette' },
      { text: '. ' },
      tweak('the mood'),
    ]);
    expect(promptBy(result.rewritten.get(3), who)).toEqual([
      note('Drop a palette first'),
      { text: 'Draw ' },
      { ref: 'pose' },
      { text: ' in ' },
      { ref: 'style' },
      { text: ' with ' },
      { ref: 'palette' },
      { text: '.' },
    ]);
  });

  it('uses an input’s node on one fed node for its other fed nodes when they were given none', () => {
    // 0 anchor, 1 the palette on the reused sheet, 2 the sheet, 3 the style.
    const known = { 0: 'final', 1: 'palette', 2: 'sheet', 3: 'style' };
    const result = expandTemplate(FIXTURE, {
      anchorAt: 0,
      base: 4,
      inputs: new Map([['palette', new Map([['sheet', 1]])]]),
      wired: [
        { fromIndex: 1, toIndex: 2 },
        { fromIndex: 3, toIndex: 2 },
        { fromIndex: 2, toIndex: 0 },
      ],
      reuse: new Map([
        ['sheet', 2],
        ['style', 3],
      ]),
      guide: false,
    });
    const who = identityIn(result, 4, known);
    expect(result.appended.map((_, i) => who(4 + i)).sort()).toEqual(['hero', 'place', 'pose']);
    expect(edgesBy(result, who)).toEqual([
      { from: 'pose', to: 'sheet', into: 'pool' },
      { from: 'hero', to: 'final', into: 'pool' },
      { from: 'place', to: 'final', into: 'pool' },
      { from: 'palette', to: 'final', into: 'pool' },
    ]);
    expect(promptBy(result.rewritten.get(0), who).filter((segment) => JSON.stringify(segment).includes('palette'))).toEqual([
      { ref: 'palette' },
    ]);
  });
});

describe('expandTemplate, round-1 review (inner#1345)', () => {
  it('notes an input whose node is already there but empty', () => {
    const result = expandTemplate(FIXTURE, {
      anchorAt: 0,
      base: 2,
      inputs: new Map([['hero', new Map([['final', 1]])]]),
      wired: [{ fromIndex: 1, toIndex: 0 }],
      reuse: new Map(),
      guide: false,
      emptyNodes: new Set([1]),
    });
    expect(result.rewritten.get(0)?.prompt).toContainEqual(note('Drop the hero first'));
  });

  it('rewrites a reused resource node with its storage path, so an empty one is fetched again', () => {
    const result = expandTemplate(FIXTURE, {
      anchorAt: 0,
      base: 3,
      inputs: new Map(),
      wired: [{ fromIndex: 2, toIndex: 1 }, { fromIndex: 1, toIndex: 0 }],
      reuse: new Map([['sheet', 1], ['style', 2]]),
      guide: false,
    });
    expect(result.rewritten.get(2)).toEqual({ role: 'source', type: 'image', name: 'house style', resource: `templates/${ID}/style.png` });
  });
});

// ── expandTemplate, property-based ───────────────────────────────────────

const TYPES: readonly GenerationNodeType[] = ['image', 'video', 'audio'];

/** The raw shape a random template is built from. */
interface TemplateDraw {
  upstream: Array<{ feeds: number; pool: boolean; type: number }>;
  resources: Array<{ to: number; pool: boolean; type: number }>;
  inputs: Array<{ feeds: number[] | undefined; type: number }>;
  steps: number;
}

/**
 * A template from a draw: generate nodes `g0` (the anchor) to `gN`, each
 * upstream one wired into an earlier one, resources `r*` wired into a
 * generate node, inputs `i*` feeding generate nodes.
 * @param draw - The draw.
 * @returns The template.
 */
function templateOf(draw: TemplateDraw): GenerationTemplate {
  const generate = ['g0', ...draw.upstream.map((_, i) => `g${String(i + 1)}`)];
  const pick = <T>(list: readonly T[], n: number): T => list[n % list.length] as T;
  return {
    id: 'random-flow',
    anchor: 'g0',
    nodes: [
      ...generate.map((key, i) => ({
        key,
        role: 'generate' as const,
        type: i === 0 ? ('image' as const) : pick(TYPES, draw.upstream[i - 1]?.type ?? 0),
        mode: 'm',
        model: 'model',
        params: {},
      })),
      ...draw.resources.map((resource, i) => ({
        key: `r${String(i)}`,
        role: 'source' as const,
        type: pick(TYPES, resource.type),
        resource: `templates/random-flow/r${String(i)}.png`,
      })),
    ],
    edges: [
      ...draw.upstream.map((up, i) => ({ from: `g${String(i + 1)}`, to: pick(generate.slice(0, i + 1), up.feeds), into: up.pool ? 'pool' : 'slot' })),
      ...draw.resources.map((resource, i) => ({ from: `r${String(i)}`, to: pick(generate, resource.to), into: resource.pool ? 'pool' : 'slot' })),
    ],
    inputs: draw.inputs.map((input, i) => ({
      key: `i${String(i)}`,
      type: pick(TYPES, input.type),
      ...(input.feeds === undefined ? {} : { feeds: [...new Set(input.feeds.map((n) => pick(generate, n)))] }),
    })),
    steps: Array.from({ length: draw.steps }, (_, i) => `s${String(i)}`),
    agentNote: 'random',
  };
}

/**
 * Strings for a random template: every generate node's prompt marks each of
 * its targets by name, names unique per template.
 * @param template - The template.
 * @returns The locale messages.
 */
function messagesOf(template: GenerationTemplate): Record<string, unknown> {
  const feedsOf = (input: GenerationTemplate['inputs'][number]): readonly string[] => input.feeds ?? [template.anchor];
  const promptFor = (key: string): string => {
    const targets = [
      ...template.inputs.filter((input) => feedsOf(input).includes(key)).map((input) => `in ${input.key}`),
      ...template.edges.filter((edge) => edge.to === key && edge.into === 'pool').map((edge) => `node ${edge.from}`),
    ];
    return `Make ${targets.map((name) => `[📎 ${name}]`).join(' and ')}.`;
  };
  const nodes = template.nodes.filter((node) => node.key !== template.anchor);
  return {
    canvas: {
      template: {
        [template.id]: {
          name: 'Random flow',
          prompt: promptFor(template.anchor),
          node: Object.fromEntries(
            nodes.map((node) => [node.key, node.role === 'generate' ? { name: `node ${node.key}`, prompt: promptFor(node.key) } : { name: `node ${node.key}` }]),
          ),
          input: Object.fromEntries(template.inputs.map((input) => [input.key, { name: `in ${input.key}`, note: `Put ${input.key} first` }])),
          step: Object.fromEntries(template.steps.map((step) => [step, `Do ${step}`])),
        },
      },
    },
  };
}

const drawArb: fc.Arbitrary<TemplateDraw> = fc.record({
  upstream: fc.array(fc.record({ feeds: fc.nat(), pool: fc.boolean(), type: fc.nat() }), { maxLength: 3 }),
  resources: fc.array(fc.record({ to: fc.nat(), pool: fc.boolean(), type: fc.nat() }), { maxLength: 2 }),
  inputs: fc.array(
    fc.record({ feeds: fc.option(fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), { nil: undefined }), type: fc.nat() }),
    { maxLength: 4 },
  ),
  steps: fc.nat({ max: 2 }),
});

describe('expandTemplate over random templates', () => {
  it('only refs and wires nodes that exist, with no repeated edge and no self-loop', () => {
    fc.assert(
      fc.property(drawArb, (draw) => {
        const template = templateOf(draw);
        setLocaleMessages('en', messagesOf(template));
        const result = expandTemplate(template, FRESH);
        const count = 1 + result.appended.length;
        const prompts = [...result.rewritten.values(), ...result.appended].flatMap((node) => node.prompt ?? []);
        for (const segment of prompts) {
          if (segment.ref !== undefined) expect(segment.ref).toBeLessThan(count);
        }
        const pairs = result.edges.map((edge) => `${String(edge.fromIndex)}>${String(edge.toIndex)}`);
        expect(new Set(pairs).size).toBe(pairs.length);
        for (const edge of result.edges) {
          expect(edge.fromIndex).toBeLessThan(count);
          expect(edge.toIndex).toBeLessThan(count);
          expect(edge.fromIndex).not.toBe(edge.toIndex);
        }
      }),
    );
  });

  it('builds by identity the same nodes and edges as the skeleton', () => {
    fc.assert(
      fc.property(drawArb, (draw) => {
        const template = templateOf(draw);
        setLocaleMessages('en', messagesOf(template));
        const skeleton = templateSkeleton(template);
        const result = expandTemplate(template, FRESH);
        const inputByName = new Map(template.inputs.map((input) => [`in ${input.key}`, input.key]));
        const who = (index: number): string => {
          if (index === 0) return skeleton.anchor;
          const node = result.appended[index - 1];
          if (node === undefined) return `<no node at ${String(index)}>`;
          return node.templateNode?.key ?? inputByName.get(node.name) ?? `<unknown ${node.name}>`;
        };
        const expectedNodes = [
          ...[...skeleton.nodes.keys()].filter((key) => key !== skeleton.anchor),
          ...skeleton.inputs.map((input) => input.key),
          ...(skeleton.steps.length > 0 ? [TEMPLATE_GUIDE_KEY] : []),
        ].sort();
        expect(result.appended.map((_, i) => who(1 + i)).sort()).toEqual(expectedNodes);
        expect(edgesBy(result, who)).toEqual([
          ...skeleton.edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.into === undefined ? {} : { into: edge.into }) })),
          ...skeleton.inputs.flatMap((input) => input.feeds.map((fed) => ({ from: input.key, to: fed, into: 'pool' }))),
        ]);
      }),
    );
  });
});
