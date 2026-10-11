// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a message tells the Agent about the reader's Spaces (inner#1413).
 *
 * Read in two steps. At the press, synchronously and from what this tab
 * already holds: the project's Spaces, and the open one's content when the
 * reader has it on. Nothing is created and nothing is asked for, so what goes
 * is the Space as it stood when send was pressed. Then, once the limits are
 * read from the server, cut to them -- only a length calculation.
 */

import type { QueryClient } from '@tanstack/react-query';
import { MAX_NODE_NAME_LEN, clipSpaceContent, spacesNewestFirst } from '@breatic/shared';
import type { ChatSpace, ChatSpaceContext, ClippedSpaceContent, ModelCatalog } from '@breatic/shared';

import { readEdges, readNodes } from '@web/data/yjs/canvas-space';
import { readDocFacts } from '@web/data/yjs/collab-socket';
import { docName, getDoc, hasDoc } from '@web/data/yjs/manager';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { snapshotOfPick } from '@web/spaces/canvas/attach-nodes';
import type { PickSnapshot } from '@web/spaces/canvas/attach-nodes';
import { pickReaders } from '@web/spaces/canvas/pick-for-agent';
import { spaceContentReadable } from '@web/pages/project/space-type';
import { peekDocumentEditor } from '@web/spaces/document/document-editor-cache';

/** The open Space as read at the press, before its content is cut. */
export type ReadCurrentSpace = ChatSpace &
  (
    | { state: 'loaded'; text: string }
    | { state: 'loaded'; canvas: PickSnapshot }
    | { state: 'loading' }
    | { state: 'unreadable' }
  );

/** The reader's Spaces as read at the press, before they are cut. */
export interface ReadSpaces {
  /** Every Space in the project, newest first. */
  spaces: ChatSpace[];
  /** The open Space, when one is open and the reader has it on. */
  current?: ReadCurrentSpace;
}

/** Where the read starts from. */
export interface SpaceContextSource {
  projectId: string;
  /** The Space whose tab is active, if any. */
  activeSpace: ProjectSpace | undefined;
  /** Every Space in the project. */
  spaces: readonly ProjectSpace[];
  /** Whether the reader has the open Space on. */
  enabled: boolean;
  /** Holds the model catalog and each model's first voice. */
  queryClient: QueryClient;
}

/** The limits the server reads, from `GET /chat/stream-config`. */
export interface SpaceContextLimits {
  currentSpaceMaxChars: number;
  spaceListMaxItems: number;
}

/**
 * A Space as the list names it.
 * @param space - The Space.
 * @returns Its id, name and kind.
 */
function listed(space: ProjectSpace): ChatSpace {
  return { id: space.id, name: space.name, kind: space.type };
}

/**
 * Whether this tab holds a document and has heard from the server about it.
 * Asked before anything reads it, so a closed Space gets no new document.
 * @param name - The document name.
 * @returns True when its content is the synced content.
 */
function holdsSynced(name: string): boolean {
  return hasDoc(name) && readDocFacts(name).hasEverSynced;
}

/**
 * An open canvas's nodes and the links between them.
 * @param source - Where the read starts from.
 * @param space - The canvas.
 * @returns The snapshot, an empty text when nothing on it can be handed over,
 *   or null while it or the model catalog has not loaded.
 */
function readCanvas(source: SpaceContextSource, space: ProjectSpace): PickSnapshot | '' | null {
  const name = docName.canvasSpace(source.projectId, space.id);
  if (!holdsSynced(name)) return null;
  const catalog = source.queryClient.getQueryData<ModelCatalog>(modelCatalogQuery().queryKey);
  if (catalog === undefined) return null;
  const doc = getDoc(name);
  const nodes = readNodes(doc);
  // A first voice that is not cached is left out: nothing is asked for here.
  const snapshot = snapshotOfPick(
    { nodes, edges: readEdges(doc) },
    nodes.map((n) => n.id),
    pickReaders(source.queryClient, catalog, doc),
  );
  return snapshot ?? '';
}

/** An address: a scheme, `://`, and no whitespace. */
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** One printable ASCII word: an id, a model name, a voice, a mime type. */
const NAME = /^[\x21-\x7e]*$/;

/**
 * How long a name a node holds can be. The longest today is an Office mime
 * type (73 characters); ids are 36, model names at most 40, voice ids 47.
 */
const NAME_MAX_LENGTH = 128;

/**
 * Whether a string only means something whole -- an address or a name -- so
 * cutting it would leave a reference to nothing. Anything longer is what the
 * reader wrote, whatever its shape, and its start still says something.
 * @param value - The string.
 * @returns True when it must go whole.
 */
function isReference(value: string): boolean {
  return ADDRESS.test(value) || (value.length <= NAME_MAX_LENGTH && NAME.test(value));
}

/**
 * A value with every piece of prose in it longer than `keep` characters cut
 * to its start, ending with an ellipsis. A string one character over is left
 * whole: the ellipsis would take that character's place.
 * @param value - The value.
 * @param keep - How many characters prose keeps.
 * @returns The cut value.
 */
function cutTexts(value: unknown, keep: number): unknown {
  if (typeof value === 'string') {
    return value.length > keep + 1 && !isReference(value)
      ? `${clipSpaceContent(value, keep).text}\u2026`
      : value;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => cutTexts(v, keep));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutTexts(v, keep)]));
  }
  return value;
}

/**
 * A canvas with the prose in its nodes cut to `keep` characters.
 * @param canvas - The canvas.
 * @param keep - How many characters prose keeps.
 * @returns The cut canvas.
 */
function cutCanvas(canvas: PickSnapshot, keep: number): PickSnapshot {
  return {
    edges: canvas.edges,
    nodes: canvas.nodes.map((node) => cutTexts(node, keep) as PickSnapshot['nodes'][number]),
  };
}

/**
 * A canvas as compact JSON holding the given nodes and the links between them.
 * @param canvas - The canvas.
 * @param kept - The nodes' ids.
 * @returns The compact JSON.
 */
function canvasText(canvas: PickSnapshot, kept: ReadonlySet<string>): string {
  return JSON.stringify({
    edges: canvas.edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
    nodes: canvas.nodes.filter((n) => kept.has(n.id)),
  });
}

/**
 * A canvas as compact JSON within `max` characters, holding every node it
 * can whole: when it is too long, every piece of prose longer than `keep` is
 * cut to the same length, the longest that lets every node and link go.
 * Prose no longer than a node's name is never cut; when the canvas is still too long
 * at that, the nodes are walked in order, each kept while it fits with the
 * links it closes and skipped when it does not -- the order is the
 * document's, not one the reader chose, so one node does not push out the
 * rest.
 * @param canvas - The canvas.
 * @param max - How many characters may go.
 * @returns The text and the length of the whole canvas's text.
 */
function fitCanvas(canvas: PickSnapshot, max: number): ClippedSpaceContent {
  const all = new Set(canvas.nodes.map((n) => n.id));
  const whole = canvasText(canvas, all);
  if (whole.length <= max) return { text: whole, total: whole.length };
  const total = whole.length;
  // Cutting prose shorter never makes the canvas longer, so the longest
  // cut that fits can be searched for.
  let fits = MAX_NODE_NAME_LEN;
  let over = total;
  const atFloor = cutCanvas(canvas, fits);
  const shortest = canvasText(atFloor, all);
  if (shortest.length > max) return { text: packNodes(atFloor, max), total };
  let text = shortest;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    const tried = canvasText(cutCanvas(canvas, mid), all);
    if (tried.length <= max) {
      fits = mid;
      text = tried;
    } else {
      over = mid;
    }
  }
  return { text, total };
}

/**
 * A canvas as compact JSON holding every node that fits in `max`
 * characters, taken in order, with only the links whose two ends are among
 * them.
 * @param canvas - The canvas.
 * @param max - How many characters may go.
 * @returns The compact JSON.
 */
function packNodes(canvas: PickSnapshot, max: number): string {
  const linksAt = new Map<string, PickSnapshot['edges']>();
  for (const edge of canvas.edges) {
    for (const end of edge.source === edge.target ? [edge.source] : [edge.source, edge.target]) {
      const links = linksAt.get(end) ?? [];
      links.push(edge);
      linksAt.set(end, links);
    }
  }
  const kept = new Set<string>();
  let length = canvasText(canvas, kept).length;
  let edgeCount = 0;
  for (const node of canvas.nodes) {
    // The links this node closes: to itself, or to a node already kept.
    const links = (linksAt.get(node.id) ?? []).filter((e) => {
      const other = e.source === node.id ? e.target : e.source;
      return other === node.id || kept.has(other);
    });
    // Each entry after an array's first adds a comma.
    const grows =
      JSON.stringify(node).length +
      (kept.size > 0 ? 1 : 0) +
      links.reduce((sum, e, i) => sum + JSON.stringify(e).length + (edgeCount + i > 0 ? 1 : 0), 0);
    if (length + grows > max) continue;
    kept.add(node.id);
    length += grows;
    edgeCount += links.length;
  }
  return canvasText(canvas, kept);
}

/**
 * An open document's text, as Markdown.
 * @param source - Where the read starts from.
 * @param space - The document.
 * @returns Its text, empty when it holds only whitespace, or null while it
 *   has not loaded or has no editor yet.
 */
function documentText(source: SpaceContextSource, space: ProjectSpace): string | null {
  const name = docName.documentSpace(source.projectId, space.id);
  if (!holdsSynced(name)) return null;
  const handle = peekDocumentEditor(name);
  if (handle === undefined) return null;
  const markdown = handle.editor.blocksToMarkdownLossy(handle.editor.document);
  return markdown.trim() === '' ? '' : markdown.trimEnd();
}

/**
 * The open Space as the message carries it.
 * @param source - Where the read starts from.
 * @param space - The open Space.
 * @returns What it holds, or why it holds nothing to read.
 */
function readCurrent(source: SpaceContextSource, space: ProjectSpace): ReadCurrentSpace {
  const base = listed(space);
  if (!spaceContentReadable(space.type)) return { ...base, state: 'unreadable' };
  if (space.type === 'canvas') {
    const canvas = readCanvas(source, space);
    if (canvas === null) return { ...base, state: 'loading' };
    return canvas === '' ? { ...base, state: 'loaded', text: '' } : { ...base, state: 'loaded', canvas };
  }
  const text = documentText(source, space);
  return text === null ? { ...base, state: 'loading' } : { ...base, state: 'loaded', text };
}

/**
 * The reader's Spaces as they stand at the press. Synchronous, and reads only
 * what this tab holds.
 * @param source - Where the read starts from.
 * @returns The Spaces, and the open one when it goes.
 */
export function readSpaceContext(source: SpaceContextSource): ReadSpaces {
  const spaces = spacesNewestFirst(source.spaces).map(listed);
  const open = source.enabled ? source.activeSpace : undefined;
  return open === undefined ? { spaces } : { spaces, current: readCurrent(source, open) };
}

/**
 * The read Spaces cut to the limits the server reads: the newest Spaces up to
 * the list's limit, and the start of the open Space's content up to its own.
 * @param read - What was read at the press.
 * @param limits - The limits.
 * @returns What goes beside the message.
 */
export function clipSpaceContext(read: ReadSpaces, limits: SpaceContextLimits): ChatSpaceContext {
  const out: ChatSpaceContext = {
    spaces: read.spaces.slice(0, limits.spaceListMaxItems),
    spaces_total: read.spaces.length,
  };
  const current = read.current;
  if (current === undefined) return out;
  if (current.state !== 'loaded') return { ...out, current_space: current };
  const { id, name, kind } = current;
  const clipped =
    'canvas' in current
      ? fitCanvas(current.canvas, limits.currentSpaceMaxChars)
      : clipSpaceContent(current.text, limits.currentSpaceMaxChars);
  return {
    ...out,
    current_space: { id, name, kind, state: 'loaded', content: clipped.text, total_chars: clipped.total },
  };
}
