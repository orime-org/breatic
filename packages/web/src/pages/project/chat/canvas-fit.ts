// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fitting an open canvas into the limit by level of detail (inner#1413).
 *
 * Every node goes whole, as Add to Agent hands it over. While the canvas is
 * too long, the steps below are taken in turn, each until the canvas fits:
 * nodes go slim, their texts are cut, nodes go by name only, links are left
 * out, nodes are left out. Within every step the unselected nodes go first,
 * with the selected ones an attachment of the message holds unchanged, and
 * the other selected ones only once those are done; nodes go earliest first. A node is left out only when even names do not fit.
 *
 * The length is kept as sums of each entry's length, so a step that changes
 * one entry costs that entry, and the whole canvas is written out once.
 */

import type { ChatCanvasDetail, ParamDescriptor } from '@breatic/shared';

import type { CanvasEdge } from '@web/data/yjs/canvas-space';
import { fitPartsOf } from '@web/pages/project/chat/canvas-fields';
import type { FitParts } from '@web/pages/project/chat/canvas-fields';

/** A node as the fit sees it. */
export interface FitNode extends FitParts {
  id: string;
  /** When it was made; with its id, the order nodes are reduced in. */
  createdAt: number;
  group: boolean;
  /** Whether the reader has it selected on screen; its entry says so. */
  selected: boolean;
  /** Whether it is reduced last at every step: selected, and not held unchanged by an attachment. */
  last: boolean;
  /** The node as Add to Agent hands it over. */
  whole: Record<string, unknown>;
}

/** The canvas to fit. */
export interface FitInput {
  nodes: readonly FitNode[];
  edges: readonly CanvasEdge[];
}

/** What goes, how long the whole canvas was, and what was done. */
export interface FittedCanvas {
  text: string;
  total: number;
  detail: ChatCanvasDetail;
}

/**
 * A node as the fit sees it.
 * @param entry - The node as a snapshot hands it over.
 * @param descriptors - The run settings of the model it would run, when known.
 * @param selected - Whether the reader has it selected.
 * @returns The node.
 */
export function fitNodeOf(
  entry: Record<string, unknown> & { id: string },
  descriptors: Readonly<Record<string, ParamDescriptor>> | undefined,
  selected: boolean,
): FitNode {
  const data = entry.data !== null && typeof entry.data === 'object' ? (entry.data as Record<string, unknown>) : {};
  return {
    ...fitPartsOf(entry, descriptors),
    id: entry.id,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
    group: entry.type === 'group',
    selected,
    last: selected,
    whole: entry,
  };
}

/**
 * A text cut to its first `keep` UTF-16 code units, never between the two
 * halves of a character, ending with how many were left out. Left whole when
 * the cut would be no shorter.
 * @param text - The text.
 * @param keep - How many code units it keeps.
 * @returns The text as it goes.
 */
export function cutText(text: string, keep: number): string {
  if (keep >= text.length) return text;
  const end = cutEnd(text, keep);
  const cut = `${text.slice(0, end)}…[+${String(text.length - end)}]`;
  return cut.length < text.length ? cut : text;
}

/**
 * Where a text is cut to keep at most `keep` UTF-16 code units: one fewer
 * when the cut would fall between the two halves of a character, since some
 * model providers refuse a request carrying half of one.
 * @param text - The text.
 * @param keep - How many code units may stay.
 * @returns The index to cut at.
 */
export function cutEnd(text: string, keep: number): number {
  const last = keep > 0 ? text.charCodeAt(keep - 1) : 0;
  return last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep;
}

/**
 * How long a string is once written as JSON.
 * @param text - The string.
 * @returns Its length with quotes and escapes.
 */
const jsonLength = (text: string): number => JSON.stringify(text).length;

/**
 * A slim entry with its texts cut.
 * @param node - The node.
 * @param keep - How many code units each text keeps.
 * @returns The entry.
 */
function cutSlim(node: FitNode, keep: number): Record<string, unknown> {
  if (node.texts.length === 0) return node.slim;
  const out = structuredClone(node.slim);
  for (const { path, text } of node.texts) {
    let at: Record<string | number, unknown> = out;
    for (const step of path.slice(0, -1)) at = at[step] as Record<string | number, unknown>;
    at[path[path.length - 1] ?? ''] = cutText(text, keep);
  }
  return out;
}

/** Whole, slim, by name, left out. */
type Level = 0 | 1 | 2 | 3;

/** What a selected node's entry ends with: `,"selected":true`. */
const MARK_LENGTH = ',"selected":true'.length;

/** The nodes that go first, then the selected ones no attachment holds unchanged. */
type Tier = 'unselected' | 'selected';
const TIERS: readonly Tier[] = ['unselected', 'selected'];

/**
 * Which node comes first: the earlier made, then the lower id.
 * @param a - One node.
 * @param b - The other.
 * @returns Negative when `a` comes first.
 */
function before(a: FitNode, b: FitNode): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * One canvas being fitted. The length is kept as the sums of each entry's
 * length, so a step that changes one entry costs only that entry.
 */
class Fitting {
  private readonly nodes: readonly FitNode[];
  private readonly edges: readonly CanvasEdge[];
  private readonly max: number;
  private readonly index: Map<string, number>;
  private readonly level: Level[];
  private readonly keep: Record<Tier, number> = { unselected: Infinity, selected: Infinity };
  private readonly edgeGone: boolean[];
  private readonly slimLength: number[];
  private readonly textLength: number[][];
  private readonly incident: number[][];
  private readonly nodeLen: number[];
  private readonly edgeLen: number[];
  private readonly sum = { nodes: 0, edges: 0 };
  private readonly count = { nodes: 0, edges: 0 };

  /**
   * Start with every node and link whole.
   * @param input - The canvas.
   * @param max - How many characters may go.
   */
  constructor(input: FitInput, max: number) {
    this.nodes = input.nodes;
    this.edges = input.edges;
    this.max = max;
    this.index = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.level = this.nodes.map(() => 0);
    this.edgeGone = this.edges.map(() => false);
    this.slimLength = this.nodes.map((n) => JSON.stringify(n.slim).length);
    this.textLength = this.nodes.map((n) => n.texts.map((t) => jsonLength(t.text)));
    this.incident = this.nodes.map(() => []);
    this.edges.forEach((e, j) => {
      for (const end of new Set([e.source, e.target])) this.incident[this.index.get(end) ?? -1]?.push(j);
    });
    this.nodeLen = this.nodes.map((_, i) => this.nodeLength(i));
    this.edgeLen = this.edges.map((_, j) => this.edgeLength(j));
    this.sum.nodes = this.nodeLen.reduce((a, b) => a + b, 0);
    this.sum.edges = this.edgeLen.reduce((a, b) => a + b, 0);
    this.count.nodes = this.nodes.length;
    this.count.edges = this.edges.length;
  }

  /**
   * How long the canvas is now: `{"edges":[` + `],"nodes":[` + `]}` is 23,
   * and each entry after an array's first adds a comma.
   * @returns The length.
   */
  length(): number {
    return 23 + this.sum.edges + Math.max(0, this.count.edges - 1) + this.sum.nodes + Math.max(0, this.count.nodes - 1);
  }

  /**
   * Whether the canvas fits now.
   * @returns True within the limit.
   */
  fits(): boolean {
    return this.length() <= this.max;
  }

  /**
   * Take the steps in turn until the canvas fits, then let the texts still
   * sent keep as much as now fits, the selected ones first: a later step may
   * have freed room.
   */
  fit(): void {
    if (this.fits()) return;
    this.takeSteps();
    for (const tier of [...TIERS].reverse()) if (this.keep[tier] !== Infinity) this.longestCut(tier);
  }

  /**
   * The canvas as it goes.
   * @returns Compact JSON.
   */
  text(): string {
    return JSON.stringify({
      edges: this.edges.flatMap((_, j) => (this.edgeListed(j) ? [this.edgeForm(j)] : [])),
      nodes: this.nodes.flatMap((n, i) => (this.level[i] === 3 ? [] : [this.render(n, i)])),
    });
  }

  /**
   * What was done, counted in what goes.
   * @returns The detail.
   */
  detail(): ChatCanvasDetail {
    /**
     * How many nodes pass a test.
     * @param pick - The test, given a node and its level.
     * @returns The count.
     */
    const counted = (pick: (n: FitNode, at: Level) => boolean): number =>
      this.nodes.filter((n, i) => pick(n, this.level[i] ?? 0)).length;
    return {
      selected_total: counted((n) => n.selected),
      selected_attached: counted((n) => n.selected && !n.last),
      selected_whole: counted((n, at) => n.last && at === 0),
      // A group's slim entry is its name only, so a group short of left out went slim.
      slim: this.nodes.some((n, i) => this.level[i] === 1 || (n.group && this.level[i] === 2)),
      texts_cut: this.nodes.reduce((sum, n, i) => (this.level[i] === 1 ? sum + this.cutCount(n) : sum), 0),
      names_only: counted((n, at) => !n.group && at === 2),
      edges_not_listed: this.edges.length - this.count.edges,
      nodes_not_listed: counted((n, at) => !n.group && at === 3),
      groups_not_listed: counted((n, at) => n.group && at === 3),
    };
  }

  /** Slim, cut texts, name only, leave links out, leave nodes out; each until the canvas fits. */
  private takeSteps(): void {
    if (this.walkNodes(1)) return;
    for (const tier of TIERS) if (this.longestCut(tier)) return;
    if (this.walkNodes(2)) return;
    for (const tier of TIERS) {
      for (const j of this.edgesInOrder(tier)) {
        if (this.fits()) return;
        this.dropEdge(j);
      }
    }
    this.walkNodes(3);
  }

  /**
   * Bring nodes down to a level one by one, unselected first, each tier
   * earliest first, until the canvas fits.
   * @param to - The level.
   * @returns Whether the canvas fits.
   */
  private walkNodes(to: Level): boolean {
    for (const tier of TIERS) {
      for (const i of this.inOrder(tier)) {
        if (this.fits()) return true;
        this.reduce(i, to);
      }
    }
    return this.fits();
  }

  /**
   * A tier's nodes, earliest first.
   * @param tier - The tier.
   * @returns Their indexes.
   */
  private inOrder(tier: Tier): number[] {
    return this.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => this.tierOf(n) === tier)
      .sort((x, y) => before(x.n, y.n))
      .map(({ i }) => i);
  }

  /**
   * A tier's links, by their earlier end. A link touching a node of the selected
   * tier is in that tier.
   * @param tier - The tier.
   * @returns Their indexes.
   */
  private edgesInOrder(tier: Tier): number[] {
    /**
     * A link's earlier end.
     * @param e - The link.
     * @returns That node.
     */
    const earlier = (e: CanvasEdge): FitNode | undefined => {
      const a = this.nodes[this.index.get(e.source) ?? -1];
      const b = this.nodes[this.index.get(e.target) ?? -1];
      return a && b ? (before(a, b) <= 0 ? a : b) : (a ?? b);
    };
    return this.edges
      .map((e, j) => ({ e, j, first: earlier(e) }))
      .filter(({ e }) => {
        const touches = [e.source, e.target].some((id) => this.nodes[this.index.get(id) ?? -1]?.last === true);
        return (tier === 'selected') === touches;
      })
      .sort((x, y) => (x.first && y.first ? before(x.first, y.first) : 0))
      .map(({ j }) => j);
  }

  /**
   * Which tier a node is in.
   * @param n - The node.
   * @returns Its tier.
   */
  private tierOf(n: FitNode): Tier {
    return n.last ? 'selected' : 'unselected';
  }

  /**
   * How many of a slim node's texts its tier's cut shortens.
   * @param n - The node.
   * @returns The count.
   */
  private cutCount(n: FitNode): number {
    const keep = this.keep[this.tierOf(n)];
    return n.texts.filter((t) => cutText(t.text, keep) !== t.text).length;
  }

  /**
   * How long a node's slim entry is with its texts cut, from the length of
   * each text as written in JSON.
   * @param i - The node.
   * @param keep - How many code units each text keeps.
   * @returns The length.
   */
  private cutLength(i: number, keep: number): number {
    const base = this.slimLength[i] ?? 0;
    const node = this.nodes[i];
    if (node === undefined || keep === Infinity) return base;
    return node.texts.reduce((sum, t, x) => sum - (this.textLength[i]?.[x] ?? 0) + jsonLength(cutText(t.text, keep)), base);
  }

  /**
   * How long a node is at its level.
   * @param i - The node.
   * @returns The length.
   */
  private nodeLength(i: number): number {
    const node = this.nodes[i];
    if (node === undefined) return 0;
    const at = this.level[i];
    const mark = node.selected ? MARK_LENGTH : 0;
    if (at === 0) return JSON.stringify(node.whole).length + mark;
    if (at === 1) return this.cutLength(i, this.keep[this.tierOf(node)]) + mark;
    return JSON.stringify(node.named).length + mark;
  }

  /**
   * A node as it goes.
   * @param n - The node.
   * @param i - Its index.
   * @returns Its entry.
   */
  private render(n: FitNode, i: number): Record<string, unknown> {
    const at = this.level[i];
    const keep = this.keep[this.tierOf(n)];
    const entry = at === 0 ? n.whole : at === 1 ? (keep === Infinity ? n.slim : cutSlim(n, keep)) : n.named;
    return n.selected ? { ...entry, selected: true } : entry;
  }

  /**
   * Whether a link goes: not left out, and both its ends go.
   * @param j - The link.
   * @returns True when it goes.
   */
  private edgeListed(j: number): boolean {
    const e = this.edges[j];
    if (e === undefined || this.edgeGone[j]) return false;
    return (this.level[this.index.get(e.source) ?? -1] ?? 3) < 3 && (this.level[this.index.get(e.target) ?? -1] ?? 3) < 3;
  }

  /**
   * A link as it goes: whole while both its ends go whole.
   * @param j - The link.
   * @returns Its entry.
   */
  private edgeForm(j: number): unknown {
    const e = this.edges[j];
    if (e === undefined) return null;
    const whole = this.level[this.index.get(e.source) ?? -1] === 0 && this.level[this.index.get(e.target) ?? -1] === 0;
    return whole ? e : { source: e.source, target: e.target };
  }

  /**
   * How long a link is as it goes.
   * @param j - The link.
   * @returns The length.
   */
  private edgeLength(j: number): number {
    return JSON.stringify(this.edgeForm(j)).length;
  }

  /**
   * Leave a link out.
   * @param j - The link.
   */
  private dropEdge(j: number): void {
    if (!this.edgeListed(j)) return;
    this.sum.edges -= this.edgeLen[j] ?? 0;
    this.count.edges -= 1;
    this.edgeGone[j] = true;
  }

  /**
   * Send a node at a smaller size. A node leaving whole turns its links
   * slim; a node left out takes its links with it.
   * @param i - The node.
   * @param to - Its new level.
   */
  private reduce(i: number, to: Level): void {
    const from = this.level[i];
    if (to === 3) {
      for (const j of this.incident[i] ?? []) this.dropEdge(j);
      this.sum.nodes -= this.nodeLen[i] ?? 0;
      this.count.nodes -= 1;
      this.level[i] = 3;
      return;
    }
    this.level[i] = to;
    this.resize(i);
    if (from !== 0) return;
    for (const j of this.incident[i] ?? []) {
      if (!this.edgeListed(j)) continue;
      const len = this.edgeLength(j);
      this.sum.edges += len - (this.edgeLen[j] ?? 0);
      this.edgeLen[j] = len;
    }
  }

  /**
   * Remeasure a node after its level or cut changed.
   * @param i - The node.
   */
  private resize(i: number): void {
    const next = this.nodeLength(i);
    this.sum.nodes += next - (this.nodeLen[i] ?? 0);
    this.nodeLen[i] = next;
  }

  /**
   * Set how much a tier's texts keep.
   * @param tier - The tier.
   * @param keep - How many code units each text keeps.
   */
  private setKeep(tier: Tier, keep: number): void {
    this.keep[tier] = keep;
    this.nodes.forEach((n, i) => {
      if (this.level[i] === 1 && this.tierOf(n) === tier) this.resize(i);
    });
  }

  /**
   * Cut a tier's texts to the longest length that fits; to nothing when none does.
   * @param tier - The tier.
   * @returns Whether the canvas fits.
   */
  private longestCut(tier: Tier): boolean {
    const lengths = this.nodes.flatMap((n, i) => (this.tierOf(n) === tier && this.level[i] === 1 ? n.texts.map((t) => t.text.length) : []));
    const longest = Math.max(0, ...lengths);
    this.setKeep(tier, longest);
    if (this.fits()) return true;
    this.setKeep(tier, 0);
    if (!this.fits()) return false;
    // A longer keep never makes the canvas shorter.
    let low = 0;
    let high = longest;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      this.setKeep(tier, mid);
      if (this.fits()) low = mid;
      else high = mid;
    }
    this.setKeep(tier, low);
    return true;
  }
}

/**
 * Fit a canvas into `max` characters.
 * @param input - The canvas.
 * @param max - How many characters may go.
 * @returns What goes, the whole canvas's length and what was done.
 */
export function fitCanvas(input: FitInput, max: number): FittedCanvas {
  const fitting = new Fitting(input, max);
  const total = fitting.length();
  fitting.fit();
  return { text: fitting.text(), total, detail: fitting.detail() };
}
